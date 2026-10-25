/**
 * 「添加 / 编辑模型」对话框。
 *
 * 版式按参考图分「两种情况」：**内置供应商**（三个字段：供应商 / API Key / 模型名称下拉）
 * 与**完全自定义**（多出接口地址、供应商名称与「高级配置」）。下面每组断言都对应一类
 * 真实发生过的失效：
 *
 * 1. **供应商下拉的可选中性**（2026-09-21）：下拉能展开、候选项都在，但点任何一个都
 *    没反应，且框里是个空框。根因在 MUI 的 SelectInput 用 `React.Children.toArray`
 *    收子节点、而 `toArray` **不展开 Fragment**——被 clone 上 `onClick` / `value` /
 *    `data-value` 的是 Fragment 本身，包在里面的 MenuItem 一个都拿不到。所以断言
 *    不能只看「菜单项渲染了没有」，必须落到**回显文案**这个判据上。
 * 2. **API Key 必须选填**：密钥还可能来自引擎侧已配置的值、环境变量
 *    （`<PROVIDER>_API_KEY`），本地部署 / 内网网关则根本不需要。界面拦着不让保存，
 *    只会逼用户随手编个假凭据写进 config.json。
 * 3. **高级配置真正落到表单值上**：四个能力勾选、思考模式、token 上限若只是画着好看、
 *    没进 `onSubmit` 的参数，界面上完全看不出来（保存照样成功）。
 * 4. **供应商模式不显示高级配置，但也不许把原值弄丢**：那份表单在界面上不存在，
 *    回填只能靠 state——漏了就是「编辑一条内置预设，顺手把它调过的窗口与能力声明
 *    重置了」，而这种丢失在界面上看不见（这正是参考图与既有功能之间的取舍点）。
 *
 * ⚠️ `setInputValue` 必须先经过原型上的 value setter：React 在 input 上挂了
 * value tracker，直接 `el.value = x` 会被判定为「值没变」而丢弃，用例看起来过了
 * 其实是空转（见 `helpers/reactMount`）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { ThemeProvider } from '@mui/material';
import { ModelDialog } from '@/components/settings/ModelDialog';
import { MODEL_PROVIDERS } from '@/lib/model/modelProviders';
import {
  CONTEXT_WINDOW_OPTIONS,
  MAX_TOKENS_OPTIONS,
  TOKEN_DEFAULT_LABEL,
} from '@/lib/model/modelOptions';
import type { ManagedModel, ModelFormValue } from '@/stores/modelsStore';
import type { ModelProbeResult } from '@/platform/types';
import { muiTheme } from '@/theme/muiTheme';
import {
  byAria,
  buttonByText,
  click,
  dialogRoot,
  flush,
  mount,
  setInputValue,
  unmount,
} from './helpers/reactMount';

beforeEach(() => {
  unmount();
  probeCalls = [];
  vi.restoreAllMocks();
  delete (window as { electronAPI?: unknown }).electronAPI;
  // MUI 的 Dialog / Menu / Popper 全部走 Portal 渲染到 `document.body`，而 `unmount()`
  // 只回收自己那棵树。**前一个用例失败**（断言抛在过渡动画中间）时，Portal 容器会留在
  // body 里，于是下一例的 `document.querySelector('[role="dialog"]')` 命中那个过期节点：
  // 症状是「菜单点自定义没反应」「找不到 Autocomplete 箭头」这类**假失败**，且只在
  // 全量跑时出现（单跑该用例全绿）。空 body 是最省事、也最容易理解的隔离手段。
  document.body.innerHTML = '';
});

/**
 * 收尾：卸组件 + **把过渡定时器跑完**。
 *
 * 只 `unmount()` 不够：MUI `Dialog` 的开合过渡是 react-transition-group 的
 * `setTimeout`，**不归 React 管**。用例结束时若还有一次过渡在飞，它会在测试环境销毁
 * 之后触发，vitest 记一条 `Unhandled Error`——**所有用例都绿，但整个 run 的退出码是 1**
 * （`Errors 2 errors`）。这种「绿灯 + 非零退出码」最容易在 CI 里被当成噪音放过。
 */
afterEach(async () => {
  unmount();
  await new Promise((resolve) => setTimeout(resolve, 400));
});

/** 每次挂载收到的提交值（`submitted[0]` 即第一次提交） */
let submitted: ModelFormValue[] = [];
/** 关闭回调被调用的次数（保存成功会自动关） */
let closeCount = 0;
/** 交给桩 `probeModel` 的请求（用来断言「留空到底传了什么」） */
let probeCalls: unknown[] = [];

function mountDialog(editing?: ManagedModel): void {
  submitted = [];
  closeCount = 0;
  mount(
    <ThemeProvider theme={muiTheme}>
      <ModelDialog
        open
        editing={editing}
        onClose={() => {
          closeCount += 1;
        }}
        onSubmit={async (value) => {
          submitted.push(value);
          return true;
        }}
      />
    </ThemeProvider>,
  );
}

/**
 * 桩掉桥上的 `probeModel`。
 *
 * ⚠️ `platform.probeModel` 是**每次调用**才判 `isElectron()`（不像模块顶部的 storage
 * 那样在 import 时定死），所以在用例里现挂 `window.electronAPI` 就能让渲染层走
 * Electron 分支——不必 mock 整个 `@/platform` 模块（那会把 `env` 一起改掉，
 * 而 `env` 是模块加载期算好的，反而与真实运行态不一致）。
 */
function stubProbe(result: ModelProbeResult): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    probeModel: async (request: unknown) => {
      probeCalls.push(request);
      return result;
    },
  };
}

/** 「测试连接」按钮 */
function probeButton(): HTMLButtonElement {
  const el = buttonByText(document.body, '测试连接');
  expect(el, '找不到「测试连接」按钮').toBeTruthy();
  return el!;
}

/** 测试结果那一行（成功绿 / 失败红） */
function probeStatusText(): string {
  return (dialogRoot().textContent ?? '').replace(/\s+/g, ' ');
}

/** Select 的显示层：MUI 把「被认领的那个选中项」的文案渲染在这里 */
function selectDisplay(): HTMLElement {
  const el = document.querySelector('.MuiSelect-select');
  expect(el, '供应商下拉框未渲染').toBeTruthy();
  return el as HTMLElement;
}

/** 去掉字标后的可见文案（字标是 `data-provider-badge` 那个节点） */
function labelTextOf(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelector('[data-provider-badge]')?.remove();
  return (clone.textContent ?? '').replace(/\u200B/g, '').trim();
}

function displayText(): string {
  return labelTextOf(selectDisplay());
}

/**
 * 展开下拉。
 *
 * ⚠️ 必须是 `mousedown`：MUI 的 Select 在 mousedown 上开菜单（hijack 掉原生 focus 行为），
 * 派发 `click` 只会落空。
 */
async function openMenu(): Promise<void> {
  await act(async () => {
    selectDisplay().dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0 }),
    );
  });
  await flush();
}

/**
 * 展开后的候选项。
 *
 * ⚠️ 不要用裸 `[role="option"]` 计数：Select 会把**所有**子节点都 clone 成
 * `role="option"`，连 `ListSubheader`（分组标题）也一样，于是计数里会多出分组数。
 * 只看真正的菜单项（`MenuItem` 渲染成 `li.MuiMenuItem-root`）。
 */
function options(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('li.MuiMenuItem-root'));
}

/** 分组标题（展开后必须还在：扁平化不能把分组挤掉） */
function groupHeaders(): string[] {
  return Array.from(document.querySelectorAll('.MuiListSubheader-root')).map(
    (n) => (n.textContent ?? '').trim(),
  );
}

/** 选中一个供应商（展开 → 点候选项 → 断言回显） */
async function pickProvider(label: string): Promise<void> {
  await openMenu();
  const item = options().find((o) => labelTextOf(o) === label);
  expect(item, `菜单里没有「${label}」这个候选项`).toBeTruthy();
  click(item);
  await flush();
}

/** 保存按钮（底部那一个，文案固定） */
function saveButton(): HTMLButtonElement {
  const el = Array.from(document.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === '保存',
  );
  expect(el, '找不到保存按钮').toBeTruthy();
  return el as HTMLButtonElement;
}

/**
 * 取一个输入框。
 *
 * 字段标签是**独立的一行文字**（不在 `<label for>` 里），所以 `fieldByLabel` 在这里
 * 用不上；每个输入框都带 `aria-label`，按它定位。断言先于转型：找不到时直接让用例
 * 红在这一行，而不是拿 null 去驱动一个静默的空转。
 */
function inputByAria(label: string): HTMLInputElement {
  const el = byAria(label);
  expect(el, `找不到输入框「${label}」`).toBeTruthy();
  return el as HTMLInputElement;
}

function checkboxByAria(label: string): HTMLInputElement {
  const el = byAria(label);
  expect(el, `找不到勾选项「${label}」`).toBeTruthy();
  return el as HTMLInputElement;
}

/** 一个 token 档位组里的全部按钮（档位组是 `"<字段名> 档位"`） */
function tokenChips(fieldLabel: string): HTMLButtonElement[] {
  const group = byAria(`${fieldLabel} 档位`);
  expect(group, `找不到「${fieldLabel}」档位组`).toBeTruthy();
  return Array.from(group!.querySelectorAll('button'));
}

/** 点一个档位 */
function pickChip(fieldLabel: string, text: string): void {
  const chip = tokenChips(fieldLabel).find((b) => (b.textContent ?? '').trim() === text);
  expect(chip, `「${fieldLabel}」组里没有「${text}」档位`).toBeTruthy();
  click(chip);
}

/** 档位的选中态（读 aria-pressed，而不是靠颜色） */
function pressed(fieldLabel: string): string[] {
  return tokenChips(fieldLabel)
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => (b.textContent ?? '').trim());
}

/** 「模型名称」下拉的候选项（展开 → 读列表 → 收起，免得影响后续查询） */
async function openModelOptions(): Promise<string[]> {
  const indicator = dialogRoot().querySelector('.MuiAutocomplete-popupIndicator');
  expect(indicator, '模型名称不是下拉（找不到展开箭头）').toBeTruthy();
  click(indicator);
  await flush();
  const items = Array.from(document.querySelectorAll('li[role="option"]')).map((li) =>
    (li.textContent ?? '').trim(),
  );
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await flush();
  return items;
}

/** 切换到「自定义」并填好必填项（多处用例的共同前置） */
async function pickCustom(): Promise<void> {
  await pickProvider('自定义');
  setInputValue(inputByAria('接口地址'), 'https://gw.example.com/v1');
  await flush();
}

describe('添加模型 · 供应商模式', () => {
  it('默认供应商要回显出来（旧实现这里是个空框）', () => {
    mountDialog();
    expect(displayText()).toBe('DeepSeek 深度求索');
  });

  it('展开后点一个供应商，回显跟着变（旧实现点了没反应）', async () => {
    mountDialog();
    await pickProvider('OpenAI');
    expect(displayText()).toBe('OpenAI');
  });

  it('候选项一个都不能少，且自定义项文案与参考图一致', async () => {
    mountDialog();
    await openMenu();
    // 「自动匹配」「自定义」是目录之外的两个分支值，必须和内置供应商一起被认领，
    // 否则编辑 auto/自定义预设时下拉框无处可落（等于被迫改掉用户的路由规则）。
    expect(options()).toHaveLength(MODEL_PROVIDERS.length + 2);
    expect(options().map(labelTextOf)).toContain('自定义');
  });

  it('分组标题一个都不能少（扁平化只改结构，不改呈现）', async () => {
    mountDialog();
    await openMenu();
    expect(groupHeaders()).toEqual(['官方直连', '聚合网关', '本地部署', '其他']);
  });

  it('不显示接口地址与高级配置（内置供应商用注册表默认地址，对齐参考图）', async () => {
    mountDialog();
    expect(byAria('接口地址'), '内置供应商不该有接口地址字段').toBeNull();
    expect(document.body.textContent).not.toContain('高级配置');
    expect(byAria('上下文窗口')).toBeNull();
  });

  it('模型名称是下拉，候选项来自该供应商的内置常用清单', async () => {
    mountDialog();
    const items = await openModelOptions();
    expect(items).toContain('deepseek-v4-pro');
    expect(items).toContain('deepseek-v4-flash');
  });

  it('模型名称可自由输入（上游新出的名字不该被候选列表拦住）', async () => {
    mountDialog();
    setInputValue(inputByAria('模型名称'), 'deepseek-next-gen');
    await flush();
    expect(saveButton().disabled).toBe(false);

    click(saveButton());
    await flush();
    expect(submitted[0].model).toBe('deepseek-next-gen');
  });
});

describe('添加模型 · 完全自定义', () => {
  it('选自定义后出现接口地址、供应商名称与高级配置，模型名称变成普通输入框', async () => {
    mountDialog();
    await pickCustom();

    expect(inputByAria('接口地址').value).toBe('https://gw.example.com/v1');
    expect(inputByAria('供应商名称')).toBeTruthy();
    expect(document.body.textContent).toContain('高级配置');
    expect(document.body.textContent).toContain('工具调用');
    // 自定义供应商不在注册表里，没有「常用模型」可列 → 退回自由输入的输入框
    expect(dialogRoot().querySelector('.MuiAutocomplete-popupIndicator')).toBeNull();
  });

  it('接口地址是必填（没有它就没有可打的端点）', async () => {
    mountDialog();
    await pickProvider('自定义');
    setInputValue(inputByAria('模型名称'), 'local-model');
    await flush();

    expect(saveButton().disabled, '自定义供应商缺地址时不该放行').toBe(true);

    setInputValue(inputByAria('接口地址'), 'http://127.0.0.1:8001/v1');
    await flush();
    expect(saveButton().disabled).toBe(false);
  });

  it('五个能力勾选项齐全，默认勾上与引擎字段默认值同源（工具调用 / 思考能力为真）', async () => {
    mountDialog();
    await pickCustom();

    // 「思考能力」与「注入思考强度」是两件事：前者是模型能不能思考（引擎默认 true），
    // 后者是我们要不要强制一个档位（默认不注入）。此前只有一个勾选框绑在档位上，
    // 「有思考能力但不强制档位」这种状态在界面上根本表达不出来。
    for (const label of ['工具调用', '图片输入', '思考能力', '注入思考强度', '自定义协议']) {
      expect(checkboxByAria(label), `找不到勾选项「${label}」`).toBeTruthy();
    }
    expect(checkboxByAria('工具调用').checked).toBe(true);
    expect(checkboxByAria('图片输入').checked).toBe(false);
    expect(checkboxByAria('思考能力').checked).toBe(true);
    expect(checkboxByAria('注入思考强度').checked).toBe(false);
    expect(checkboxByAria('自定义协议').checked).toBe(false);
  });

  it('⚠️ 关掉「思考能力」会同时清掉「注入思考强度」并把它置灰', async () => {
    mountDialog();
    await pickCustom();

    click(checkboxByAria('注入思考强度'));
    await flush();
    expect(checkboxByAria('注入思考强度').checked).toBe(true);

    click(checkboxByAria('思考能力'));
    await flush();

    // 留着一个「不支持思考却注入了档位」的预设，引擎照样会把 reasoning_effort
    // 发出去，而界面说它不支持——必须一起清掉
    expect(checkboxByAria('注入思考强度').checked).toBe(false);
    expect(checkboxByAria('注入思考强度').disabled).toBe(true);
    expect(
      document.body.textContent?.includes('已声明该模型没有思考能力'),
      '置灰要给出原因，否则用户以为控件坏了',
    ).toBe(true);
  });

  it('能力勾选真的进 onSubmit（只画不传的控件在界面上看不出来）', async () => {
    mountDialog();
    await pickCustom();
    setInputValue(inputByAria('模型名称'), 'gw-omni');
    await flush();

    click(checkboxByAria('工具调用')); // 取消勾选
    click(checkboxByAria('图片输入'));
    click(checkboxByAria('思考能力')); // 取消勾选（默认是勾上的）
    click(checkboxByAria('自定义协议'));
    await flush();

    click(saveButton());
    await flush();

    expect(submitted[0].supportsTools).toBe(false);
    expect(submitted[0].supportsVision).toBe(true);
    expect(submitted[0].supportsReasoning).toBe(false);
    expect(submitted[0].customProtocol).toBe(true);
    // 关掉「思考能力」时强度被一并清空：留着一个仍然生效的档位，引擎照样会把它发出去
    expect(submitted[0].reasoningEffort).toBeNull();
  });

  it('两个 token 框初始为空 = 使用提供商默认值，占位符写着这句话', async () => {
    mountDialog();
    await pickCustom();

    expect(inputByAria('上下文窗口').value).toBe('');
    expect(inputByAria('单次最大输出').value).toBe('');
    expect(inputByAria('上下文窗口').placeholder).toBe(TOKEN_DEFAULT_LABEL);
    expect(inputByAria('单次最大输出').placeholder).toBe(TOKEN_DEFAULT_LABEL);
  });

  it('点档位把文案填进输入框（档位与框只有一个读数），并进 onSubmit', async () => {
    mountDialog();
    await pickCustom();
    setInputValue(inputByAria('模型名称'), 'gw-omni');
    await flush();

    expect(tokenChips('上下文窗口')).toHaveLength(CONTEXT_WINDOW_OPTIONS.length);
    expect(tokenChips('单次最大输出')).toHaveLength(MAX_TOKENS_OPTIONS.length);

    pickChip('上下文窗口', '128K');
    await flush();
    expect(inputByAria('上下文窗口').value).toBe('128K');
    expect(pressed('上下文窗口')).toEqual(['128K']);

    pickChip('单次最大输出', '64K');
    await flush();

    click(saveButton());
    await flush();
    expect(submitted[0].contextWindowTokens).toBe(131_072);
    expect(submitted[0].maxTokens).toBe(65_536);
  });

  it('手写 200,000 / 128K 这类写法都认（同一个解析口径）', async () => {
    mountDialog();
    await pickCustom();
    setInputValue(inputByAria('模型名称'), 'gw-omni');
    setInputValue(inputByAria('上下文窗口'), ' 200,000 ');
    setInputValue(inputByAria('单次最大输出'), '128k');
    await flush();

    expect(saveButton().disabled).toBe(false);
    click(saveButton());
    await flush();
    expect(submitted[0].contextWindowTokens).toBe(200_000);
    expect(submitted[0].maxTokens).toBe(131_072);
  });

  it('写错的值拦下保存，而不是静默当成「使用提供商默认值」', async () => {
    mountDialog();
    await pickCustom();
    setInputValue(inputByAria('模型名称'), 'gw-omni');
    await flush();
    expect(saveButton().disabled).toBe(false);

    setInputValue(inputByAria('上下文窗口'), '12x');
    await flush();
    expect(saveButton().disabled, '非法输入必须拦下（吞掉用户写的字更糟）').toBe(true);

    setInputValue(inputByAria('上下文窗口'), '');
    await flush();
    expect(saveButton().disabled).toBe(false);
  });

  it('清空输入框 = 回到使用提供商默认值（提交 null）', async () => {
    mountDialog();
    await pickCustom();
    setInputValue(inputByAria('模型名称'), 'gw-omni');
    pickChip('上下文窗口', '256K');
    await flush();
    setInputValue(inputByAria('上下文窗口'), '');
    await flush();

    click(saveButton());
    await flush();
    expect(submitted[0].contextWindowTokens).toBeNull();
  });
});

describe('添加模型 · API Key 与探测', () => {
  it('默认是密码框，眼睛按钮切到明文（再点回密码）', async () => {
    mountDialog();
    expect(inputByAria('API Key').type).toBe('password');

    click(byAria('显示 API Key'));
    await flush();
    expect(inputByAria('API Key').type).toBe('text');

    click(byAria('隐藏 API Key'));
    await flush();
    expect(inputByAria('API Key').type).toBe('password');
  });

  it('未填 API Key 也能测；留空就真的不传密钥（由主进程回退到引擎侧）', async () => {
    stubProbe({ ok: true, models: ['gpt-4o'], latencyMs: 12, keySource: 'config' });
    mountDialog();
    // 接口地址字段只在自定义 / 自动匹配下存在（内置供应商用注册表默认地址）
    await pickCustom();
    setInputValue(inputByAria('接口地址'), 'http://127.0.0.1:8001/v1');
    await flush();

    expect(probeButton().disabled, '填了地址就该能测，不该逼用户先编一个 key').toBe(false);
    click(probeButton());
    await flush();

    // 传的是 undefined（而不是空串）：主进程据此才敢去 config.json 找已配置的密钥
    expect(probeCalls).toHaveLength(1);
    expect((probeCalls[0] as { apiKey?: string }).apiKey).toBeUndefined();
    // 连上了但用的是引擎侧的密钥，必须说出来——否则用户以为「这个框填不填都一样」
    const text = probeStatusText();
    expect(text).toContain('连接成功');
    expect(text).toContain('引擎侧已配置的密钥');
  });

  it('探测到的模型进入「模型名称」候选（清单比内置常用表新）', async () => {
    stubProbe({ ok: true, models: ['brand-new-model'], latencyMs: 8, keySource: null });
    mountDialog();
    // ⚠️ 这里必须挑一个**注册表里没登记常用模型**的内置供应商（MiniMax 的 `models` 留空）：
    // 只有它的候选能干净地等于这次探测的结果。自定义供应商看着更合适，实则不然——
    // 它的「模型名称」是自由输入框（没有候选可列，见「完全自定义」那组的断言），
    // 拿它来找下拉箭头必然落空。
    await pickProvider('MiniMax');
    click(probeButton());
    await flush();

    const items = await openModelOptions();
    expect(items).toEqual(['brand-new-model']);
  });

  it('探测结果排在候选最前（清单比内置常用表新）', async () => {
    stubProbe({ ok: true, models: ['brand-new-model'], latencyMs: 8, keySource: null });
    mountDialog(); // 默认 DeepSeek：既有内置常用清单，也能按注册表默认地址探活
    click(probeButton());
    await flush();

    const items = await openModelOptions();
    expect(items[0]).toBe('brand-new-model');
    expect(items).toContain('deepseek-v4-pro');
  });

  it('失败时显示主进程给的原文（不再把它压成一句「连接失败」）', async () => {
    stubProbe({
      ok: false,
      error: '已连到上游，但它拒绝了未授权请求（HTTP 401）：该端点不接受匿名请求，请在「API Key」里填写有效密钥',
      latencyMs: 30,
      keySource: null,
    });
    mountDialog();
    await pickCustom();
    setInputValue(inputByAria('接口地址'), 'http://127.0.0.1:8001/v1');
    await flush();
    click(probeButton());
    await flush();

    const text = probeStatusText();
    expect(text).toContain('已连到上游');
    expect(text).toContain('HTTP 401');
  });
});

describe('添加模型 · 查看文档', () => {
  it('有文档地址的供应商显示入口，点它交给系统浏览器', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    mountDialog(); // 默认 DeepSeek，目录里有 docsUrl
    const entry = buttonByText(dialogRoot(), '查看文档');
    expect(entry, 'DeepSeek 应显示「查看文档」入口').toBeTruthy();

    click(entry);
    await flush();
    // jsdom 里没有 electronAPI → 走 web 分支；桌面端走主进程 shell（见 platform.openUrl）
    expect(open).toHaveBeenCalledWith(
      'https://api-docs.deepseek.com',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('目录里没登记文档的供应商不显示该入口（猜一个地址比没有更糟）', async () => {
    mountDialog();
    await pickProvider('MiniMax');
    expect(buttonByText(dialogRoot(), '查看文档')).toBeNull();
  });
});

describe('添加模型 · 保存闸门与关闭', () => {
  it('模型名为空时不给保存（预设名就是它，空名会让这行在选择器里消失）', () => {
    mountDialog();
    expect(saveButton().disabled).toBe(true);
  });

  it('API Key 非必填：只填模型名即可保存', async () => {
    mountDialog();
    setInputValue(inputByAria('模型名称'), 'gpt-4o');
    await flush();

    expect(saveButton().disabled, 'API Key 留空不该拦住保存').toBe(false);
    click(saveButton());
    await flush();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].model).toBe('gpt-4o');
    expect(submitted[0].apiKey).toBe('');
  });

  it('右上角 X 关闭对话框', async () => {
    mountDialog();
    click(byAria('关闭'));
    await flush();
    expect(closeCount).toBe(1);
    // 关掉不等于提交：不该顺手保存一份空表单
    expect(submitted).toHaveLength(0);
  });

  it('保存成功后自动关闭', async () => {
    mountDialog();
    setInputValue(inputByAria('模型名称'), 'gpt-4o');
    await flush();
    click(saveButton());
    await flush();
    expect(closeCount).toBe(1);
  });
});

/**
 * 编辑模式用的既有模型（各字段都取非默认值，才能看出对话框有没有把它们带回来）
 */
function managedModel(overrides: Partial<ManagedModel> = {}): ManagedModel {
  return {
    name: 'gpt-4o',
    model: 'gpt-4o',
    provider: 'deepseek',
    providerKey: 'deepseek',
    providerLabel: 'DeepSeek 深度求索',
    apiKey: '',
    apiBase: '',
    hasKey: false,
    isDefault: false,
    custom: false,
    contextWindowTokens: 131_072,
    maxTokens: 65_536,
    reasoningEffort: null,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    customProtocol: false,
    // 单价：null = 没配（回填时三个框都该是空的）
    pricing: null,
    temperature: 0.7,
    ...overrides,
  };
}

describe('添加模型 · 编辑回填', () => {
  it('内置预设：高级配置不显示，但窗口 / 输出 / 能力声明原样带回去（不静默重置）', async () => {
    mountDialog(
      managedModel({ contextWindowTokens: 262_144, supportsVision: true, customProtocol: true }),
    );
    // 界面上没有这些字段——它们的值只能靠 state 带过一遍
    expect(byAria('上下文窗口')).toBeNull();

    click(saveButton());
    await flush();
    expect(submitted[0].contextWindowTokens).toBe(262_144);
    expect(submitted[0].maxTokens).toBe(65_536);
    expect(submitted[0].supportsVision).toBe(true);
    expect(submitted[0].customProtocol).toBe(true);
  });

  it('自定义预设：接口地址 / 供应商名称 / 能力声明 / 档位都回填到界面上', async () => {
    mountDialog(
      managedModel({
        name: '我的网关',
        model: 'gw-omni',
        provider: '我的网关',
        providerKey: '我的网关',
        providerLabel: '我的网关',
        apiBase: 'https://gw.example.com/v1',
        custom: true,
        reasoningEffort: 'high',
        supportsVision: true,
        // 用户自己填过、不在档位里的数：必须原样回显，而不是「一个档位都没选中」
        contextWindowTokens: 100_000,
      }),
    );

    expect(displayText()).toBe('自定义');
    expect(inputByAria('接口地址').value).toBe('https://gw.example.com/v1');
    expect(inputByAria('供应商名称').value).toBe('我的网关');
    expect(inputByAria('模型名称').value).toBe('gw-omni');
    // 回填走同一套展示口径（`formatTokenLimit`）：1024 的整数倍写成 `K`（与档位同字，
    // 用户一眼能对上生效的是哪个），其余的带千分位原样显示 —— 100000 不是整数倍，
    // 写成 `97.6K` 会让人以为值被改过；逗号由 `parseTokenLimitInput` 吃掉，往返无损。
    expect(inputByAria('上下文窗口').value).toBe('100,000');
    expect(inputByAria('单次最大输出').value).toBe('64K');
    expect(pressed('上下文窗口')).toEqual([]); // 100000 不在档位里，但值要看得见
    expect(pressed('单次最大输出')).toEqual(['64K']); // 65536 就是那个档位，必须显示为选中
    expect(checkboxByAria('图片输入').checked).toBe(true);
    // 回填后「思考能力」勾上（引擎默认 true），「注入思考强度」也勾上（预设里是 high）——
    // 两个控件各答一个问题，此前它们被压成同一个
    expect(checkboxByAria('思考能力').checked).toBe(true);
    expect(checkboxByAria('注入思考强度').checked).toBe(true);

    click(saveButton());
    await flush();
    expect(submitted[0].reasoningEffort).toBe('high');
    expect(submitted[0].supportsReasoning).toBe(true);
    expect(submitted[0].contextWindowTokens).toBe(100_000);
    expect(submitted[0].supportsVision).toBe(true);
  });

  it('auto 预设：显示接口地址（可选），不显示高级配置，模型名可手填', async () => {
    mountDialog(
      managedModel({
        provider: 'auto',
        providerKey: '',
        providerLabel: '自动匹配',
        custom: false,
        model: 'qwen-long',
      }),
    );

    expect(displayText()).toBe('自动匹配');
    expect(inputByAria('接口地址')).toBeTruthy();
    expect(byAria('上下文窗口')).toBeNull();
    expect(inputByAria('模型名称').value).toBe('qwen-long');
  });
});

describe('计价：单价进预设（FR-11.1 的金额口径）', () => {
  it('⭐ 内置供应商也能配单价（计价与「端点内置还是自建」无关）', async () => {
    mountDialog(); // 默认 provider = deepseek（内置）
    // 高级配置对它仍然不显示（既有约定），但计价必须在——
    // 否则最常见的这批用户永远配不了单价，「用量」分区的金额就永远是「暂不统计」
    expect(byAria('上下文窗口')).toBeNull();
    expect(inputByAria('输入单价')).toBeTruthy();
    expect(inputByAria('输出单价')).toBeTruthy();
    expect(inputByAria('缓存读取单价')).toBeTruthy();
  });

  it('三档单价进 onSubmit；缓存留空保持 null（＝按输入单价计，不是 0）', async () => {
    mountDialog();
    setInputValue(inputByAria('模型名称'), 'gpt-4o');
    setInputValue(inputByAria('输入单价'), '2.5');
    setInputValue(inputByAria('输出单价'), '10');
    await flush();
    click(saveButton());
    await flush();

    expect(submitted[0].pricing).toEqual({
      inputPerMillion: 2.5,
      outputPerMillion: 10,
      // 留空 ≠ 0：0 是「缓存免费」，那会把长会话的成本算低一个数量级
      cacheReadPerMillion: null,
      currency: 'CNY',
    });
  });

  it('三档都留空 → pricing 为 null（「没配」与「配成全零」在数据里是同一个值）', async () => {
    mountDialog();
    setInputValue(inputByAria('模型名称'), 'gpt-4o');
    await flush();
    click(saveButton());
    await flush();
    expect(submitted[0].pricing).toBeNull();
  });

  it('非法单价拦住保存（不静默当成 0）', async () => {
    mountDialog();
    setInputValue(inputByAria('模型名称'), 'gpt-4o');
    setInputValue(inputByAria('输入单价'), '2.5.1');
    await flush();
    expect(saveButton().disabled, '格式错的单价不该能保存').toBe(true);

    setInputValue(inputByAria('输入单价'), '2.5');
    await flush();
    expect(saveButton().disabled).toBe(false);
  });

  it('编辑回填：单价三个框按原值填回，留空的那档仍是空', async () => {
    mountDialog(
      managedModel({
        pricing: {
          inputPerMillion: 3,
          outputPerMillion: 15,
          cacheReadPerMillion: 0.3,
          currency: 'USD',
        },
      }),
    );
    expect(inputByAria('输入单价').value).toBe('3');
    expect(inputByAria('输出单价').value).toBe('15');
    expect(inputByAria('缓存读取单价').value).toBe('0.3');

    click(saveButton());
    await flush();
    expect(submitted[0].pricing?.currency).toBe('USD');
    expect(submitted[0].pricing?.cacheReadPerMillion).toBe(0.3);
  });
});
