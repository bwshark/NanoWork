/**
 * 自包含性能报告 `resources/perf-report.html`（FR-11.6 / FR-11.7）。
 *
 * 两条判据，缺一不可：
 *
 * 1. **断网可渲染** —— 页面不得引用任何外部资源。这不是洁癖：报告是要被用户
 *    直接打开（甚至发给别人）的单文件，一旦依赖 CDN，断网或内网环境下它就是一片空白，
 *    而「空白」会被理解成「没有数据」。
 * 2. **真的能算出东西** —— 用 jsdom 把页面跑起来，喂两份真实形状的 JSONL，
 *    断言渲染出的数字。只做静态检查（「文件里有 renderLatency 这个函数」）
 *    证明不了它算得对，也拦不住「函数在、但没被调用」。
 *
 * ⚠️ 首字延迟的分母必须只算**量到首字**的样本。把 `ttftMs: null` 的记录按 0 计入，
 * 平均值会变成一个偏快的假数字 —— 用例里专门放了一条 null 样本钉这条。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const REPORT_PATH = join(process.cwd(), 'resources', 'perf-report.html');
const html = readFileSync(REPORT_PATH, 'utf8');

/** 轮询等待渲染完成（FileReader 是异步的） */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待渲染超时');
}

type Window = JSDOM['window'];

/** 把一份 NDJSON 文本当作「用户选中的文件」喂进页面 */
async function loadDocument(dom: JSDOM, files: Array<{ name: string; text: string }>) {
  const win = dom.window as Window;
  const picker = win.document.getElementById('picker') as HTMLInputElement;
  const list = files.map((f) => new win.File([f.text], f.name, { type: 'text/plain' }));
  // jsdom 里 `files` 是只读的，只能这样替换（真实浏览器由用户选择写入）
  Object.defineProperty(picker, 'files', { value: list, configurable: true });
  picker.dispatchEvent(new win.Event('change'));
  await waitFor(
    () =>
      !win.document.getElementById('startup')?.classList.contains('hidden') ||
      !win.document.getElementById('latency')?.classList.contains('hidden'),
  );
}

function boot(): JSDOM {
  return new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
}

describe('perf-report.html：断网自包含', () => {
  it('不引用任何外部资源（无 CDN / 无外链脚本样式 / 无远程字体）', () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(html).not.toMatch(/\bfetch\s*\(/);
  });

  it('空态自带操作指引（说了开关名与文件位置）', () => {
    expect(html).toContain('NANOWORK_STARTUP_PROFILE=1');
    expect(html).toContain('startup-profile.jsonl');
    expect(html).toContain('session-latency.jsonl');
  });
});

describe('perf-report.html：渲染启动分段', () => {
  const startup = JSON.stringify({
    pid: 123,
    startedAtMs: 1000,
    endedAtMs: 11000,
    durationMs: 10000,
    unionMs: 9600,
    spans: [
      { name: 'app.load→ready', startedAtMs: 1000, endedAtMs: 1400 },
      { name: 'serve.spawn→listen', startedAtMs: 1500, endedAtMs: 10900 },
      { name: 'gateway.spawn→listen', startedAtMs: 1600, endedAtMs: 2900 },
    ],
    extras: { version: '1.6.0', platform: 'win32' },
  });

  it('展示墙钟 / 并集 / 分段数 / 版本，并逐段列出耗时', async () => {
    const dom = boot();
    await loadDocument(dom, [{ name: 'startup-profile.jsonl', text: startup }]);
    const doc = dom.window.document;

    const cards = doc.getElementById('startupCards')?.textContent ?? '';
    expect(cards).toContain('10 s'); // 墙钟
    expect(cards).toContain('9.6 s'); // 区间并集
    expect(cards).toContain('1.6.0');

    const rows = doc.querySelectorAll('#startupBars table tr');
    // 1 行表头 + 3 段
    expect(rows).toHaveLength(4);
    expect(rows[2].textContent).toContain('serve.spawn→listen');
  });

  it('把「各段相加」与「去重后」一起说出来（差额来自并行阶段）', async () => {
    const dom = boot();
    await loadDocument(dom, [{ name: 'startup-profile.jsonl', text: startup }]);
    const note = dom.window.document.getElementById('startupNote')?.textContent ?? '';
    expect(note).toContain('11.1 s'); // 400 + 9400 + 1300
    expect(note).toContain('9.6 s');
    expect(note).toContain('并行');
  });
});

describe('perf-report.html：渲染首字延迟', () => {
  const latency = [
    { at: 1000, startedAtMs: 900, firstByteAtMs: 950, firstTokenAtMs: 1250, ttftMs: 300, firstTokenLatencyMs: 350 },
    { at: 2000, startedAtMs: 1900, firstByteAtMs: 1950, firstTokenAtMs: 3950, ttftMs: 2000, firstTokenLatencyMs: 2050 },
    // 没等到首字的样本：ttftMs 为 null，**不得**按 0 计入平均值
    { at: 3000, startedAtMs: 2900, firstByteAtMs: null, firstTokenAtMs: null, ttftMs: null, firstTokenLatencyMs: null },
  ]
    .map((row) => JSON.stringify(row))
    .join('\n');

  it('分母只算量到首字的样本，null 样本不进平均', async () => {
    const dom = boot();
    await loadDocument(dom, [{ name: 'session-latency.jsonl', text: latency }]);
    const cards = dom.window.document.getElementById('latencyCards')?.textContent ?? '';
    expect(cards).toContain('3'); // 样本数
    expect(cards).toContain('2'); // 量到首字
    // p50 取 [300, 2000] 的下中位 = 300；若把 null 当 0 参与，这里会变成 0 ms
    expect(cards).toContain('300 ms');
    expect(cards).toContain('2 s'); // p90 = 2000ms
  });

  it('用户侧等待单独算（响应头 → 首字），与首字节→首字区分开', async () => {
    const dom = boot();
    await loadDocument(dom, [{ name: 'latency.jsonl', text: latency }]);
    const text = dom.window.document.getElementById('latencyBars')?.textContent ?? '';
    expect(text).toContain('用户侧等待');
    expect(text).toContain('350 ms');
    expect(text).toContain('2.1 s');
  });

  it('p90 未超 3 秒时明确给出结论（对照「首字延迟 ≤ 3s」这条需求）', async () => {
    const dom = boot();
    await loadDocument(dom, [{ name: 'latency.jsonl', text: latency }]);
    expect(dom.window.document.getElementById('latencyNote')?.textContent).toContain('3 秒以内');
  });

  it('p90 超过 3 秒时给出警示', async () => {
    const slow = [
      { at: 1, ttftMs: 4200, firstTokenLatencyMs: 4300 },
      { at: 2, ttftMs: 5100, firstTokenLatencyMs: 5200 },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');
    const dom = boot();
    await loadDocument(dom, [{ name: 'latency.jsonl', text: slow }]);
    expect(dom.window.document.getElementById('latencyNote')?.textContent).toContain('超过 3 秒');
  });
});

describe('perf-report.html：自动识别与容错', () => {
  it('两份文件一起喂（文件名随便取）也能各自落到对应区块', async () => {
    const dom = boot();
    await loadDocument(dom, [
      { name: 'a.txt', text: JSON.stringify({ pid: 1, durationMs: 500, unionMs: 500, spans: [], extras: {} }) },
      { name: 'b.txt', text: JSON.stringify({ at: 5, ttftMs: 120, firstTokenLatencyMs: 180 }) },
    ]);
    const doc = dom.window.document;
    expect(doc.getElementById('startup')?.classList.contains('hidden')).toBe(false);
    expect(doc.getElementById('latency')?.classList.contains('hidden')).toBe(false);
  });

  it('半截行（应用正在写）跳过，不因一行坏数据丢整份', async () => {
    const dom = boot();
    await loadDocument(dom, [
      {
        name: 'latency.jsonl',
        text:
          JSON.stringify({ at: 5, ttftMs: 120, firstTokenLatencyMs: 180 }) +
          '\n{"at":6,"ttftMs":9',
      },
    ]);
    const cards = dom.window.document.getElementById('latencyCards')?.textContent ?? '';
    expect(cards).toContain('1'); // 有效样本只有 1 条
  });

  it('完全认不出的文件会说话，而不是静默什么都不发生', async () => {
    const dom = boot();
    const win = dom.window as Window;
    const picker = win.document.getElementById('picker') as HTMLInputElement;
    Object.defineProperty(picker, 'files', {
      value: [new win.File(['hello world'], 'x.txt', { type: 'text/plain' })],
      configurable: true,
    });
    picker.dispatchEvent(new win.Event('change'));
    // ⚠️ 判据必须落在「文件名」而不是「认不出」三个字上：`body.textContent` **包含
    // inline `<script>` 的源码**，而那段源码的注释里就写着「认不出来要说话」——
    // 拿它当判据会立刻通过，页面还什么都没渲染，用例变成恒真。
    await waitFor(() => (win.document.body.textContent ?? '').includes('x.txt'));
    expect(win.document.body.textContent).toContain('认不出「x.txt」');
  });
});
