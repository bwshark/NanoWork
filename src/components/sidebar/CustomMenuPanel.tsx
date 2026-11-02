/**
 * 「自定义菜单栏」面板：一级菜单与「更多」二级菜单的**拖拽排序**。
 *
 * ## 为什么不用拖拽库
 *
 * 项目依赖里没有任何 dnd 库（`package.json` 只有 MUI / zustand / router）。
 * 为了一个两列表格的排序去引 `@dnd-kit` 或 `react-beautiful-dnd`，等于把整条
 * 打包链和版本矩阵为这一个面板抬上去。这里用原生 pointer 事件 + 一次布局快照，
 * 全部逻辑压在 `lib/ui/sidebarMenu` 的三个纯函数里，可单独测。
 *
 * ## 拖拽为什么是「实时重排」而不是「浮层跟手」
 *
 * 参考视频里被拖的那一行**原地不动**、其余行当场让位 —— 这比「影子跟手」
 * 简单且更不容易错位：没有浮层就不需要同步它的 transform，也就不存在
 * 「松手瞬间跳一下」的收尾问题。代价是被拖行自己不跟手，但指针位置由
 * `pointermove` 的坐标独立驱动，视觉上仍然是「跟着鼠标走」。
 *
 * ## 为什么 `pointerdown` 就 `preventDefault`
 *
 * 行是 `<button>` 一类可聚焦元素。不 `preventDefault` 的话，按下手柄时浏览器会
 * 顺手开始选词 / 拖拽原生 DnD（Electron 里会把整行拖成幽灵图），`pointermove`
 * 的事件流会被原生拖拽截断 —— 表现是「拖到一半就不动了」。
 *
 * ## 为什么用 `setPointerCapture`
 *
 * 指针一旦移出弹窗（甚至移出窗口），事件就会落到别的元素上，`pointerup` 收不到，
 * 于是拖拽状态永远不结束、面板卡在「一直有个行被抬起」。捕获之后所有事件都
 * 回到手柄本身，松手必达。jsdom 里没有这个 API（`setPointerCapture` 是
 * `undefined`），所以必须做存在性判断，否则测试环境直接抛 TypeError。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Button, Dialog, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { useSettingsStore } from '@/stores/settingsStore';
import { MORE_MENU_IDS, PRIMARY_MENU_IDS, dropInsertIndex, moveMenuItem } from '@/lib/ui/sidebarMenu';
import type { MoreMenuId, PrimaryMenuId } from '@/lib/ui/sidebarMenu';

/** 面板里一行菜单的展示信息（文案 + 图标由调用方给，本组件不关心业务含义） */
export interface MenuPanelRow {
  label: string;
  icon: ReactNode;
}

/** 一级菜单一行的展示信息，按 id 索引 */
export type PrimaryMenuLabels = Record<PrimaryMenuId, MenuPanelRow>;
/** 「更多」二级菜单一行的展示信息，按 id 索引 */
export type MoreMenuLabels = Record<MoreMenuId, MenuPanelRow>;

interface CustomMenuPanelProps {
  open: boolean;
  onClose: () => void;
  primary: PrimaryMenuLabels;
  more: MoreMenuLabels;
}

/**
 * 一次拖拽的**布局快照**。
 *
 * 三个量全部在 `pointerdown` 时定格，拖拽过程中不再重算 —— 这正是「不抖」的来源：
 * 重排会改变各行的实际位置，若边拖边读位置，判据就跟着结果一起变。
 */
interface DragSession {
  id: string;
  /** 这一行属于哪一段。落库时**只提交这一段**，见下方 `commit` 注释 */
  section: 'primary' | 'more';
  /** 被拖行在快照时的下标 */
  from: number;
  /** 列表顶部的视口纵坐标 */
  listTop: number;
  /** 行距（行高 + 空隙） */
  pitch: number;
  /** 行数（用于把下标夹在范围内） */
  count: number;
}

/** 行间距（px）。`readPitch` 与样式两处共用这一个常量，避免「改了样式忘了算法」 */
const ROW_GAP = 8;

/** 行距：行高 + 行间距。读不到（jsdom 无布局）时给 0，由 `dropInsertIndex` 兜住 */
function readPitch(rowEl: HTMLElement): number {
  const height = rowEl.getBoundingClientRect().height;
  return height > 0 ? height + ROW_GAP : 0;
}

/**
 * 一段可拖拽排序的菜单列表。
 *
 * 单独抽出来（而不是在面板里写两遍）的原因：一级菜单与「更多」是**同一套交互**，
 * 写两遍就一定会有一天只改了一边 —— 那种不一致只有用户能碰到。
 *
 * `sectionKey` 挂在根节点上供测试 / 调试定位这一段。用 `data-*` 而不是找标题文案：
 * 分组标题（「更多」）与菜单项文案可能撞车，靠文案定位会取到错的那一段。
 */
function SortableMenuSection({
  sectionKey,
  title,
  ids,
  labels,
  draggingId,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  /** 机器可读的分组标识（`primary` / `more`），只用于定位，不显示 */
  sectionKey: string;
  title: string;
  ids: readonly string[];
  labels: Record<string, MenuPanelRow>;
  /** 当前被抬起的行 id（一级 / 更多两段共用一个，同一时刻只可能有一个） */
  draggingId: string | null;
  onDragStart: (session: DragSession) => void;
  onDragMove: (event: React.PointerEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  return (
    <Box sx={{ mb: 2 }} data-menu-section={sectionKey}>
      <Typography
        sx={{
          px: 0.5,
          pb: 1,
          fontSize: 12.5,
          fontWeight: 700,
          color: 'text.primary',
        }}
      >
        {title}
      </Typography>
      <Box
        ref={listRef}
        sx={{ display: 'flex', flexDirection: 'column', gap: `${ROW_GAP}px` }}
      >
        {ids.map((id, index) => {
          const row = labels[id];
          // 表里缺这一项的展示信息 = 编码错误。渲染成一行显眼的提示而不是
          // 静默跳过：静默跳过会让「菜单少了一项」表现成「用户自己删掉了」。
          if (!row) {
            return (
              <Typography key={id} sx={{ fontSize: 12.5, color: 'error.main' }}>
                菜单项缺少展示信息：{id}
              </Typography>
            );
          }
          const active = draggingId === id;
          return (
            <Box
              key={id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.5,
                height: 44,
                borderRadius: 2,
                bgcolor: 'action.hover',
                // 被抬起：底色提亮 + 描边 + 轻微阴影，与参考视频的观感一致
                ...(active
                  ? {
                      bgcolor: 'action.selected',
                      outline: '1px solid',
                      outlineColor: 'text.secondary',
                      boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
                      cursor: 'grabbing',
                    }
                  : {}),
                // 拖拽期间禁掉文本选中：否则整段文案会被反蓝
                userSelect: draggingId ? 'none' : 'auto',
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  color: 'text.secondary',
                  fontSize: 18,
                  '& svg': { fontSize: 'inherit' },
                }}
              >
                {row.icon}
              </Box>
              <Typography
                data-menu-row-label={id}
                sx={{ flex: 1, fontSize: 13, fontWeight: 500 }}
              >
                {row.label}
              </Typography>
              <IconButton
                size="small"
                aria-label={`拖动「${row.label}」调整顺序`}
                // `data-drag-handle` 让指针事件只挂在手柄上：整行都能拖会让
                // 「点一下行」和「按住拖动」这两个意图打架，而这里没有「点行」的语义
                data-drag-handle={id}
                onPointerDown={(e) => {
                  const rowEl = e.currentTarget.parentElement as HTMLElement | null;
                  const listEl = listRef.current;
                  if (!rowEl || !listEl) return;
                  e.preventDefault();
                  // jsdom 没有指针捕获（见文件头注释），必须判存在
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  onDragStart({
                    id,
                    section: sectionKey as 'primary' | 'more',
                    from: index,
                    listTop: listEl.getBoundingClientRect().top,
                    pitch: readPitch(rowEl),
                    count: ids.length,
                  });
                }}
                onPointerMove={onDragMove}
                onPointerUp={onDragEnd}
                onPointerCancel={onDragEnd}
                sx={{
                  p: 0.25,
                  color: 'text.disabled',
                  cursor: 'grab',
                  '&:hover': { color: 'text.secondary', bgcolor: 'transparent' },
                }}
              >
                <DragIndicatorIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

/** 「自定义菜单栏」对话框（侧边栏「更多」浮层底部那一项打开的） */
export function CustomMenuPanel({ open, onClose, primary, more }: CustomMenuPanelProps) {
  const primaryMenuOrder = useSettingsStore((s) => s.settings.primaryMenuOrder);
  const moreMenuOrder = useSettingsStore((s) => s.settings.moreMenuOrder);
  const setMenuOrder = useSettingsStore((s) => s.setMenuOrder);

  /**
   * 面板里的**工作副本**：拖拽过程中实时重排的就是它。
   *
   * 不直接改 store 的原因：一次拖拽会产生几十次 `pointermove`，每次都写 store 会
   * 连带 bump 同步元数据（`rev` 涨几十），同步层于是把「拖动一下」当成几十次编辑
   * 推送出去。所以拖动只改本地，**松手时才落库一次**。
   */
  const [draftPrimary, setDraftPrimary] = useState<PrimaryMenuId[]>(() =>
    Array.from(PRIMARY_MENU_IDS),
  );
  const [draftMore, setDraftMore] = useState<MoreMenuId[]>(() => Array.from(MORE_MENU_IDS));

  // 打开时把 store 里的顺序读进工作副本：面板是「每次打开重新开始编辑」的语义，
  // 关掉不保存就等于放弃这次修改（参考视频里也没有「保存」按钮）
  useEffect(() => {
    if (!open) return;
    setDraftPrimary(
      (primaryMenuOrder?.length ? primaryMenuOrder : PRIMARY_MENU_IDS) as PrimaryMenuId[],
    );
    setDraftMore(
      (moreMenuOrder?.length ? moreMenuOrder : MORE_MENU_IDS) as MoreMenuId[],
    );
  }, [open, primaryMenuOrder, moreMenuOrder]);

  const [drag, setDrag] = useState<DragSession | null>(null);

  /**
   * 拖拽会话的**真值**。
   *
   * 不放进 state 的原因：`pointermove` 每帧都要读它算目标下标，而 `setDrag`
   * 是异步提交的 —— 同一帧内连发两个 move 事件时，第二个读到的还是旧会话，
   * 会重复算一次同一个位移。ref 是同步的，不存在这个窗口。
   * `drag` state 只负责「画面」（哪一行抬起），两份各管一件事。
   */
  const dragRef = useRef<DragSession | null>(null);
  /** 本次拖拽是否真的移动过：没移动就不落库（否则「按一下手柄」也算一次修改） */
  const movedRef = useRef(false);
  /** 上一帧的 drag 值，用来识别「刚刚结束了一次拖拽」这个边沿 */
  const prevDragRef = useRef<DragSession | null>(null);

  /**
   * 松手后落库。
   *
   * 挂在 `drag → null` 这个**边沿**上而不是「draft 变化」上：draft 在拖动过程中
   * 会变几十次，若监听它，一次拖动就会写几十次 store（连带 bump 几十次同步 rev，
   * 对端会收到几十条编辑）。边沿触发则一次拖动只写一次。
   *
   * ⚠️ **只提交被拖的那一段**。曾经两段都传，结果「只拖了『更多』」会把一级菜单的
   * 默认顺序也写进持久化 —— 语义上从「用户没调过、以后跟着默认顺序走」变成
   * 「用户调成了当前这个样子」，日后调整默认顺序老用户就收不到了。
   * 这正是 `shortcuts` / `primaryMenuOrder` 默认值那两处注释反复强调的同一个坑，
   * 只是这次是从写入侧漏出去的。
   */
  useEffect(() => {
    const prev = prevDragRef.current;
    prevDragRef.current = drag;
    if (!prev || drag !== null) return;
    if (!movedRef.current) return;
    movedRef.current = false;
    setMenuOrder(
      prev.section === 'primary'
        ? { primary: draftPrimary }
        : { more: draftMore },
    );
  }, [drag, draftPrimary, draftMore, setMenuOrder]);

  const handleDragStart = useCallback((session: DragSession) => {
    dragRef.current = session;
    movedRef.current = false;
    setDrag(session);
  }, []);

  /** 指针移动：按快照几何算出目标下标，变了就当场重排 */
  const handleDragMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const cur = dragRef.current;
    if (!cur) return;
    const target = dropInsertIndex(e.clientY, cur.listTop, cur.pitch, cur.count);
    // -1 = 行距还没测量出来（jsdom 无布局 / 首帧），这一帧不动
    if (target < 0 || target === cur.from) return;
    // 两个列表是各自独立的：靠 id 是否属于一级菜单来分流
    const inPrimary = (PRIMARY_MENU_IDS as readonly string[]).includes(cur.id);
    if (inPrimary) {
      setDraftPrimary((list) => moveMenuItem(list, cur.from, target));
    } else {
      setDraftMore((list) => moveMenuItem(list, cur.from, target));
    }
    // `from` 跟着目标走：下一次移动要基于「已经挪过去之后」的位置算
    dragRef.current = { ...cur, from: target };
    movedRef.current = true;
  }, []);

  /** 松手 / 取消：只清会话，落库交给上面那个边沿 effect */
  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDrag(null);
  }, []);

  const draggingId = drag?.id ?? null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      PaperProps={{
        sx: {
          width: 620,
          maxWidth: '94vw',
          maxHeight: '88vh',
          borderRadius: 2,
          // 参考图：面板自己是深一档的底，行是提亮的一档 —— 行比底更亮才「浮起来」
          bgcolor: 'background.default',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        },
      }}
      aria-label="自定义菜单栏"
    >
      {/* 标题栏：标题居中、关闭按钮靠右（与参考图一致） */}
      <Box
        sx={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          px: 2,
          py: 2,
          flexShrink: 0,
        }}
      >
        <Typography sx={{ fontSize: 15, fontWeight: 700 }}>自定义菜单栏</Typography>
        <IconButton
          size="small"
          aria-label="关闭自定义菜单栏"
          onClick={onClose}
          sx={{ position: 'absolute', right: 12, color: 'text.secondary' }}
        >
          <CloseIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3, pb: 2 }}>
        <SortableMenuSection
          sectionKey="primary"
          title="一级菜单"
          ids={draftPrimary}
          labels={primary}
          draggingId={draggingId}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={endDrag}
        />
        <SortableMenuSection
          sectionKey="more"
          title="更多"
          ids={draftMore}
          labels={more}
          draggingId={draggingId}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={endDrag}
        />
      </Box>

      {/* 底部只有一句说明 + 恢复默认：面板没有「保存」按钮，松手即生效 */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 3,
          py: 1.5,
          borderTop: '1px solid',
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <Typography sx={{ flex: 1, fontSize: 12, color: 'text.secondary' }}>
          按住右侧手柄拖动即可调整顺序，松手后自动生效
        </Typography>
        <Button
          size="small"
          onClick={() => {
            setDraftPrimary(Array.from(PRIMARY_MENU_IDS));
            setDraftMore(Array.from(MORE_MENU_IDS));
            // 恢复默认必须**立刻落库**：它没有「松手」这个动作可依托
            setMenuOrder({
              primary: Array.from(PRIMARY_MENU_IDS),
              more: Array.from(MORE_MENU_IDS),
            });
          }}
          sx={{ fontSize: 12, color: 'text.secondary', minWidth: 0 }}
        >
          恢复默认
        </Button>
      </Box>
    </Dialog>
  );
}
