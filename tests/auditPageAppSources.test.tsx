/**
 * 审计页「应用操作」档：**必须同时展示本机与引擎两个来源**（FR-8.9）。
 *
 * 这条判据的意义在于它拦得住的最坏改法：把引擎那份忘了读。
 * 忘了读不会报错、页面照常显示——只是表里永远只有「人点的按钮」，
 * 而 Dream 采纳 / 配置热加载 / 任务库重载这些**真正改了文件**的动作静默消失。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { AuditPage } from '@/pages/audit/AuditPage';
import { buttonByText, click, flush, mount, unmount } from './helpers/reactMount';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOOL_LOG = [
  '{"timestamp":"2026-10-23T01:00:00+00:00","tool":"write_file","tier":"allow","outcome":"executed","approved_by":"read_only","args_digest":"abc","args":{"path":"a.txt"}}',
].join('\n');

const LOCAL_APP_LOG = [
  '{"ts":"2026-10-23T02:00:00.000Z","action":"agent.create","outcome":"ok","actor":"local","targetLabel":"写作专家"}',
].join('\n');

const ENGINE_APP_LOG = [
  '{"ts":"2026-10-23T03:00:00.000+00:00","action":"dream.accept","outcome":"ok","actor":"engine","targetId":"dream-candidate","detail":{"updated":2}}',
].join('\n');

beforeEach(() => {
  vi.spyOn(platform, 'auditRead').mockResolvedValue({
    path: 'C:/data/audit/tool-gateway.ndjson',
    exists: true,
    content: TOOL_LOG,
  });
  vi.spyOn(platform, 'auditReadApp').mockResolvedValue({
    path: 'C:/userData/audit/app-operations.ndjson',
    exists: true,
    content: LOCAL_APP_LOG,
  });
  vi.spyOn(platform, 'auditReadAppEngine').mockResolvedValue({
    path: 'C:/data/audit/app-operations.ndjson',
    exists: true,
    content: ENGINE_APP_LOG,
  });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('应用操作档的两个来源', () => {
  it('切到应用操作后，本机与引擎两条记录都在表里，并标出来源', async () => {
    const host = mount(<AuditPage />);
    await flush();

    const tab = buttonByText(host, '应用操作');
    expect(tab, '缺少「应用操作」切换按钮').toBeTruthy();
    await click(tab!);
    await flush();

    const text = host.textContent ?? '';
    // 本机记录（人新建的专家）
    expect(text).toContain('新建专家');
    // 引擎记录（Dream 采纳）+ 引擎侧动作标签
    expect(text).toContain('采纳 Dream 合并');
    // 来源列把两者分开
    expect(text).toContain('本机');
    expect(text).toContain('引擎');
    // 摘要行说明其中有几条来自引擎
    expect(text).toContain('其中引擎记录');
  });

  it('引擎那份读不到时，本机记录照常显示（不能整表变空）', async () => {
    vi.mocked(platform.auditReadAppEngine).mockResolvedValue({
      path: 'C:/data/audit/app-operations.ndjson',
      exists: false,
      content: '',
    });
    const host = mount(<AuditPage />);
    await flush();

    await click(buttonByText(host, '应用操作')!);
    await flush();

    const text = host.textContent ?? '';
    expect(text).toContain('新建专家');
    expect(text).not.toContain('采纳 Dream 合并');
  });

  it('网关写的「外发消息」也出现在表里，且渲染成中文而不是裸 id', async () => {
    // 主进程会把 serve 与 gateway 两份拼成一段 content 交上来；
    // 这里直接模拟合并后的结果，钉住「动作 -> 标签」这条路真的通到界面。
    vi.mocked(platform.auditReadAppEngine).mockResolvedValue({
      path: 'C:/data/audit/app-operations.ndjson',
      exists: true,
      content: [
        ENGINE_APP_LOG,
        '{"ts":"2026-10-23T04:00:00.000+00:00","action":"message.send","outcome":"ok","actor":"engine","targetLabel":"oc_v3_abc123","detail":{"channel":"feishu.feishu","chars":42}}',
      ].join('\n'),
    });
    const host = mount(<AuditPage />);
    await flush();

    await click(buttonByText(host, '应用操作')!);
    await flush();

    const text = host.textContent ?? '';
    expect(text).toContain('外发消息');
    // 会话标识要露出来：这条账回答的是「发给了哪条 IM 线程」
    expect(text).toContain('oc_v3_abc123');
    // 裸 id 说明标签表漏了这条 —— 界面会退化成让人猜 action 拼写
    expect(text).not.toContain('message.send');
  });
});
