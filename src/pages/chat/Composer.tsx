import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Box,
  Chip,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import type { Theme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import SendIcon from "@mui/icons-material/Send";
import StopIcon from "@mui/icons-material/Stop";
import KeyboardVoiceIcon from "@mui/icons-material/KeyboardVoice";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CloseIcon from "@mui/icons-material/Close";
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import CompressIcon from "@mui/icons-material/Compress";
import TuneIcon from "@mui/icons-material/Tune";
import NoteAddIcon from "@mui/icons-material/NoteAdd";
import GroupsIcon from "@mui/icons-material/Groups";
import {
  useSessionsStore,
  selectSessionStreamStatus,
} from "@/stores/sessionsStore";
import { useAgentsStore } from "@/stores/agentsStore";
import { useExpertGroupsStore } from "@/stores/expertGroupsStore";
import { useSkillsStore } from "@/stores/skillsStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useModelsStore, describeModelId } from "@/stores/modelsStore";
import { ComposerMenu } from "./ComposerMenu";
import { ComposerControls } from "@/components/ComposerControls";
import { InlineAttachmentChip } from "@/components/composer/InlineAttachmentChip";
import {
  SlashCommandPicker,
  type SlashCommandItem,
} from "@/components/composer/SlashCommandPicker";
import {
  FileReferencePicker,
  type FileRefItem,
} from "@/components/composer/FileReferencePicker";
import { useVoiceInput, formatDuration } from "@/hooks/useVoiceInput";
import {
  MAX_ATTACHMENT_COUNT,
  fileToAttachment,
  formatBytes,
  rehydrateAttachment,
  revokeAttachmentPreview,
} from "@/lib/attachments";
import { genId } from "@/lib/id";
// 触发符判定是纯函数，已抽到 lib 便于单测；此处再导出一次，保持旧引用路径可用
import { detectTrigger, type TriggerState } from "@/lib/composerTrigger";
import {
  extractEditableText,
  extractEditableRichText,
  extractSelectionText,
  extractSelectionRichText,
  selectionChipIds,
  deleteSelection,
  editableCaretOffset,
  hasSelectionInside,
  replaceEditableRange,
  placeCaretAtEnd,
  clearEditableContent,
  normalizeEditableEmpty,
  replaceEditableTextKeepChips,
  splitRichContent,
  insertNodeAtSelection,
  captureSnapshot,
  restoreSnapshot,
  collectChipSpans,
  type EditSnapshot,
  RICH_CLIP_MIME,
} from "@/lib/editableText";
import { peekRichPayload, writeRichClipboard } from "@/lib/richClipboard";
import { registerComposerEdit } from "@/lib/composerEditBridge";
import {
  createUndoStack,
  pushSnapshot,
  undo as undoStack,
  redo as redoStack,
  canUndo,
  canRedo,
  resetStack,
  type UndoStack,
} from "@/lib/undoStack";
import { toast } from "@/components/Toast";
import type { Attachment, AttachmentKind } from "@/types";

export { detectTrigger, type TriggerState } from "@/lib/composerTrigger";

/** 父组件可调用的输入框命令式 API（如点击提示词标签后聚焦输入框） */
export interface ComposerApi {
  focus: () => void;
  /** 撤销一步（走自管快照栈，能还原手动插入的附件徽章） */
  undo: () => void;
  /** 重做一步 */
  redo: () => void;
  /** 选中输入区全部内容 */
  selectAll: () => void;
}

/** 空状态「模式 Skill」徽章：显示在输入框内、可删除 */
export interface ComposerHeroSkill {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

/** 附件大类中文名（@ 引用浮层的副标题用） */
const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "图片",
  document: "文档",
  text: "文本",
  video: "视频",
  audio: "音频",
  other: "文件",
};

/** `/compact` 指令插入的压缩提示词 */
const COMPACT_PROMPT =
  "请压缩并总结以上对话，保留关键结论、待办事项与未决问题：";

/**
 * 输入区：WorkBuddy 风格大圆角输入框 + 加号菜单 + Agent/模型选择 + 发送。
 *
 * 富输入能力：
 * - 附件：加号菜单选择 / 粘贴图片 / 拖拽文件 → 光标处内联徽章 → 随消息上传；
 * - `/`：技能与内置指令浮层（↑↓ + Enter 选中，Esc 关闭）；
 * - `@`：引用本会话已出现的文件（附件 + 产物）；
 * - 语音：需先在「设置 → 语音输入」配置转录服务，未配置时按钮禁用。
 */
export function Composer({
  placeholder = "今天帮你做些什么？",
  variant = "floating",
  value,
  onValueChange,
  heroSkill,
  onHeroSkillRemove,
  apiRef,
}: {
  placeholder?: string;
  variant?: "hero" | "floating";
  /** 受控文本：传入后输入内容由父组件管理（空状态三级联动用） */
  value?: string;
  onValueChange?: (v: string) => void;
  /** 当前选中的模式 Skill：在输入框内以可删除徽章展示 */
  heroSkill?: ComposerHeroSkill | null;
  onHeroSkillRemove?: (id: string) => void;
  /** 暴露 focus 等命令式能力给父组件 */
  apiRef?: React.MutableRefObject<ComposerApi | null>;
}) {
  const [internalText, setInternalText] = useState("");
  const controlled = value !== undefined;
  const text = controlled ? value : internalText;
  /**
   * 输入区最近一次主动向外发出的文本。
   * 受控模式下用以区分「onInput 回声」（相等，跳过 DOM 写回）
   * 与「外部受控写入」（不等，如点击提示词标签，需写回 DOM）。
   */
  const lastEmittedRef = useRef("");
  /** 文本镜像：仅供发送载荷 / 按钮态；editable DOM 才是真源 */
  const emitText = useCallback(
    (next: string) => {
      lastEmittedRef.current = next;
      if (controlled) onValueChange?.(next);
      else setInternalText(next);
    },
    [controlled, onValueChange],
  );
  const send = useSessionsStore((s) => s.send);
  const abort = useSessionsStore((s) => s.abort);
  const activeSessionId = useSessionsStore((s) => s.activeId);
  // 仅订阅「当前会话」的流式状态：其他会话流式互不影响，可多任务并行
  const streamStatus = useSessionsStore((s) =>
    selectSessionStreamStatus(s, s.activeId),
  );
  const isStreaming = streamStatus !== "idle";
  const activeSession = useSessionsStore((s) =>
    activeSessionId
      ? s.sessions.find((x) => x.id === activeSessionId)
      : undefined,
  );
  const updateSession = useSessionsStore((s) => s.updateSession);

  const agents = useAgentsStore((s) => s.agents);
  const activeAgentId = useAgentsStore((s) => s.activeAgentId);
  const setActiveAgent = useAgentsStore((s) => s.setActiveAgent);

  const groups = useExpertGroupsStore((s) => s.groups);
  const activeGroupId = useExpertGroupsStore((s) => s.activeGroupId);
  const setActiveGroup = useExpertGroupsStore((s) => s.setActiveGroup);

  const skills = useSkillsStore((s) => s.skills);

  // 当前生效 Agent：优先取当前会话绑定的 agentId，否则回退全局 activeAgentId
  const effectiveAgentId = activeSession?.agentId ?? activeAgentId ?? "";
  const effectiveAgent = agents.find((a) => a.id === effectiveAgentId);

  // 当前生效专家团：优先取当前会话绑定的 groupId，否则回退全局 activeGroupId
  //（与召唤专家团逻辑对齐；团已被删除时回退专家模式）
  const effectiveGroupId = activeSession?.groupId ?? activeGroupId ?? null;
  const effectiveGroup = effectiveGroupId
    ? groups.find((g) => g.id === effectiveGroupId)
    : undefined;

  // 当前会话挂载的技能（已启用且存在）
  const activeSkillIds = activeSession?.skillIds ?? [];
  const activeSkills = activeSkillIds
    .map((id) => skills.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s && s.enabled);

  /** contentEditable 输入区：文本与附件徽章可在光标处混排（徽章经 portal 挂载） */
  const editableRef = useRef<HTMLDivElement>(null);
  /** 徽章容器 span（attachment id 索引）：portal 目标，同时供抽取/退格同步识别 */
  const chipSpans = useRef<Map<string, HTMLSpanElement>>(new Map());
  /** 输入框卡片：作为触发浮层的锚点，同时承担拖拽落区 */
  const cardRef = useRef<HTMLDivElement>(null);
  /** 模型 Chip：/model 指令需要定位到它才能弹出模型菜单 */
  const modelChipRef = useRef<HTMLDivElement>(null);

  // —— 附件 ——
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  /** 当前附件快照：供「卸载清理」「数量校验」在不重建回调的前提下读取 */
  const attachmentsRef = useRef<Attachment[]>([]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // —— 撤销 / 重做（快照式，见 src/lib/undoStack.ts 的选型说明）——
  /**
   * 一个快照 = DOM 结构 + 附件状态。
   * 附件数组存引用即可：`Attachment` 创建后不再修改，且**删除附件时不立即释放
   * objectURL**（否则撤销回来图片会失效），统一在发送成功后释放。
   */
  interface ComposerSnapshot {
    edit: EditSnapshot;
    attachments: Attachment[];
  }
  /** 用 ref 保存：撤销/重做只响应快捷键，不需要触发重渲染 */
  const undoRef = useRef<UndoStack<ComposerSnapshot>>(
    createUndoStack<ComposerSnapshot>({
      edit: { html: "", rich: "", caret: 0 },
      attachments: [],
    }),
  );

  /**
   * 捕获当前输入区快照（DOM + 附件）。
   * @param attachmentsOverride 结构性变更（增删附件）时，附件 state 是异步提交的，
   *   此刻 ref 尚未更新，调用方传入「变更后」的数组以确保快照里的 attachments 正确。
   */
  const captureNow = useCallback(
    (attachmentsOverride?: Attachment[]): ComposerSnapshot => {
      const root = editableRef.current;
      return {
        edit: root ? captureSnapshot(root) : { html: "", rich: "", caret: 0 },
        attachments: attachmentsOverride ?? attachmentsRef.current,
      };
    },
    [],
  );

  /**
   * 记录一次可撤销的变更。
   * @param coalesceMs 合并窗口：连续输入传 500（避免每字符一个快照）；
   *   结构性变更（粘贴 / 插入删除附件 / 剪贴）传 0 强制入栈。
   * @param attachmentsOverride 见 captureNow。
   */
  const pushUndo = useCallback(
    (coalesceMs: number, attachmentsOverride?: Attachment[]) => {
      undoRef.current = pushSnapshot(
        undoRef.current,
        captureNow(attachmentsOverride),
        { coalesceMs },
      );
    },
    [captureNow],
  );

  /** 聚焦输入区；选区不在区内时把光标放到末尾 */
  const focusEditable = useCallback(() => {
    const root = editableRef.current;
    if (!root) return;
    root.focus();
    if (!hasSelectionInside(root)) placeCaretAtEnd(root);
  }, []);

  /** 选中输入区全部内容（TitleBar「编辑 → 全选」复用） */
  const selectAllComposer = useCallback(() => {
    const root = editableRef.current;
    if (!root) return;
    root.focus();
    const range = document.createRange();
    range.selectNodeContents(root);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);

  /** 生成徽章容器 span（portal 目标 + 抽取/同步标记） */
  const makeChipSpan = useCallback((a: Attachment) => {
    const span = document.createElement("span");
    span.dataset.attId = a.id;
    // 不可编辑岛：光标整体跳过、Backspace 整体删除
    span.contentEditable = "false";
    chipSpans.current.set(a.id, span);
    return span;
  }, []);

  /** 徽章插入当前光标处；选区不在输入区内时追加到末尾 */
  const insertChipAtCaret = useCallback((span: HTMLSpanElement) => {
    const root = editableRef.current;
    if (!root) return;
    const sel = window.getSelection();
    if (
      sel &&
      sel.rangeCount > 0 &&
      root.contains(sel.getRangeAt(0).startContainer)
    ) {
      const range = sel.getRangeAt(0);
      range.insertNode(span);
      range.setStartAfter(span);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      root.appendChild(span);
      placeCaretAtEnd(root);
    }
  }, []);

  // —— `/` 与 `@` 触发浮层 ——
  const [trigger, setTrigger] = useState<TriggerState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  /**
   * 选中候选项后的「抑制检测」开关。
   * 选中时 DOM 里的旧文本尚未随 React state 更新，紧接着的 keyup 会按旧值
   * 重新判定出触发态、把刚关掉的浮层又弹回来；置位后在下次真实输入前不再检测。
   */
  const suppressTriggerRef = useRef(false);

  /** 语音转录配置（来自设置；未启用时语音按钮禁用，不申请麦克风权限） */
  const transcription = useSettingsStore((s) => s.settings.transcription);
  const voiceReady =
    transcription?.enabled === true && transcription.model.trim() !== "";

  // 命令式编辑 API（focus / undo / redo / selectAll）的注册见 doRedo 之后的 effect，
  // 因 undo/redo 依赖其下方定义的 doUndo/doRedo，需延迟到这些回调就绪后再注册。

  // 外部受控写入（如点击提示词标签整体替换输入）：与 onInput 回声用 lastEmitted 区分
  useEffect(() => {
    if (!controlled || value === undefined) return;
    if (value === lastEmittedRef.current) return;
    const root = editableRef.current;
    if (!root) return;
    replaceEditableTextKeepChips(root, value);
    lastEmittedRef.current = value;
    // 结构性替换入栈一步：撤销可回退到替换前
    pushUndo(0);
  }, [controlled, value, pushUndo]);

  // 卸载时释放所有 object URL，避免大图预览长期占内存。
  // 撤销栈快照可能仍引用「已删除但未发送」的附件，一并释放。
  useEffect(
    () => () => {
      const seen = new Set<string>();
      const revoke = (a: Attachment) => {
        if (seen.has(a.id)) return;
        seen.add(a.id);
        revokeAttachmentPreview(a);
      };
      attachmentsRef.current.forEach(revoke);
      const { past, present, future } = undoRef.current;
      [...past, present, ...future].forEach((s) =>
        s.attachments.forEach(revoke),
      );
    },
    [],
  );

  /** 同步触发态（输入 / 光标移动 / 点击后调用） */
  const syncTrigger = useCallback((next: string, caret: number) => {
    if (suppressTriggerRef.current) return;
    setTrigger(detectTrigger(next, caret));
  }, []);

  /** 关闭浮层并复位高亮 */
  const closePicker = useCallback(() => {
    // 关闭后必须抑制一次触发检测：否则同一次按键的 keyup（以及后续的 onClick / onFocus）
    // 会立刻重新读到文本里仍然存在的 `/`，把刚关掉的浮层又弹回来 —— 这就是「Esc 关不掉」的根因。
    // 下一次真实输入会由 onInput 把标记复位，于是可以正常再次唤出。
    suppressTriggerRef.current = true;
    setTrigger(null);
    setActiveIndex(0);
  }, []);

  // —— 文本区间替换：统一承担「删除触发词」「插入引用/转写文本」——
  const replaceRange = useCallback(
    (start: number, end: number, snippet: string) => {
      const root = editableRef.current;
      if (!root) return;
      replaceEditableRange(root, start, end, snippet);
      root.focus();
      const next = extractEditableText(root);
      emitText(next);
      syncTrigger(next, editableCaretOffset(root));
    },
    [emitText, syncTrigger],
  );

  /** 在当前光标处插入文本（语音转写 / 引用标记 / 纯文本粘贴） */
  const insertAtCaret = useCallback(
    (snippet: string) => {
      const root = editableRef.current;
      if (!root) return;
      const caret = editableCaretOffset(root);
      replaceRange(caret, caret, snippet);
      // 程序化插入不会触发 onInput，需手动入栈（强制一步，不合并）
      pushUndo(0);
    },
    [replaceRange, pushUndo],
  );

  const voice = useVoiceInput({
    onTranscript: insertAtCaret,
    onError: (message) => toast.error(message),
  });

  // —— 附件增删 ——
  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const room = MAX_ATTACHMENT_COUNT - attachmentsRef.current.length;
      if (room <= 0) {
        toast.error(`最多只能携带 ${MAX_ATTACHMENT_COUNT} 个附件`);
        return;
      }
      const picked = files.slice(0, room);
      if (files.length > room) {
        toast.error(`最多携带 ${MAX_ATTACHMENT_COUNT} 个附件，已忽略多余文件`);
      }
      const added: Attachment[] = [];
      for (const file of picked) {
        try {
          added.push(await fileToAttachment(file));
        } catch (err) {
          // 超限 / 读取失败逐个提示，不因单个文件失败放弃其余
          toast.error(err instanceof Error ? err.message : String(err));
        }
      }
      if (added.length > 0) {
        // 徽章插入当前光标处（选区不在输入区内时追加末尾），与参考应用行为一致
        for (const a of added) insertChipAtCaret(makeChipSpan(a));
        // 同步 ref 再提交 state：结构性变更是「同步改 DOM + 异步提交 state」，
        // 撤销快照需立即拿到「变更后」的附件列表，否则下一拍 ref 才更新会错位
        const next = [...attachmentsRef.current, ...added];
        attachmentsRef.current = next;
        setAttachments(next);
        // 强制入栈一步：撤销可整体移除这批新附件 + 徽章
        pushUndo(0);
      }
    },
    [insertChipAtCaret, makeChipSpan, pushUndo],
  );

  /**
   * 移除单个附件（点击徽章上的删除）。
   * 注意：**不立即释放 objectURL** —— 撤销栈仍持有该附件，提前 revoke 会让
   * 撤销回来的图片变成空白；统一在发送成功后释放（见 onSend）。
   */
  const removeAttachment = useCallback(
    (id: string) => {
      const next = attachmentsRef.current.filter((a) => a.id !== id);
      attachmentsRef.current = next;
      setAttachments(next);
      // 同步移除容器 span，保证「撤销快照」捕获的是「已删除」状态，
      // 撤销时再经由 applySnapshot 重建 span + 重挂 portal
      const span = chipSpans.current.get(id);
      if (span) {
        span.remove();
        chipSpans.current.delete(id);
      }
      // 强制入栈一步：撤销可整体恢复该附件 + 徽章
      pushUndo(0);
    },
    [pushUndo],
  );

  /**
   * 清空附件（/clear 指令复用；发送成功后的清理由 onSend 直接做，不走这里）。
   * 不立即释放 objectURL —— 撤销需保留预览，统一在发送成功后释放。
   * 撤销快照的入栈由调用方（/clear 分支）负责，这里只做状态清空。
   */
  const clearAttachments = useCallback(() => {
    attachmentsRef.current = [];
    setAttachments([]);
    const spans = Array.from(chipSpans.current.values());
    chipSpans.current.clear();
    spans.forEach((s) => s.remove());
  }, []);

  /** Backspace 可能整体删掉徽章：按 DOM 现存 [data-att-id] 与状态对账，清掉已不存在的附件 */
  const syncChipsFromDom = useCallback(() => {
    const root = editableRef.current;
    if (!root) return;
    const ids = new Set(
      Array.from(root.querySelectorAll("[data-att-id]")).map(
        (el) => (el as HTMLElement).dataset.attId!,
      ),
    );
    const prev = attachmentsRef.current;
    const missing = prev.filter((a) => !ids.has(a.id));
    if (missing.length === 0) return;
    // 不释放 objectURL：被 Backspace 删掉的徽章仍可能经撤销找回，
    // 提前 revoke 会让撤销回来的图片变空白。
    missing.forEach((a) => {
      chipSpans.current.delete(a.id);
    });
    // 同步 ref 再提交 state：handleEditableInput 紧接着会调 pushUndo(500)，
    // 若仅 setState（异步），pushUndo 捕获的 attachmentsRef 仍是「删除前」的旧值，
    // 快照里的 attachments 与 DOM 不一致，撤销回放时会出现「状态里有、DOM 里没有」
    // 的幻影附件。先同步 ref 让快照看到的是「删除后」的真实状态。
    const next = prev.filter((a) => ids.has(a.id));
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  /** 输入区 input 事件：空态归一 + 徽章对账 + 文本镜像 + 触发检测 */
  const handleEditableInput = () => {
    const root = editableRef.current;
    if (!root) return;
    normalizeEditableEmpty(root);
    syncChipsFromDom();
    suppressTriggerRef.current = false;
    const next = extractEditableText(root);
    emitText(next);
    syncTrigger(next, editableCaretOffset(root));
    // 连续输入合并入栈：500ms 内的击键视为一次编辑，避免「每敲一个字一个快照」
    pushUndo(500);
  };

  /**
   * 把快照还原到输入区：重写 DOM + 恢复附件状态 + 重建徽章映射 + 同步文本镜像。
   *
   * 徽章的 React 内容经 createPortal 挂载，innerHTML 还原后原 span 已被替换，
   * 因此必须重建 `chipSpans` 映射，React 重渲染时会重新挂载 portal。
   */
  const applySnapshot = useCallback(
    (snap: ComposerSnapshot) => {
      const root = editableRef.current;
      if (!root) return;
      restoreSnapshot(root, snap.edit);
      chipSpans.current = collectChipSpans(root);
      attachmentsRef.current = snap.attachments;
      setAttachments(snap.attachments);
      normalizeEditableEmpty(root);
      const next = extractEditableText(root);
      emitText(next);
      syncTrigger(next, editableCaretOffset(root));
      suppressTriggerRef.current = true;
    },
    [emitText, syncTrigger],
  );

  const doUndo = useCallback(() => {
    if (!canUndo(undoRef.current)) return;
    const next = undoStack(undoRef.current);
    undoRef.current = next;
    applySnapshot(next.present);
  }, [applySnapshot]);

  const doRedo = useCallback(() => {
    if (!canRedo(undoRef.current)) return;
    const next = redoStack(undoRef.current);
    undoRef.current = next;
    applySnapshot(next.present);
  }, [applySnapshot]);

  // 向父组件 / 标题栏「编辑」菜单暴露命令式编辑 API。
  // 经模块级桥接（composerEditBridge）供 TitleBar 调用，避免把 ref 从 ChatPage
  // 一路透传到 AppLayout。undo/redo 必须走自管快照栈，浏览器原生 execCommand
  // 对手动插入的附件徽章无效。
  useEffect(() => {
    if (!apiRef) return;
    const api: ComposerApi = {
      focus: focusEditable,
      undo: doUndo,
      redo: doRedo,
      selectAll: selectAllComposer,
    };
    apiRef.current = api;
    registerComposerEdit(api);
    return () => {
      apiRef.current = null;
      registerComposerEdit(null);
    };
  }, [apiRef, focusEditable, doUndo, doRedo, selectAllComposer]);

  /**
   * 复制 / 剪贴：把选区内容（含徽章对应的附件）写进剪贴板。
   * 无有效选区（折叠或不在输入区内）时返回 null，交给浏览器默认行为。
   */
  const copySelection = useCallback((): {
    plain: string;
    payload: string;
    picked: Attachment[];
  } | null => {
    const root = editableRef.current;
    if (!root) return null;
    const rich = extractSelectionRichText(root);
    if (rich === null) return null;
    const ids = selectionChipIds(root);
    const picked = attachmentsRef.current.filter((a) => ids.includes(a.id));
    let plain = extractSelectionText(root) ?? "";
    // 仅徽章的选区纯文本为空：回退为文件名串联 ——
    // 外部应用粘贴有可读内容，降级缓存也有键可命中
    if (plain.trim() === "" && picked.length > 0) {
      plain = picked.map((a) => a.name).join(" ");
    }
    return {
      plain,
      payload: JSON.stringify({ rich, attachments: picked }),
      picked,
    };
  }, []);

  /** Ctrl+C / 菜单「复制」：写入剪贴板，不动输入区 */
  const handleCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const data = copySelection();
    if (!data) return; // 无选区 → 走浏览器默认
    e.preventDefault();
    void writeRichClipboard(
      data.plain,
      data.payload,
      data.picked.length > 0,
    ).then((ok) => {
      if (!ok) toast.error("复制失败");
    });
  };

  /** Ctrl+X / 菜单「剪贴」：写入剪贴板后删除选区（含徽章与对应附件） */
  const handleCut = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const root = editableRef.current;
    const data = copySelection();
    if (!root || !data) return;
    e.preventDefault();
    void writeRichClipboard(
      data.plain,
      data.payload,
      data.picked.length > 0,
    ).then((ok) => {
      // 写入失败就不删，避免「内容丢了但剪贴板也是空的」
      if (!ok) return;
      const removed = deleteSelection(root);
      // 不释放 objectURL：撤销栈仍持有这些附件，提前 revoke 会让撤销回来的图片变空白
      const next = attachmentsRef.current.filter(
        (a) => !removed.includes(a.id),
      );
      attachmentsRef.current = next;
      setAttachments(next);
      removed.forEach((id) => chipSpans.current.delete(id));
      normalizeEditableEmpty(root);
      const text = extractEditableText(root);
      emitText(text);
      syncTrigger(text, editableCaretOffset(root));
      // 强制入栈：撤销可恢复被剪掉的文本 + 附件 + 徽章
      pushUndo(0);
    });
  };

  const onSend = () => {
    if (isStreaming) return;
    if (!text.trim() && attachments.length === 0) return;
    const payload = attachments;
    const root = editableRef.current;
    // 清空 DOM 前先抽取富文本副本（徽章 token 占位），供气泡内联渲染
    const rich =
      root && payload.length > 0 ? extractEditableRichText(root) : undefined;
    if (root) clearEditableContent(root);
    emitText("");
    chipSpans.current.clear();
    setAttachments([]);
    closePicker();
    void send(text, undefined, payload, rich).then(() => {
      // 消息已入库（持久化副本不含 object URL）后再释放预览地址，避免图片闪一下空白
      payload.forEach(revokeAttachmentPreview);
    });
    // 发送成功后清空撤销历史：避免「撤销」把刚发出去的内容又拉回输入框。
    // 清空前释放栈里仍引用的「已删除未发送」附件 object URL；
    // payload 内的附件由 .then 里释放，这里按 id 去重跳过
    const seen = new Set(payload.map((a) => a.id));
    const { past, present, future } = undoRef.current;
    [...past, present, ...future].forEach((s) =>
      s.attachments.forEach((a) => {
        if (seen.has(a.id)) return;
        seen.add(a.id);
        revokeAttachmentPreview(a);
      }),
    );
    undoRef.current = resetStack(undoRef.current, {
      edit: { html: "", rich: "", caret: 0 },
      attachments: [],
    });
  };

  const handleAgentChange = (id: string) => {
    setActiveAgent(id);
    // 切换到单个专家即退出专家团模式（与召唤逻辑对称）
    setActiveGroup(null);
    if (activeSessionId) {
      updateSession(activeSessionId, (s) => ({
        ...s,
        agentId: id,
        groupId: null,
        updatedAt: new Date().toISOString(),
      }));
    }
  };

  /** 切换专家团：与 handleAgentChange 同构；会话 agentId 同步为团内首位启用成员
   *  （执行代表；完整多 Agent 编排依赖 nanobot 运行时，P2）。 */
  const handleGroupChange = (id: string) => {
    const group = groups.find((g) => g.id === id);
    if (!group) return;
    const leader = group.memberIds
      .map((mid) => agents.find((a) => a.id === mid))
      .find((a) => a && a.enabled);
    setActiveGroup(id);
    if (activeSessionId) {
      updateSession(activeSessionId, (s) => ({
        ...s,
        groupId: id,
        ...(leader ? { agentId: leader.id } : {}),
        updatedAt: new Date().toISOString(),
      }));
    }
  };

  // —— 会话级模型选择（目录来源：nanobot 配置 modelPresets + 隐式 default） ——
  const setSessionModel = useSessionsStore((s) => s.setSessionModel);
  const models = useModelsStore((s) => s.models);
  const refreshModels = useModelsStore((s) => s.refresh);
  const [modelAnchor, setModelAnchor] = useState<null | HTMLElement>(null);
  // 展示名：所选预设 label；未选择（Auto）展示目录首位（default）
  const effectiveModel =
    describeModelId(models, activeSession?.model) ?? "Auto";

  /** 无活跃会话时先创建（继承当前全局活跃专家团 / 专家），返回会话 id */
  const ensureSessionId = (): string => {
    if (activeSessionId) return activeSessionId;
    return useSessionsStore.getState().createSession(undefined, "新会话").id;
  };

  const handleModelSelect = (m: string) => {
    setModelAnchor(null);
    setSessionModel(ensureSessionId(), m);
  };

  const handleAddSkill = (skillId: string) => {
    let sid = activeSessionId;
    let currentSkillIds = activeSkillIds;
    if (!sid) {
      const created = useSessionsStore
        .getState()
        .createSession(undefined, "新会话");
      sid = created.id;
      currentSkillIds = created.skillIds ?? [];
    }
    if (currentSkillIds.includes(skillId)) return;
    updateSession(sid, (s) => ({
      ...s,
      skillIds: [...currentSkillIds, skillId],
      updatedAt: new Date().toISOString(),
    }));
  };

  const handleRemoveSkill = (skillId: string) => {
    if (!activeSessionId) return;
    updateSession(activeSessionId, (s) => ({
      ...s,
      skillIds: activeSkillIds.filter((id) => id !== skillId),
      updatedAt: new Date().toISOString(),
    }));
  };

  // —— 候选数据 ——
  /** 内置指令：与技能合并进同一个 `/` 浮层 */
  const builtinCommands = useMemo<SlashCommandItem[]>(
    () => [
      {
        id: "clear",
        label: "/clear",
        description: "清空输入框与已选附件",
        icon: <DeleteSweepIcon sx={{ fontSize: 18 }} />,
        group: "command",
      },
      {
        id: "compact",
        label: "/compact",
        description: "插入「压缩总结当前对话」的提示词",
        icon: <CompressIcon sx={{ fontSize: 18 }} />,
        group: "command",
      },
      {
        id: "model",
        label: "/model",
        description: "打开会话模型选择",
        icon: <TuneIcon sx={{ fontSize: 18 }} />,
        group: "command",
      },
      {
        id: "new",
        label: "/new",
        description: "新建一个会话",
        icon: <NoteAddIcon sx={{ fontSize: 18 }} />,
        group: "command",
      },
    ],
    [],
  );

  const slashItems = useMemo<SlashCommandItem[]>(() => {
    if (trigger?.type !== "slash") return [];
    const q = trigger.query.trim().toLowerCase();
    const skillItems: SlashCommandItem[] = skills
      .filter((s) => s.enabled)
      .map((s) => ({
        id: s.id,
        label: s.name,
        description: s.description,
        icon: <Typography sx={{ fontSize: 16 }}>{s.icon ?? "📦"}</Typography>,
        group: "skill",
      }));
    const all = [...builtinCommands, ...skillItems];
    if (q === "") return all;
    return all.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.description.toLowerCase().includes(q),
    );
  }, [builtinCommands, skills, trigger]);

  /** 本会话可引用文件：用户附件 + 助手产物，按时间倒序去重，上限 100 条 */
  const fileRefItems = useMemo<FileRefItem[]>(() => {
    if (trigger?.type !== "at" || !activeSession) return [];
    const seen = new Set<string>();
    const list: FileRefItem[] = [];
    // 倒序遍历消息 = 时间倒序，最近出现的文件排在最前
    for (const m of [...activeSession.messages].reverse()) {
      for (const a of m.attachments ?? []) {
        if (seen.has(a.name)) continue;
        seen.add(a.name);
        list.push({
          id: `att-${a.id}`,
          name: a.name,
          source: "attachment",
          subtitle: `${KIND_LABEL[a.kind] ?? KIND_LABEL.other} · ${formatBytes(a.size)}`,
        });
      }
      for (const art of m.artifacts ?? []) {
        const name = art.title?.trim() || `产物-${art.id.slice(0, 6)}`;
        if (seen.has(name)) continue;
        seen.add(name);
        list.push({
          id: `art-${art.id}`,
          name,
          source: "artifact",
          subtitle: `对话产物 · ${art.type}`,
        });
      }
      if (list.length >= 100) break;
    }
    const capped = list.slice(0, 100);
    const q = trigger.query.trim().toLowerCase();
    if (q === "") return capped;
    return capped.filter((it) => it.name.toLowerCase().includes(q));
  }, [activeSession, trigger]);

  const pickerItems: Array<SlashCommandItem | FileRefItem> =
    trigger?.type === "slash" ? slashItems : fileRefItems;
  const pickerOpen = trigger !== null && pickerItems.length > 0;
  // 过滤词变化后高亮可能越界，统一夹取到合法范围
  const safeIndex =
    pickerItems.length === 0
      ? 0
      : Math.min(Math.max(activeIndex, 0), pickerItems.length - 1);

  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.type, trigger?.query]);

  // 点击外部关闭：浮层用 hideBackdrop（保证输入框不失焦、可继续打字），
  // 而 MUI 的「点击外部关闭」依赖 backdrop 捕获点击，这里失效了，故补一个文档级监听兜底。
  useEffect(() => {
    if (!pickerOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      // 点在输入框卡片内 → 交给输入区自己的 onClick / onBlur 处理，不越权关闭
      if (cardRef.current?.contains(target)) return;
      // 点在浮层内（标题、列表、滚动条）→ 保持打开，选中逻辑走各项的 mousedown
      if (target.closest?.("[data-composer-picker]")) return;
      closePicker();
    };
    // 捕获阶段注册，早于浮层内部项的 mousedown；上面的白名单已排除浮层，不会误关
    document.addEventListener("mousedown", onDocMouseDown, true);
    return () =>
      document.removeEventListener("mousedown", onDocMouseDown, true);
  }, [pickerOpen, closePicker]);

  /** 选中某个 `/` 候选：删掉触发片段并执行对应动作 */
  const runSlashItem = (item: SlashCommandItem) => {
    if (!trigger) return;
    const caret = editableRef.current
      ? editableCaretOffset(editableRef.current)
      : text.length;
    // /compact 用提示词替换触发片段；其余指令把触发片段整体删掉
    replaceRange(
      trigger.index,
      caret,
      item.id === "compact" ? COMPACT_PROMPT : "",
    );
    suppressTriggerRef.current = true;
    switch (item.id) {
      case "clear":
        clearAttachments();
        // 文本已由上面 replaceRange 清空、附件已清空 —— 合并为「一步撤销」
        pushUndo(0);
        break;
      case "compact":
        // 文本已由上面 replaceRange 替换为压缩提示词 —— 入栈一步
        pushUndo(0);
        break;
      case "model":
        setModelAnchor(modelChipRef.current);
        void refreshModels(true);
        break;
      case "new":
        useSessionsStore.getState().createSession(undefined, "新会话");
        break;
      default:
        // 技能项：挂载到当前会话（与加号菜单里选技能同一条路径）
        handleAddSkill(item.id);
        break;
    }
    closePicker();
  };

  /** 选中某个 `@` 文件：在光标处插入引用标记 */
  const runFileRefItem = (item: FileRefItem) => {
    if (!trigger) return;
    const caret = editableRef.current
      ? editableCaretOffset(editableRef.current)
      : text.length;
    // 尾部补一个空格，方便紧接着继续输入指令
    replaceRange(trigger.index, caret, `@${item.name} `);
    suppressTriggerRef.current = true;
    // 程序化插入引用标记不会触发 onInput，手动入栈一步
    pushUndo(0);
    closePicker();
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // 输入法组合期（拼音选词等）不劫持按键：确认候选的 Enter 不能触发发送
    if (e.nativeEvent.isComposing) return;
    // —— 撤销 / 重做：必须自己接管，浏览器原生 undo 对手动插入的徽章无效 ——
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
      return;
    }
    if (mod && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      doRedo();
      return;
    }
    if (pickerOpen) {
      // 浮层打开期间：方向键 / 回车 / Tab / Esc 全部让位给浮层，不触发发送
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % pickerItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex(
          (i) => (i - 1 + pickerItems.length) % pickerItems.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const picked = pickerItems[safeIndex];
        if (!picked || !trigger) return;
        if (trigger.type === "slash") runSlashItem(picked as SlashCommandItem);
        else runFileRefItem(picked as FileRefItem);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closePicker();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
      return;
    }
    if (e.key === "Enter" && e.shiftKey) {
      // 换行：手动插入纯文本 \n（pre-wrap 渲染），保持 DOM 结构干净、抽取同构
      e.preventDefault();
      insertAtCaret("\n");
    }
  };

  /** 富复制粘贴：按 id 恢复附件，文本/徽章按原始交错顺序在光标处还原 */
  const insertRichClipboard = async (raw: string) => {
    let payload: { rich?: string; attachments?: Attachment[] };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const segments = splitRichContent(payload.rich ?? "");
    const byId = new Map((payload.attachments ?? []).map((a) => [a.id, a]));
    const uniqueIds = [
      ...new Set(
        segments
          .filter((s): s is { type: "att"; id: string } => s.type === "att")
          .map((s) => s.id),
      ),
    ];
    const room = MAX_ATTACHMENT_COUNT - attachmentsRef.current.length;
    const restored = new Map<string, Attachment>();
    const failed: string[] = [];
    for (const id of uniqueIds) {
      if (restored.size >= room) break;
      const meta = byId.get(id);
      if (!meta) continue;
      const att = await rehydrateAttachment(meta);
      if (!att) {
        failed.push(meta.name);
        continue;
      }
      /**
       * 关键：给还原后的附件分配一个**全新 id**。
       *
       * 复粘贴同一条消息（或从其它输入框粘同源内容）时，剪贴板 payload 里的附件
       * id 与当前 `attachmentsRef.current` 撞车。若直接复用旧 id，会出现：
       *   1) `next = [...ref, ...restored.values()]` 出现重复 id；
       *   2) 多个 portal 挂到同一 `chipSpans` span 上，徽章视觉重叠；
       *   3) 撤销栈里出现「同一附件占多份」的快照，applySnapshot 后渲染多份。
       *
       * `restored` Map 仍按 payload 原 id 取（保证下面 splitRichContent 的
       * segment.id 能命中），但 attachment 对象本身用全新 id —— 既支持「再粘一次
       * 也出现附件」，又让每份附件都是独立可撤销单元。
       */
      restored.set(id, { ...att, id: genId() });
    }
    const root = editableRef.current;
    if (!root) return;
    root.focus();
    // 若选区不在输入区内（最常见的「粘贴前空输入框」场景），把光标放到末尾
    if (!hasSelectionInside(root)) placeCaretAtEnd(root);

    /**
     * 直接走 lib 的 `insertNodeAtSelection`：避免 range.insertNode 在 textNode 末尾 offset
     * 处 split 产生空 textNode 把 chip 之间的相对位置打乱（详见 lib 函数注释）。
     */
    for (const seg of segments) {
      if (seg.type === "text") {
        if (seg.text)
          insertNodeAtSelection(root, document.createTextNode(seg.text));
      } else {
        const att = restored.get(seg.id);
        if (att) insertNodeAtSelection(root, makeChipSpan(att));
      }
    }
    if (restored.size > 0) {
      const next = [...attachmentsRef.current, ...restored.values()];
      attachmentsRef.current = next;
      setAttachments(next);
    }
    if (uniqueIds.length > room) {
      toast.error(
        `最多只能携带 ${MAX_ATTACHMENT_COUNT} 个附件，已忽略多余附件`,
      );
    } else if (failed.length > 0) {
      toast.error(
        `附件「${failed.join("、")}」内容无法恢复（源文件可能已移动），已跳过`,
      );
    }
    // 强制入栈一步：撤销可整体移除粘贴进来的文本 + 附件 + 徽章
    pushUndo(0);
  };

  /** 粘贴：应用内富复制还原内联布局；截图 / 复制的图片在光标处进附件；文本按纯文本插入光标处 */
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    // 一律自行接管，避免浏览器把富文本 HTML 塞进 editable 区
    e.preventDefault();
    const plain = e.clipboardData.getData("text/plain");
    // 路径 ①：剪贴板里直接带了 RICH_CLIP_MIME（正常富复制成功路径）
    const richRaw = e.clipboardData.getData(RICH_CLIP_MIME);
    if (richRaw) {
      void insertRichClipboard(richRaw);
      return;
    }
    // 路径 ②：剪贴板只有纯文本，但纯文本键能命中应用层富 payload 缓存
    // ——修复点：当 ClipboardItem 写入失败（Electron / 部分浏览器拒绝自定义 MIME）
    //   导致外部只有 text/plain 时，本应用粘贴仍能按文本键还原附件；
    //   peek 非消费，同一内容可反复粘贴
    if (plain) {
      const cached = peekRichPayload(plain);
      if (cached) {
        void insertRichClipboard(cached);
        return;
      }
    }
    // 路径 ③：剪贴板里直接是文件（截图 / 复制图片）
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      void addFiles(files);
      return;
    }
    // 兜底：纯文本按光标处插入
    if (plain) insertAtCaret(plain);
  };

  /** 拖拽落区：整张卡片可接文件 */
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    void addFiles(Array.from(e.dataTransfer?.files ?? []));
  };

  /**
   * 输入区文本拖放：按落点插入纯文本。
   * 文件拖放不干预 —— 事件冒泡到卡片级 handleDrop 统一处理；
   * 纯文本拖放必须接管，否则浏览器默认把富 HTML 塞进 editable 区。
   */
  const handleEditableDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if ((e.dataTransfer?.files?.length ?? 0) > 0) return;
    const plain = e.dataTransfer?.getData("text/plain");
    if (!plain) return;
    e.preventDefault();
    e.stopPropagation();
    // 尽量把选区定位到拖放落点，再在光标处插入
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range;
    };
    const root = editableRef.current;
    const range = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (range && root?.contains(range.startContainer)) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    insertAtCaret(plain);
  };

  /** 从输入区重新判定触发态（keyup / click 等光标移动场景） */
  const syncTriggerFromInput = () => {
    const root = editableRef.current;
    if (!root) return;
    syncTrigger(extractEditableText(root), editableCaretOffset(root));
  };

  /**
   * 点击：落在徽章上时把选区设为整个徽章 span（原子选中），
   * 之后 Ctrl+C / Ctrl+X / Delete 即可单独作用于该附件；
   * 删除按钮的点击已 stopPropagation，不会走到这里。
   */
  const handleEditableClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const chipEl = (e.target as Element | null)?.closest?.("[data-att-id]");
    const root = editableRef.current;
    if (chipEl && root?.contains(chipEl)) {
      const range = document.createRange();
      range.selectNode(chipEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
    syncTriggerFromInput();
  };

  const isHero = variant === "hero";

  return (
    <Box
      sx={{
        width: "100%",
        maxWidth: 960,
        mx: "auto",
        px: isHero ? 2 : 1.5,
        py: 1.5,
      }}
    >
      <Box
        ref={cardRef}
        onDragOver={(e) => {
          e.preventDefault();
          // 仅拖文件时显示附件落区提示；纯文本拖拽不反应
          setDragOver(
            Array.from(e.dataTransfer?.types ?? []).includes("Files"),
          );
        }}
        onDragLeave={(e) => {
          // 拖过子元素时也会冒泡出 dragleave，用 relatedTarget 判定是否真的离开了卡片
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragOver(false);
        }}
        onDrop={handleDrop}
        sx={{
          position: "relative",
          bgcolor: "background.paper",
          border: "1px solid",
          borderColor: dragOver ? "primary.main" : "divider",
          borderRadius: 2,
          boxShadow: (theme) => (isHero ? theme.shadows[6] : theme.shadows[2]),
          transition: "border-color 0.2s, box-shadow 0.2s",
          "&:focus-within": {
            borderColor: "primary.main",
            boxShadow: (theme) => `0 0 0 1px ${theme.palette.primary.main}`,
          },
          overflow: "hidden",
        }}
      >
        {/* 拖拽悬停提示层 */}
        {dragOver && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              zIndex: 3,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              // 半透明遮罩由主题背景色派生，深浅色下都不会糊成一片
              bgcolor: (theme) =>
                alpha(
                  theme.palette.background.paper,
                  theme.palette.mode === "dark" ? 0.72 : 0.82,
                ),
              border: "2px dashed",
              borderColor: "primary.main",
              borderRadius: 2,
              pointerEvents: "none",
            }}
          >
            <Typography sx={{ fontSize: 13, color: "primary.main" }}>
              松开即可添加附件（单个文件不超过 10MB）
            </Typography>
          </Box>
        )}

        {/* 模式 Skill 徽章 + 已挂载技能 chips */}
        {(heroSkill || activeSkills.length > 0) && (
          <Box
            sx={{
              px: 1.5,
              pt: 1,
              pb: 0.5,
              display: "flex",
              gap: 0.75,
              flexWrap: "wrap",
            }}
          >
            {heroSkill && (
              <Chip
                size="small"
                icon={
                  <span style={{ fontSize: 14, display: "inline-flex" }}>
                    {heroSkill.icon}
                  </span>
                }
                label={heroSkill.label}
                deleteIcon={<CloseIcon fontSize="small" />}
                onDelete={() => onHeroSkillRemove?.(heroSkill.id)}
                sx={{
                  // hero skill 徽标从靛紫改为黑/灰/白，兼容深浅主题
                  bgcolor: (theme) =>
                    theme.palette.mode === "dark"
                      ? "rgba(255, 255, 255, 0.12)"
                      : "rgba(0, 0, 0, 0.08)",
                  color: (theme) =>
                    theme.palette.mode === "dark" ? "#ffffff" : "#1f2430",
                  fontSize: 12,
                  height: 24,
                  "& .MuiChip-icon": {
                    mr: -0.2,
                    color: (theme) =>
                      theme.palette.mode === "dark" ? "#ffffff" : "#1f2430",
                  },
                  "& .MuiChip-deleteIcon": {
                    fontSize: 14,
                    color: (theme) =>
                      theme.palette.mode === "dark" ? "#ffffff" : "#1f2430",
                    "&:hover": { color: "text.primary" },
                  },
                }}
              />
            )}
            {activeSkills.map((s) => (
              <Chip
                key={s.id}
                size="small"
                icon={<span style={{ fontSize: 14 }}>{s.icon ?? "📦"}</span>}
                label={s.name}
                deleteIcon={<CloseIcon fontSize="small" />}
                onDelete={() => handleRemoveSkill(s.id)}
                sx={{
                  bgcolor: "action.hover",
                  color: "text.secondary",
                  fontSize: 12,
                  height: 24,
                  "& .MuiChip-icon": { mr: -0.2 },
                  "& .MuiChip-deleteIcon": {
                    color: "text.secondary",
                    fontSize: 14,
                  },
                }}
              />
            ))}
          </Box>
        )}

        {/* 富输入区：contentEditable，文本与附件徽章可在光标处混排 */}
        <Box
          ref={editableRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-placeholder={placeholder}
          onInput={handleEditableInput}
          onKeyDown={handleInputKeyDown}
          onKeyUp={syncTriggerFromInput}
          onClick={handleEditableClick}
          onPaste={handlePaste}
          onCopy={handleCopy}
          onCut={handleCut}
          onDrop={handleEditableDrop}
          onBlur={closePicker}
          sx={{
            px: 1.5,
            py: 1.25,
            outline: "none",
            cursor: "text",
            fontSize: 15,
            lineHeight: 1.6,
            color: "text.primary",
            minHeight: (isHero ? 3 : 2) * 24,
            maxHeight: (isHero ? 10 : 6) * 24,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            // 占位符：空态归一后 innerHTML 为空时显示
            "&:empty::before": {
              content: "attr(aria-placeholder)",
              color: "text.secondary",
              opacity: 0.7,
              pointerEvents: "none",
            },
            // 内联徽章：垂直居中，与两侧文字留小间距
            "& [data-att-id]": { verticalAlign: "middle", margin: "0 3px" },
          }}
        />
        {/* 徽章经 portal 挂进各自 span：继承主题上下文，悬停删除 / 图片预览 */}
        {attachments.map((a) => {
          const span = chipSpans.current.get(a.id);
          return span
            ? createPortal(
                <InlineAttachmentChip
                  attachment={a}
                  onRemove={removeAttachment}
                />,
                span,
                a.id,
              )
            : null;
        })}

        {/* 工具栏：+ 菜单 / Agent / 闪光 / 模型 / 语音 / 发送 */}
        <Box
          sx={{
            px: 1.5,
            pb: 1,
            pt: 0.5,
            display: "flex",
            alignItems: "center",
            gap: 1,
          }}
        >
          {/* 左侧：加号菜单、工作空间/权限（floating）、当前 Agent */}
          <ComposerMenu
            onFilesSelected={(files) => {
              void addFiles(Array.from(files));
              focusEditable();
            }}
            onQuoteFile={() => {
              // 插入触发符并主动同步触发态，等同用户手敲一个 @
              suppressTriggerRef.current = false;
              insertAtCaret("@");
            }}
            onSkillSelect={handleAddSkill}
            onAgentSelect={handleAgentChange}
          />

          {!isHero && <ComposerControls />}

          {effectiveGroup ? (
            <Chip
              size="small"
              icon={<GroupsIcon fontSize="small" />}
              label={effectiveGroup.name}
              onClick={() => {
                // 简单循环切换启用中的专家团；后续可换为下拉选择
                const enabledGroups = groups.filter((g) => g.enabled);
                if (enabledGroups.length === 0) return;
                const idx = enabledGroups.findIndex(
                  (g) => g.id === effectiveGroup.id,
                );
                const next =
                  enabledGroups[(idx + 1) % enabledGroups.length];
                handleGroupChange(next.id);
              }}
              sx={{
                cursor: "pointer",
                bgcolor: "action.hover",
                color: "text.secondary",
                fontSize: 12,
                height: 26,
                "& .MuiChip-icon": { color: "primary.main", mr: -0.3 },
              }}
            />
          ) : (
            effectiveAgent && (
              <Chip
                size="small"
                icon={<SmartToyIcon fontSize="small" />}
                label={effectiveAgent.name}
                onClick={() => {
                  // 简单循环切换；后续可换为下拉选择
                  const idx = agents.findIndex((a) => a.id === effectiveAgentId);
                  const next = agents[(idx + 1) % agents.length];
                  handleAgentChange(next.id);
                }}
                sx={{
                  cursor: "pointer",
                  bgcolor: "action.hover",
                  color: "text.secondary",
                  fontSize: 12,
                  height: 26,
                  "& .MuiChip-icon": { color: "primary.main", mr: -0.3 },
                }}
              />
            )
          )}

          <Box sx={{ flex: 1 }} />

          {/* 右侧：闪光、模型、语音、发送 */}
          <IconButton
            size="small"
            sx={{
              color: "text.secondary",
              "&:hover": { color: "text.primary", bgcolor: "action.hover" },
            }}
          >
            <AutoAwesomeIcon fontSize="small" />
          </IconButton>

          {/* 会话级模型下拉选择 */}
          <Chip
            ref={modelChipRef}
            size="small"
            icon={<ExpandMoreIcon fontSize="small" />}
            label={effectiveModel}
            onClick={(e) => {
              setModelAnchor(e.currentTarget);
              void refreshModels(true);
            }}
            sx={{
              cursor: "pointer",
              bgcolor: "action.hover",
              color: "text.secondary",
              fontSize: 12,
              height: 26,
              "& .MuiChip-icon": { order: 1, ml: "auto" },
            }}
          />
          <Menu
            anchorEl={modelAnchor}
            open={!!modelAnchor}
            onClose={() => setModelAnchor(null)}
            slotProps={{ paper: { sx: { minWidth: 160 } } }}
          >
            {/* Auto：跟随 nanobot 配置默认模型（目录首位 default 预设） */}
            <MenuItem
              selected={!activeSession?.model}
              onClick={() => handleModelSelect("")}
              sx={{ fontSize: 13 }}
            >
              Auto（默认 {describeModelId(models, null) ?? "nanobot"}）
            </MenuItem>
            <Divider />
            {models
              .filter((m) => m.id !== "default")
              .map((m) => (
                <MenuItem
                  key={m.id}
                  selected={m.id === activeSession?.model}
                  onClick={() => handleModelSelect(m.id)}
                  sx={{ fontSize: 13 }}
                >
                  {m.label ?? m.model ?? m.id}
                </MenuItem>
              ))}
          </Menu>

          {/* 语音输入：未配置转录服务时禁用并提示去设置 */}
          {voice.recording && (
            <Typography
              sx={{
                fontSize: 12,
                color: "error.main",
                fontVariantNumeric: "tabular-nums",
                userSelect: "none",
              }}
            >
              {formatDuration(voice.seconds)}
            </Typography>
          )}
          {voiceReady ? (
            <Tooltip
              title={
                voice.recording
                  ? "点击结束并开始转写"
                  : voice.transcribing
                    ? "正在转写…"
                    : "语音输入"
              }
            >
              <IconButton
                size="small"
                onClick={() => {
                  if (voice.recording) voice.stop();
                  else void voice.start();
                }}
                disabled={voice.transcribing}
                aria-label="语音输入"
                sx={{
                  color: voice.recording ? "error.main" : "text.secondary",
                  bgcolor: voice.recording ? "action.hover" : "transparent",
                  "&:hover": { color: "text.primary", bgcolor: "action.hover" },
                  // 录音中：用主题 error 色做一圈随音量扩散的脉冲，避免硬编码颜色
                  ...(voice.recording
                    ? {
                        animation:
                          "composerVoicePulse 1.4s ease-in-out infinite",
                        "@keyframes composerVoicePulse": {
                          "0%, 100%": {
                            boxShadow: (theme: Theme) =>
                              `0 0 0 0 ${alpha(theme.palette.error.main, 0.45)}`,
                          },
                          "50%": {
                            boxShadow: (theme: Theme) =>
                              `0 0 0 ${4 + voice.level * 6}px ${alpha(theme.palette.error.main, 0)}`,
                          },
                        },
                      }
                    : {}),
                }}
              >
                {voice.recording ? (
                  <StopIcon fontSize="small" />
                ) : (
                  <KeyboardVoiceIcon fontSize="small" />
                )}
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip title="未配置转录服务，请在「设置 → 语音输入」中开启">
              {/* disabled 按钮不派发鼠标事件，Tooltip 需要包一层 span 才能生效 */}
              <span>
                <IconButton
                  size="small"
                  disabled
                  aria-label="语音输入（未配置转录服务）"
                  sx={{
                    color: "text.disabled",
                    "&.Mui-disabled": { color: "text.disabled" },
                  }}
                >
                  <KeyboardVoiceIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}

          {isStreaming ? (
            // 流式传输中：把发送按钮换成「停止」按钮，点击中断当前会话对话
            <Tooltip title="停止生成">
              <IconButton
                size="small"
                onClick={() => abort(activeSessionId ?? undefined)}
                aria-label="停止生成"
                sx={{
                  bgcolor: "error.main",
                  color: "error.contrastText",
                  "&:hover": { bgcolor: "error.dark" },
                }}
              >
                <StopIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : (
            <IconButton
              size="small"
              onClick={onSend}
              disabled={!text.trim() && attachments.length === 0}
              sx={{
                bgcolor: "primary.main",
                color: "primary.contrastText",
                "&:hover": { bgcolor: "primary.dark" },
                "&.Mui-disabled": {
                  bgcolor: "action.disabledBackground",
                  color: "text.disabled",
                },
              }}
            >
              <SendIcon fontSize="small" />
            </IconButton>
          )}
        </Box>

        {/* Hero 模式：卡片底部「工作空间 + 默认权限」（与输入框同属一张卡片） */}
        {isHero && (
          <Box
            sx={{
              px: 1.5,
              py: 0.75,
              display: "flex",
              alignItems: "center",
              gap: 1.5,
              bgcolor: (theme) =>
                theme.palette.mode === "dark"
                  ? "rgba(255,255,255,0.03)"
                  : "rgba(0,0,0,0.02)",
              borderTop: "1px solid",
              borderColor: "divider",
            }}
          >
            <ComposerControls />
          </Box>
        )}
      </Box>

      {/* `/` 技能与指令浮层 */}
      <SlashCommandPicker
        open={pickerOpen && trigger?.type === "slash"}
        anchorEl={cardRef.current}
        items={slashItems}
        activeIndex={safeIndex}
        onSelect={runSlashItem}
        onHover={setActiveIndex}
        onClose={closePicker}
      />

      {/* `@` 引用对话中的文件浮层 */}
      <FileReferencePicker
        open={pickerOpen && trigger?.type === "at"}
        anchorEl={cardRef.current}
        items={fileRefItems}
        activeIndex={safeIndex}
        onSelect={runFileRefItem}
        onHover={setActiveIndex}
        onClose={closePicker}
      />
    </Box>
  );
}
