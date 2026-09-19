/**
 * 快捷键注册表——**唯一事实源**。
 *
 * 为什么要有这张表：
 * 键位此前是散落的——TitleBar 硬编码 Alt+E/Alt+H，Composer 硬编码 Enter/Shift+Enter，
 * 其余「看起来该有」的组合键根本没人监听。想做出「改键」界面，就必须先回答
 * 「有哪些命令、默认键位是什么、谁负责匹配」，否则界面和实现会各写一份键位字面量，
 * 早晚出现「列表显示 Ctrl+B、实际监听却是别的键」。
 *
 * 收口后三处消费者都只读这张表：
 * 1. 设置界面（`ShortcutsSection`）——渲染与改键；
 * 2. 全局派发器（`useGlobalShortcuts`）——窗口级 keydown 匹配 `scope: 'global'`；
 * 3. 输入框（`Composer`）——焦点内匹配 `scope: 'composer'`。
 *
 * —— 键位字符串格式（canonical）——
 * 修饰键 + 主键，用 `+` 连接，如 `Ctrl+Shift+B`。
 * - 修饰键：`Ctrl` / `Alt` / `Shift` / `Meta`（Meta = macOS ⌘ / Win 键）
 * - 主键：字母 `A`-`Z`（大写）；数字 `0`-`9`；功能键 `F1`-`F24`；
 *   命名键 `Enter` `Esc` `Space` `Tab` `Backspace` `Delete` `Up` `Down` `Left` `Right`；
 *   符号按字面 `,` `.` `/` `[` `]` `=` `@` `;` `'` `` ` ``；
 *   **`+` 与 `-` 不能按字面放进连接串**（`+` 是分隔符），统一记为 `Plus` / `Minus`，
 *   展示时还原成带引号的 `"+"` / `"-"`。
 */

/** 修饰键 token（顺序即捕获时的规范化顺序：Ctrl → Alt → Shift → Meta） */
const MODIFIER_TOKENS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

/**
 * 一条快捷键命令的作用域：
 * - `global`：窗口级 keydown 派发，任何时候按下都可能生效（受输入控件避让规则约束）；
 * - `composer`：由输入框自己处理（焦点在输入框内才生效）；
 * - `desktop`：Electron 主进程 `globalShortcut` 注册，系统级，渲染层只负责展示与改键；
 * - `fixed`：**没有键位可言**——由输入内容触发（`@` / `/`），列表里只作说明。
 */
export type ShortcutScope = 'global' | 'composer' | 'desktop' | 'fixed';

/** 列表分组：`custom` 可改键；`fixed` 键位固定（操作列显示「—」，键帽灰显） */
export type ShortcutGroup = 'custom' | 'fixed';

export type ShortcutId =
  | 'settings.open'
  | 'voice.toggle'
  | 'chat.search'
  | 'chat.send'
  | 'chat.newline'
  | 'chat.new'
  | 'chat.stop'
  | 'task.prev'
  | 'task.next'
  | 'sidebar.toggle'
  | 'artifact.toggle'
  | 'window.fullscreen'
  | 'app.wake'
  | 'picker.at'
  | 'slash.command';

export interface ShortcutDef {
  id: ShortcutId;
  /** 命令名（列表「命令」列文案） */
  label: string;
  /** 默认键位；`''` 表示默认不绑定 */
  defaultBinding: string;
  scope: ShortcutScope;
  group: ShortcutGroup;
  /** 仅桌面端（Electron）可用；Web 端键帽置灰、不可改 */
  desktopOnly?: boolean;
}

/**
 * 全局唤起快捷键的出厂值（Electron accelerator 语法，与 `+` 分隔的 canonical 串恰好同形）。
 *
 * 定义在这里而不是 `DEFAULT_DESKTOP` 里，是为了让「注册表」与「默认配置」共用同一个字面量：
 * 两处各写一遍，改一处漏一处就会出现「设置里显示 Ctrl+Alt+S，主进程注册的却是别的键」。
 * 不用 Alt+Space：Windows 上该组合被系统窗口菜单占用，注册必然失败。
 */
export const DEFAULT_WAKE_ACCELERATOR = 'Ctrl+Alt+S';

/**
 * 注册表。**顺序即列表顺序**，`group` 变化处会在界面上画一条分隔线
 * （前 13 条可改键，后 2 条固定）——这也是为什么不用两个数组拼：顺序是界面契约的一部分。
 *
 * 刻意**只收录 nanowork 真实存在的能力**。WorkBuddy 的快捷键表里还有
 * 「放大/缩小/重置内容字号」三条，本项目暂无内容缩放能力，收进来会变成
 * 「看着能按、按了没反应」的假菜单项——设置界面上最不能容忍的就是这种。
 * 日后补上缩放（正确的做法是 Electron 主进程 `webContents.setZoomFactor`，
 * 而非根节点 CSS `zoom`：后者不补偿 `vh`，且会让 MUI 弹窗的 `inset:0`
 * 固定层溢出视口，已实测）再往这里加三条即可。
 */
export const SHORTCUTS: ShortcutDef[] = [
  { id: 'settings.open', label: '打开设置', defaultBinding: 'Ctrl+,', scope: 'global', group: 'custom' },
  { id: 'voice.toggle', label: '语音录制开关', defaultBinding: 'Ctrl+D', scope: 'composer', group: 'custom' },
  { id: 'chat.search', label: '对话内搜索', defaultBinding: 'Ctrl+F', scope: 'global', group: 'custom' },
  { id: 'chat.send', label: '发送消息', defaultBinding: 'Enter', scope: 'composer', group: 'custom' },
  { id: 'chat.newline', label: '输入时换行', defaultBinding: 'Shift+Enter', scope: 'composer', group: 'custom' },
  { id: 'chat.new', label: '新建对话', defaultBinding: 'Ctrl+N', scope: 'global', group: 'custom' },
  { id: 'chat.stop', label: '停止生成', defaultBinding: 'Esc', scope: 'composer', group: 'custom' },
  { id: 'task.prev', label: '上一个任务', defaultBinding: 'Ctrl+[', scope: 'global', group: 'custom' },
  { id: 'task.next', label: '下一个任务', defaultBinding: 'Ctrl+]', scope: 'global', group: 'custom' },
  { id: 'sidebar.toggle', label: '切换左侧栏', defaultBinding: 'Ctrl+B', scope: 'global', group: 'custom' },
  { id: 'artifact.toggle', label: '切换右侧产物面板', defaultBinding: 'Ctrl+Shift+B', scope: 'global', group: 'custom' },
  { id: 'window.fullscreen', label: '进入/退出全屏', defaultBinding: 'F11', scope: 'global', group: 'custom' },
  {
    id: 'app.wake',
    label: '唤起/隐藏主窗口',
    defaultBinding: DEFAULT_WAKE_ACCELERATOR,
    scope: 'desktop',
    group: 'custom',
    desktopOnly: true,
  },
  { id: 'picker.at', label: '唤起选择器', defaultBinding: '@', scope: 'fixed', group: 'fixed' },
  { id: 'slash.command', label: '唤起斜杠命令', defaultBinding: '/', scope: 'fixed', group: 'fixed' },
];

/** id → 默认键位的扁平索引，供「恢复默认」判等使用 */
export const DEFAULT_BINDINGS: Record<ShortcutId, string> = SHORTCUTS.reduce(
  (acc, def) => {
    acc[def.id] = def.defaultBinding;
    return acc;
  },
  {} as Record<ShortcutId, string>,
);

/** 需要窗口级派发的命令（派发器据此过滤，避免每条 keydown 都遍历整表） */
export const GLOBAL_SHORTCUTS: ShortcutDef[] = SHORTCUTS.filter(
  (def) => def.scope === 'global',
);

// —— 键位解析与匹配 ——

/** 参与匹配的最小事件形状：原生 KeyboardEvent 与 React 合成事件都满足 */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** `event.key` → 主键 token。方向键、空格、加减号在 KeyboardEvent 里的写法与显示不一致，需映射 */
const KEY_ALIASES: Record<string, string> = {
  Escape: 'Esc',
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  '+': 'Plus',
  '-': 'Minus',
};

/** 主键 token → 展示文案。未列出的按字面展示（字母数字符号均无需转换） */
const KEY_DISPLAY: Record<string, string> = {
  Plus: '"+"',
  Minus: '"-"',
};

/** 光按修饰键时 `event.key` 的值——这些不该被当成「按下了某个键」 */
const BARE_MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'];

/**
 * 从事件里取出主键 token。
 *
 * 优先用 `e.code`：Shift 组合下 `e.key` 会变成符号（`Shift+1` → `'!'`），
 * 而 `e.code` 仍是 `Digit1`，只有它能在「绑定时按下的键」与「匹配时按下的键」之间稳定对应。
 */
export function eventKeyToken(e: KeyLike): string {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
  if (/^F\d{1,2}$/.test(e.code)) return e.code;
  if (KEY_ALIASES[e.key]) return KEY_ALIASES[e.key];
  // 兜底：单个可见字符（字母统一大写，符号原样）
  if (e.key.length === 1) return e.key.toUpperCase();
  return e.key;
}

/** 拆分键位串为 token 数组（容忍多余空白与空段） */
export function splitBinding(binding: string): string[] {
  return binding
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean);
}

/** 解析键位串：末位 token 为主键，其余为修饰键 */
export function parseBinding(
  binding: string,
): { mods: string[]; key: string } | null {
  const tokens = splitBinding(binding);
  if (tokens.length === 0) return null;
  return { mods: tokens.slice(0, -1), key: tokens[tokens.length - 1] };
}

/**
 * 事件是否命中该键位。**修饰键按全等判定**——按下 Ctrl+Shift+B 时
 * 不会连带命中 Ctrl+B，否则「切换侧边栏」和「切换产物面板」会同时响应。
 */
export function matchBinding(binding: string, e: KeyLike): boolean {
  if (!binding) return false;
  const parsed = parseBinding(binding);
  if (!parsed) return false;

  if (parsed.mods.includes('Ctrl') !== e.ctrlKey) return false;
  if (parsed.mods.includes('Alt') !== e.altKey) return false;
  if (parsed.mods.includes('Shift') !== e.shiftKey) return false;
  if (parsed.mods.includes('Meta') !== e.metaKey) return false;

  return eventKeyToken(e) === parsed.key;
}

/**
 * 从一次按键事件反向得到键位串（改键录入用）。
 * 只按了修饰键时返回 null——此时用户还在「按着」，没到该落定的时刻。
 */
export function bindingFromEvent(e: KeyLike): string | null {
  const key = eventKeyToken(e);
  if (!key || BARE_MODIFIER_KEYS.includes(key)) return null;

  const parts: string[] = [];
  for (const mod of MODIFIER_TOKENS) {
    if (mod === 'Ctrl' && e.ctrlKey) parts.push(mod);
    if (mod === 'Alt' && e.altKey) parts.push(mod);
    if (mod === 'Shift' && e.shiftKey) parts.push(mod);
    if (mod === 'Meta' && e.metaKey) parts.push(mod);
  }
  parts.push(key);
  return parts.join('+');
}

/** 键位串 → 展示文案（`Ctrl+Plus` → `Ctrl+"+"`）。空串返回空串 */
export function formatBinding(binding: string): string {
  const tokens = splitBinding(binding);
  if (tokens.length === 0) return '';
  return tokens.map((token) => KEY_DISPLAY[token] ?? token).join('+');
}

/** 取某条命令当前生效的键位。表中没有覆盖 = 用默认；值为 `''` = 用户显式清除（禁用） */
export function resolveBinding(
  id: ShortcutId,
  overrides?: Record<string, string>,
): string {
  const override = overrides?.[id];
  if (override !== undefined) return override;
  return DEFAULT_BINDINGS[id];
}

/**
 * 该键位在输入控件聚焦时是否会与打字冲突。
 *
 * 判据是「**裸可打印键**」：没有 Ctrl/Alt/Meta 时，字母、数字、符号、空格都是用户想打出来的字符，
 * 派发器必须让路——否则把「切换左侧栏」绑成 `B` 之后，在输入框里打 "b" 就会把侧边栏收起来。
 * `Shift` 不算避让理由（`Shift+Enter` 本就归输入框自己处理），功能键与 Esc 也不算冲突。
 *
 * 判断「是否真的在输入控件里」由 `lib/editableTarget` 负责——本模块保持纯字符串逻辑。
 */
export function conflictsWithTyping(binding: string): boolean {
  const parsed = parseBinding(binding);
  if (!parsed) return false;
  if (['Ctrl', 'Alt', 'Meta'].some((mod) => parsed.mods.includes(mod))) {
    return false;
  }
  return parsed.key.length === 1 || parsed.key === 'Space';
}
