import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/Toast';
import { writeRichClipboard } from '@/lib/editor/richClipboard';
import { clampQuoteText } from '@/lib/editor/selectionQuote';
import { ComposerContextMenu } from './ComposerContextMenu';

/**
 * 消息正文的右键菜单：**剪切 / 复制 / 粘贴 / 全选**。
 *
 * ## 为什么需要它
 *
 * 应用菜单被 `Menu.setApplicationMenu(null)` 置空，Chromium 的原生编辑菜单随之失效
 * ——消息流里右键**什么都不弹**。而「选中一段话 → 右键复制」是极高频的操作。
 *
 * 菜单本体直接复用 `ComposerContextMenu`（纯展示件：只管渲染与回调，不读 store、
 * 不碰 DOM 选区），判定与动作都在这里——只有这里知道消息正文的结构。
 *
 * ## 三条边界
 *
 * 1. **只在正文里响应**：作用域与选区气泡完全一致（`[data-quote-body]`），
 *    过程时间线 / 工具卡片 / 产物卡片里右键不弹。
 * 2. **剪切 / 粘贴置灰**：消息正文是**渲染出来的历史内容**，往里粘东西没有意义，
 *    剪下来的字也没处放。置灰而不是留一个「点了没反应」—— 禁用项还会带上
 *    `title` 说明原因。
 * 3. **文案在右键那一刻定格**：菜单 `autoFocus` 会移动焦点，点「复制」时再去读
 *    `window.getSelection()` 未必还是刚才那段。
 *
 * 监听挂 `document`（同 `SelectionQuoteBubble`）：滚动容器的 ref 经历
 * `null → 元素`（「先无会话、后有会话」时整个消息流重挂载），挂容器的 effect
 * 依赖没变就不会重跑。
 */
export interface MessageTextContextMenuProps {
  /** 消息流的滚动容器：只有落在它内部的右键才响应 */
  rootRef: { current: HTMLDivElement | null };
  /** 当前会话 id：换会话即关闭（菜单锚在「某条消息的某段文字」上） */
  sessionId: string;
}

/** 菜单打开那一刻定格的状态 */
interface MenuState {
  /** 视口锚点（鼠标落点） */
  position: { top: number; left: number };
  /** 定格的选区原文（首尾去空白、超长截断）；无选区时为 `''` */
  text: string;
  /** 该消息的正文容器：「全选」要用它 */
  body: HTMLElement;
}

/** 只读正文的剪切 / 粘贴被置灰时给出的原因 */
const READ_ONLY_HINT = '消息正文是只读的历史内容，不能改写';

export function MessageTextContextMenu({
  rootRef,
  sessionId,
}: MessageTextContextMenuProps) {
  const [state, setState] = useState<MenuState | null>(null);

  useEffect(() => {
    /**
     * 判定右键落点：必须在**正文容器**内；顺带把选区定格下来。
     * 返回 `null` 表示这次右键不关我什么事（连菜单都不弹）。
     */
    const readContext = (
      target: EventTarget | null,
    ): { body: HTMLElement; text: string } | null => {
      const root = rootRef.current;
      if (!root || !(target instanceof Element)) return null;
      if (!root.contains(target)) return null;
      // `closest` 的返回类型是 `Element`，而这里要交给 Range 用（`selectNodeContents`），
      // 断成 `HTMLElement` 才够；带该属性的节点由我们渲染成 div，断言是安全的。
      const body = target.closest('[data-quote-body]') as HTMLElement | null;
      if (!body) return null;

      // 选区必须也在**同一个**正文容器里：否则会出现「在消息 A 上右键、
      // 复制到的却是消息 B 里选中的字」。
      const sel = window.getSelection();
      let text = '';
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        const anchor = range.commonAncestorContainer;
        const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
        if (el && body.contains(el)) text = clampQuoteText(sel.toString());
      }
      return { body, text };
    };

    const onContextMenu = (e: MouseEvent) => {
      const hit = readContext(e.target);
      if (!hit) return;
      // 自己接管：浏览器原生菜单在 Electron 里本来就不弹，但 Web 端会弹，
      // 不拦的话会与我们的菜单同时出现（两份一模一样的条目）。
      e.preventDefault();
      setState({ position: { top: e.clientY, left: e.clientX }, text: hit.text, body: hit.body });
    };
    // fixed 坐标在滚动后立刻失效：直接关掉
    const onScroll = () => setState(null);

    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [rootRef]);

  // 换会话即关闭：菜单锚在「某条消息的某段文字」上，内容换了就指错了
  useEffect(() => {
    setState(null);
  }, [sessionId]);

  const close = useCallback(() => setState(null), []);

  const onCopy = useCallback(() => {
    const text = state?.text ?? '';
    if (!text) return;
    // 复用气泡那条三段降级链路（ClipboardItem → writeText → execCommand）
    void writeRichClipboard(text, JSON.stringify({ rich: text, attachments: [] }), false).then(
      (ok) => {
        if (ok) toast.success('已复制');
        else toast.error('复制失败');
      },
    );
  }, [state]);

  const onSelectAll = useCallback(() => {
    const body = state?.body;
    if (!body) return;
    // 不用 `execCommand('selectAll')`：那会选中**整个文档**，而不是这条消息
    const range = document.createRange();
    range.selectNodeContents(body);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    setState(null);
  }, [state]);

  /**
   * 置灰项的动作占位。
   *
   * 菜单不会把它们派发出来（见 `ComposerContextMenu` 的「禁用项不挂 onClick」契约），
   * 这里给的不是空实现而是可见反馈 —— 万一哪天有人把 enabled 打开，
   * 得到的是一条提示而不是「点了没反应」。
   */
  const unreachable = useCallback(
    (name: string) => () => toast.error(`${name}：${READ_ONLY_HINT}`),
    [],
  );

  return (
    <ComposerContextMenu
      position={state?.position ?? null}
      // `canEdit` 在输入区表示「有可剪贴的选区」，这里借它表达同一件事：
      // 有选区才让「复制」可用
      canEdit={!!state?.text}
      canCut={false}
      canPaste={false}
      readOnlyHint={READ_ONLY_HINT}
      onClose={close}
      onCut={unreachable('剪切')}
      onCopy={onCopy}
      onPaste={unreachable('粘贴')}
      onSelectAll={onSelectAll}
    />
  );
}