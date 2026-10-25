# 快捷键体系（增量架构）

> 状态：V1 增量文档。收口目标：并入 v2 交互章节。
>
> 相关代码：`src/lib/editor/shortcuts.ts`（注册表与纯函数）、`src/lib/editor/editableTarget.ts`、
> `src/hooks/useGlobalShortcuts.ts`、`src/hooks/useDesktopConfig.ts`、
> `src/components/settings/sections/ShortcutsSection.tsx`、`src/components/HotkeyInput.tsx`。

---

## 1. 这件事要解决的问题

改键功能真正的难点不在于「怎么录一个按键」，而在于**键位此前没有归属**：

- `TitleBar` 里硬编码着 `Alt+E` / `Alt+H`；
- `Composer` 里硬编码着 `Enter` 发送、`Shift+Enter` 换行；
- 「切换侧边栏 / 切换产物面板 / 上一个任务 / 对话内搜索」等**根本没有键盘入口**。

在这种状态下做一个「快捷键设置界面」，只有两条路：要么界面自己维护一份键位表（与实现各说各话，
早晚出现「列表显示 Ctrl+B，实际监听的是别的键」），要么先做一次收口。
本方案选后者。

## 2. 分层

```
lib/editor/shortcuts.ts          注册表 + 键位串解析/匹配/格式化      ← 唯一事实源（纯逻辑，无 DOM）
lib/editor/editableTarget.ts     焦点是否在输入控件里                 ← 唯一使用 DOM 的判断
hooks/useGlobalShortcuts  窗口级 keydown 派发（scope=global）
Composer.handleInputKeyDown  输入框内处理（scope=composer）
Electron 主进程 globalShortcut  系统级热键（scope=desktop）
settingsStore.shortcuts   用户覆盖表（持久化）
ShortcutsSection          改键界面（读注册表渲染，不写死任何键位）
```

**只有注册表知道「有哪些命令、默认键位是什么」**。界面、派发器、输入框都从它读，
没有任何一处再写一遍键位字面量。

### 为什么要让 `lib/editor/shortcuts.ts` 保持零 DOM 依赖

它会被非渲染层的编译单元间接引用到：`electron/storageRoutes.ts → lib/core/constants → types/settings → types`。
electron 的 `tsconfig.node.json` 的 `lib` 只有 `ES2023`，**不加载 DOM 类型库**——
一旦这个文件里出现 `HTMLElement` / `EventTarget`，主进程的类型检查就会直接报错。
所以 `isEditableTarget`（唯一需要 DOM 的判断）被拆到 `lib/editor/editableTarget.ts`：
只有渲染层会引它，主进程那条链不会碰到。

这条约束不是洁癖：它同时消掉了 `TitleBar` 与派发器里两份重复的「可编辑」判断。

## 3. 键位串格式（canonical）

修饰键 + 主键，用 `+` 连接：

| 类别 | 写法 |
|---|---|
| 修饰键 | `Ctrl` / `Alt` / `Shift` / `Meta`（Meta = macOS ⌘ / Win 键） |
| 字母 | 大写 `A`–`Z` |
| 数字 | `0`–`9` |
| 功能键 | `F1`–`F24` |
| 命名键 | `Enter` `Esc` `Space` `Tab` `Backspace` `Delete` `Up` `Down` `Left` `Right` |
| 符号 | 按字面 `,` `.` `/` `[` `]` `=` `@` `;` `'` `` ` `` |
| **无法按字面写的** | `Plus`（`+` 是连接符）、`Minus`（与 `Plus` 对称） |

展示时 `Plus` → `"+"`、`Minus` → `"-"`（带引号，与 `Ctrl+Shift+B` 这种纯连接区分开）。

### 两个必须记住的细节

1. **主键取自 `e.code` 优先于 `e.key`。**
   `Shift+1` 时 `e.key` 是 `'!'`，而 `e.code` 仍是 `Digit1`。
   只看 `e.key` 会导致「绑定时按下 Shift+1、匹配时认不出来」。
2. **修饰键全等判定。**
   按下 `Ctrl+Shift+B` 不得连带命中 `Ctrl+B`。非全等判定会让「切换产物面板」和「切换左侧栏」
   同时响应，而这种 bug 在界面上完全看不出来。

## 4. 四种作用域

| scope | 谁负责匹配 | 命令 |
|---|---|---|
| `global` | `useGlobalShortcuts` 的窗口级 keydown | 打开设置 / 对话内搜索 / 新建对话 / 上一个任务 / 下一个任务 / 切换左侧栏 / 切换右侧产物面板 / 进入退出全屏 |
| `composer` | `Composer.handleInputKeyDown` | 语音录制开关 / 发送消息 / 输入时换行 / 停止生成 |
| `desktop` | **Electron 主进程** `globalShortcut` | 唤起/隐藏主窗口（渲染层只负责展示与改键） |
| `fixed` | 由输入内容触发，无键位可绑 | 唤起选择器 `@` / 唤起斜杠命令 `/` |

`composer` 不并入 `global` 的原因：输入框里的按键判定条件复杂得多——要处理输入法组合态
（`isComposing`，否则拼音选词的回车会被当成发送）、浮层优先级（选择器打开时方向键与回车
归浮层）、以及撤销/重做对 DOM 徽章的特殊处理。放进全局派发器会变成两处抢同一个按键。

## 5. 派发器的四条约束

见 `useGlobalShortcuts` 文件头注释，这里列出「为什么」：

1. **订阅一次，不随渲染重挂。** 键位、会话列表、侧边栏状态全部在事件回调里 `getState()` 现取。
   若放进依赖数组，任何一次会话列表刷新都会重建监听，空窗期内按下的键会丢失。
2. **让路给输入控件。** 判定在 `conflictsWithTyping`：**没有 `Ctrl`/`Alt`/`Meta` 时**，
   单字符与空格都是用户想打出来的内容，必须跳过。
   否则把「切换左侧栏」绑成 `B` 之后，输入框里就再也打不出字母 b。
   `Shift` 不算避让理由（`Shift+Enter` 本就归输入框自己处理），功能键与 `Esc` 也不算冲突。
3. **只在真的做了事时吞按键。** 没有活跃会话时按 `Ctrl+F`，不能把浏览器自带的查找一起挡掉——
   那是一个用户明确按下就期待出现的能力。因此 `runShortcutAction` 返回 `boolean`，
   由派发器决定要不要 `preventDefault()`。
4. **能力缺失时把按键交回系统。** Web 端没有 Fullscreen API 时 `toggleFullscreen` 返回 `false`
   而不是抛异常；Web 端不响应切换侧边栏（没有标题栏，收起后再无入口展开）。

## 6. 覆盖表的三态语义

`settings.shortcuts` 是 `Partial<Record<ShortcutId, string>>`，只有三种状态：

| 表内取值 | 含义 |
|---|---|
| 键不存在 | 用默认键位 |
| `''` | 用户显式清除 = 禁用该快捷键 |
| 键位串 | 覆盖默认 |

**不能把「键不存在」当成禁用**：那就再也无法表达「这条命令我还没动过」，
日后调整默认键位将无法惠及老用户。

`setShortcut` 会把「与默认相同的值」归一化成删除表项——否则表里会留下一条与默认完全相同的记录，
日后改默认值时它会挡住新值。这条归一化只在 store 里做一次，界面不必重复判断。

⚠️ **全局唤起快捷键不在覆盖表里。** 它在 `desktop.hotkey`（Electron accelerator 语法）。
原因是主进程 `globalShortcut` 在冷启动时就要注册，不可能等渲染层把覆盖表合并完。
界面上它仍占一行，但录入器换成 `HotkeyInput`：
两套语义不同（应用内 keydown vs 系统级 accelerator），取值规则也不同
（后者必须带修饰键，且 `Enter` 要写成 `Return`）。

## 7. 有意不做的项

WorkBuddy 的快捷键表里有「放大/缩小/重置内容字号」三条。本项目**没有收录**——

没有一个「内容缩放」能力时，收录这三条只会得到「看着能按、按了没反应」的假菜单项，
而设置界面最不能容忍的就是这种。日后要补，正确做法是 Electron 主进程
`webContents.setZoomFactor`，**不是**根节点 CSS `zoom`：

> 已实测（headless Chrome，1200×800）：`html { zoom: 1.2 }` 下 `height: 100vh` 的元素
> 渲染成 842px（视口 702px），docScrollHeight 同步溢出。Chrome 不为 `zoom` 补偿视口单位。
> 更麻烦的是 MUI 弹窗：`MuiModal-root` 用 `inset: 0` 固定定位，同一机制会让它比视口高 20%，
> 弹窗看起来整体下移。`setZoomFactor` 改的是设备缩放因子，不参与 CSS 布局计算，没有这些问题。

## 8. 不变量（改代码前先读这一条）

1. **新增命令只改 `SHORTCUTS` 一处**，然后按新增命令的 `scope` 接上对应处理器。
   界面、搜索、恢复默认、冲突检查都会自动跟上。
2. **默认键位不得重复**（`tests/shortcuts.test.ts` 有断言）。
   重复意味着「按下后只有先匹配到的那条生效」，另一条永远沉默。
3. **`lib/editor/shortcuts.ts` 里不得出现 DOM 类型**（见 §2），否则主进程类型检查会挂。
4. **改键后必须立即生效**，不允许重启或重新挂载组件才生效——
   键位在事件回调里现取，`tests/globalShortcuts.test.tsx` 锁这一条。
5. **「恢复默认」是删除表项**，不是把默认值写回表里。
