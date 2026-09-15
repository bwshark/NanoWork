import type { ComposerApi } from '@/pages/chat/Composer';

/**
 * 标题栏「编辑」菜单 ↔ 输入框 的轻量桥接。
 *
 * Composer 挂载时把自己的命令式编辑 API 注册进来，TitleBar 的「编辑」菜单
 * 借此调用（撤销/重做必须走 Composer 自管的快照栈，浏览器原生 execCommand
 * 对手动插入的附件徽章无效）。用模块级单例而非把 ref 从 ChatPage 一路透传到
 * AppLayout —— 单窗口应用下足够，且不破坏组件树。
 */
let current: ComposerApi | null = null;

/** Composer 挂载时注册、卸载时置空 */
export function registerComposerEdit(api: ComposerApi | null): void {
  current = api;
}

/** 标题栏菜单读取当前生效的输入框编辑 API（无输入框时为 null） */
export function getComposerEdit(): ComposerApi | null {
  return current;
}
