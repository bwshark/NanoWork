import { Menu, MenuItem } from "@mui/material";
import type { Theme } from "@mui/material";

/**
 * 输入区右键上下文菜单：剪切 / 复制 / 粘贴 / 全选。
 *
 * ## 为什么自己做一个，而不走系统原生菜单
 *
 * 应用菜单被 `Menu.setApplicationMenu(null)` 置空，右键默认什么都不弹；而且
 * Chromium 的原生编辑菜单对输入区里的**内联附件徽章**一无所知 —— 它看不见
 * `data-att-id` 的 span，剪贴只会带走旁边的文字，附件会静默丢掉。这个菜单的每
 * 一项都接回 Composer 已有的富编辑能力（`copySelection` / `deleteSelection` /
 * `insertRichClipboard`），徽章与其对应附件才能跟着一起走。
 *
 * ## 边界
 *
 * 本组件只负责**渲染与回调**：不读 store、不碰 DOM 选区。到底选中了什么、
 * 能不能剪，都由 Composer 在右键那一刻判定好传进来 —— 菜单是纯展示件，
 * 判定逻辑留在唯一知道输入区内部结构的地方。
 */
export interface ComposerContextMenuProps {
  /** 视口坐标锚点；`null` = 菜单关闭 */
  position: { top: number; left: number } | null;
  /** 输入区内此刻有可剪贴的选区（剪切 / 复制可用） */
  canEdit: boolean;
  /**
   * 剪切是否可用；缺省跟随 `canEdit`。
   *
   * 单拎出来是因为**只读场景**（消息正文）：那里复制有意义，剪切没有 ——
   * 剪下来的字往哪儿放？置灰比留一个「点了没反应」好。
   */
  canCut?: boolean;
  /**
   * 粘贴是否可用；缺省 `true`（输入区总能粘贴）。
   * 只读正文传 `false`：往渲染出来的历史消息里粘东西没有意义。
   */
  canPaste?: boolean;
  /** 剪切 / 粘贴被置灰时的原因（挂到禁用项的 title 上，要说清为什么不能） */
  readOnlyHint?: string;
  onClose: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
}

/** 单项定义：文案 + 是否可用 + 动作 */
interface ItemDef {
  label: string;
  enabled: boolean;
  run: () => void;
  /** 禁用原因（仅在禁用时有意义） */
  hint?: string;
}

export function ComposerContextMenu({
  position,
  canEdit,
  canCut,
  canPaste,
  readOnlyHint,
  onClose,
  onCut,
  onCopy,
  onPaste,
  onSelectAll,
}: ComposerContextMenuProps) {
  /**
   * 先关菜单、再执行动作。
   *
   * 动作会 focus 输入区（并可能异步读剪贴板）；让菜单先退场，它的 backdrop
   * 才不会在动作进行时还压在最上层。
   */
  const fire = (run: () => void) => () => {
    onClose();
    run();
  };

  const cutEnabled = canCut ?? canEdit;
  const pasteEnabled = canPaste ?? true;

  const items: ItemDef[] = [
    // 没有选区时置灰，而不是「点了没反应」—— 与系统原生编辑菜单一致
    { label: "剪切", enabled: cutEnabled, run: onCut, hint: readOnlyHint },
    { label: "复制", enabled: canEdit, run: onCopy },
    { label: "粘贴", enabled: pasteEnabled, run: onPaste, hint: readOnlyHint },
    { label: "全选", enabled: true, run: onSelectAll },
  ];

  return (
    <Menu
      open={position !== null}
      onClose={onClose}
      // 右键菜单锚在鼠标落点而非某个元素上：没有 anchorEl，用 anchorPosition
      anchorReference="anchorPosition"
      anchorPosition={position ?? undefined}
      // 菜单自己要能接键盘（↑↓ / Enter / Esc）
      autoFocus
      /**
       * 关掉 MUI 的焦点恢复：它会把焦点还给「打开菜单前聚焦的元素」，
       * 那次聚焦发生在动作之后，会把我们刚放进输入区的光标又抢走。
       * 各动作内部都显式 `root.focus()`，不需要它代劳。
       */
      disableRestoreFocus
      slotProps={{
        paper: {
          sx: {
            minWidth: "132px",
            py: 0.5,
            // 必须带单位：sx 会把裸数字的 borderRadius 乘一遍 theme.shape.borderRadius
            borderRadius: "10px",
            border: "1px solid",
            borderColor: "divider",
            boxShadow: (theme: Theme) => theme.shadows[6],
          },
        },
      }}
    >
      {items.map((item) => (
        <MenuItem
          key={item.label}
          disabled={!item.enabled}
          /**
           * 禁用项**不挂** onClick。
           *
           * 只靠 `disabled` 的颜色 / `pointer-events: none` 是不够的：那是一层
           * CSS，程序化派发的 click 照样能穿过去触发动作。而这里禁掉的是
           * 「无选区却执行剪切」这类会改数据的操作，契约要落在代码里。
           */
          onClick={item.enabled ? fire(item.run) : undefined}
          // 禁用项要说清为什么不能，否则用户只会以为坏了
          title={item.enabled ? undefined : item.hint}
          sx={{ fontSize: 13.5, minHeight: 34, px: 1.5, py: 0.5 }}
        >
          {item.label}
        </MenuItem>
      ))}
    </Menu>
  );
}
