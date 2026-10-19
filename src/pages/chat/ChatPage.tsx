import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Box, Button, IconButton, Typography } from "@mui/material";
import { useLocation, useNavigate } from "react-router-dom";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import SouthEastIcon from "@mui/icons-material/SouthEast";
import { ChatHeader } from "./ChatHeader";
import { chatColumnSx } from "./chatColumnSx";
import { MessageStream } from "./MessageStream";
import {
  Composer,
  type ComposerApi,
  type ComposerSubmitPayload,
} from "./Composer";
import { ApprovalCard } from "@/components/ApprovalCard";
import { readDeepLinkPrompt } from "@/types/deepLink";
import {
  HERO_MODES,
  type HeroMode,
  type HeroModeId,
  type HeroPromptTag,
  type HeroSkill,
} from "./heroPresets";
import { toast } from "@/components/Toast";
import { hasConversation } from "@/lib/conversation";
import { platform } from "@/platform";
import { useSessionsStore } from "@/stores/sessionsStore";

/**
 * 会话页。
 * - 无活跃会话或会话无消息:WorkBuddy 风格空状态,三级联动:
 *   1. 顶部模式按钮(日常办公/代码开发/设计创意);
 *   2. 模式下横向滚动的 Skill 技能胶囊,点击后在输入框插入技能徽章,
 *      技能行切换为该 Skill 的提示词标签行;
 *   3. 点击提示词标签,把对应提示词填入输入框。
 * - 有对话内容:顶部标题 + 消息流 + 底部浮动输入框。
 */
export function ChatPage() {
  const [activeMode, setActiveMode] = useState<HeroModeId>("office");
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  // 深链 `new-chat?prompt=` 的一次性意图（由 App.tsx 经路由 state 传入）。
  // 键名取自 `@/types/deepLink` 的共享常量：App 写、这里读，两边各写字面量时
  // 拼错不报错、只会静默变成「开了会话但输入框是空的」。
  const deepLinkPrompt = readDeepLinkPrompt(location.state);
  // 空状态输入框受控文本:点击提示词标签时填入对应提示词。
  // 初值直接取深链 prompt——否则会先渲染一个空框、下一帧才被 effect 填上，闪一下。
  const [heroText, setHeroText] = useState(
    typeof deepLinkPrompt === "string" ? deepLinkPrompt : "",
  );
  const composerApi = useRef<ComposerApi | null>(null);

  // 深链 prompt：挂载时已在初值里，这里兜「页面已挂载时又来一条」的情况。
  useEffect(() => {
    if (typeof deepLinkPrompt !== "string") return;
    if (deepLinkPrompt) {
      setHeroText(deepLinkPrompt);
      composerApi.current?.focus();
    }
    // 消费掉这条 state：留着会让刷新 / 前进后退把用户改过的草稿再次冲掉。
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: null,
    });
  }, [deepLinkPrompt, navigate, location.pathname, location.search]);

  const activeId = useSessionsStore((s) => s.activeId);
  const session = useSessionsStore((s) =>
    s.sessions.find((x) => x.id === activeId),
  );
  // 空态判据走 `hasConversation` 而不是只看消息：消息是按需水合的（启动只读索引），
  // 点开一条有记录的老任务时，`messages` 会先留白一瞬——只看消息会让大标题空态
  // 闪现一下再被消息流顶掉。索引里的持久条数能立刻回答「这条任务开过工没有」。
  const hasMessages = session ? hasConversation(session) : false;

  const mode = HERO_MODES.find((m) => m.id === activeMode) ?? HERO_MODES[0];
  const activeSkill = mode.skills.find((s) => s.id === activeSkillId) ?? null;

  /** 切换模式:重置已选 Skill 与提示词标签 */
  const handleModeChange = (id: HeroModeId) => {
    setActiveMode(id);
    setActiveSkillId(null);
  };

  /** 点击提示词标签:输入框替换为对应提示词并聚焦 */
  const handleTagClick = (tag: HeroPromptTag) => {
    setHeroText(tag.prompt);
    composerApi.current?.focus();
  };

  if (!hasMessages) {
    return (
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 3,
          bgcolor: "background.default",
          px: 3,
          height: "100%",
          overflow: "auto",
        }}
      >
        {/* 大标题 */}
        <Typography
          variant="h3"
          sx={{
            fontWeight: 700,
            color: "text.primary",
            textAlign: "center",
            fontSize: { xs: 32, sm: 40 },
          }}
        >
          NanoWork, 我帮你
        </Typography>

        {/* 模式按钮(segmented control:深色胶囊容器 + 选中态高对比胶囊底) */}
        <Box
          sx={{
            display: "inline-flex",
            gap: 0.5,
            p: 0.5,
            borderRadius: 999,
            bgcolor: (theme) =>
              theme.palette.mode === "dark"
                ? "rgba(0,0,0,0.45)"
                : "rgba(15, 23, 42, 0.06)",
            mb: 4,
          }}
        >
          {HERO_MODES.map((m) => (
            <ModeButton
              key={m.id}
              mode={m}
              active={m.id === activeMode}
              onClick={() => handleModeChange(m.id)}
            />
          ))}
        </Box>

        {/* 第二级 Skill 技能 / 第三级提示词标签(同一行位置切换) */}
        <ScrollRow
          sx={{
            // 抵消父容器 gap: 3 (24px),与 Composer 保持紧凑间距
            mb: -1,
          }}
        >
          {activeSkill
            ? activeSkill.tags.map((tag) => (
                <PromptTagButton
                  key={tag.label}
                  tag={tag}
                  onClick={() => handleTagClick(tag)}
                />
              ))
            : mode.skills.map((skill) => (
                <SkillChipButton
                  key={skill.id}
                  skill={skill}
                  onClick={() => setActiveSkillId(skill.id)}
                />
              ))}
        </ScrollRow>

        {/* 大输入框:受控文本 + 模式 Skill 徽章 */}
        <Composer
          placeholder="今天帮你做些什么？@ 引用对话文件，/ 调用技能与指令"
          variant="hero"
          value={heroText}
          onValueChange={setHeroText}
          heroSkill={
            activeSkill
              ? {
                  id: activeSkill.id,
                  label: activeSkill.label,
                  icon: activeSkill.icon,
                }
              : null
          }
          onHeroSkillRemove={() => setActiveSkillId(null)}
          apiRef={composerApi}
        />

        {/* 输入框下的副标题:水平居中、灰色、小字号 */}
        {/* <Typography
          sx={{
            fontSize: 12.5,
            color: "text.secondary",
            textAlign: "center",
            whiteSpace: "nowrap",
          }}
        >
          基于 nanobot 的本地智能助手
        </Typography> */}
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: "flex",
        height: "100%",
        flex: 1,
        bgcolor: "background.default",
        // 审批卡片（ApprovalCard）以 `position: absolute` 覆盖输入框，锚点
        // 就是这一层。缺了 `relative` 它会一路找到最近的定位祖先（多半是
        // body），贴在视口底部而不是输入框上——而输入框上方还压着横幅。
        position: "relative",
      }}
    >
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          height: "100%",
        }}
      >
        <ChatHeader />
        {/* 消息区：搜索条与三个入口都在 ChatHeader 内，此处仅承载滚动容器 */}
        <Box
          sx={{
            position: "relative",
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <MessageStream />
        </Box>
        {session?.channel ? (
          <ChannelComposer sessionId={session.id} channel={session.channel} />
        ) : session?.readonly ? (          // 只读会话(如定时任务执行留痕):隐藏输入框,仅展示执行过程
          <Box
            sx={{
              px: 2,
              py: 1.25,
              borderTop: "1px solid",
              borderColor: "divider",
              textAlign: "center",
            }}
          >
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
              该会话为定时任务执行记录,仅供查看。
            </Typography>
          </Box>
        ) : (
          <Composer
            placeholder="今天帮你做些什么?@引用对话文件,/调用技能与指令"
            variant="floating"
          />
        )}
        {/* 逐条批准卡片：绝对定位覆盖在输入框之上（不是 Modal）。
            挂在 Composer **之后**才有意义——早于它渲染就会被输入框盖住。
            `readonly` 会话永远不会收到审批请求（定时任务留痕），因此与
            上面的三个分支正交，不必再加判断。 */}
        <ApprovalCard />
      </Box>
    </Box>
  );
}

/** 横向滚动行:隐藏滚动条,溢出时两侧出现圆形箭头按钮(对应设计图 1 的「>」) */
function ScrollRow({
  children,
  sx,
}: {
  children: React.ReactNode;
  sx?: React.CSSProperties | object;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 2);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  // 内容切换(技能行 ↔ 标签行)或窗口尺寸变化后重新计算箭头可见性
  useLayoutEffect(() => {
    update();
  }, [children, update]);
  useEffect(() => {
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [update]);

  const scrollBy = (dx: number) =>
    ref.current?.scrollBy({ left: dx, behavior: "smooth" });

  return (
    <Box
      sx={{
        position: "relative",
        ...chatColumnSx,
        ...((sx as object) ?? {}),
      }}
    >
      <Box
        ref={ref}
        onScroll={update}
        sx={{
          display: "flex",
          gap: 1,
          overflowX: "auto",
          py: 0.25,
          scrollbarWidth: "none",
          "&::-webkit-scrollbar": { display: "none" },
        }}
      >
        {children}
      </Box>
      {canLeft && <ScrollArrow side="left" onClick={() => scrollBy(-280)} />}
      {canRight && <ScrollArrow side="right" onClick={() => scrollBy(280)} />}
    </Box>
  );
}

function ScrollArrow({
  side,
  onClick,
}: {
  side: "left" | "right";
  onClick: () => void;
}) {
  return (
    <IconButton
      size="small"
      onClick={onClick}
      aria-label={side === "left" ? "向左滚动" : "向右滚动"}
      sx={{
        position: "absolute",
        top: "50%",
        transform: "translateY(-50%)",
        ...(side === "left" ? { left: 4 } : { right: 4 }),
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        boxShadow: 2,
        color: "text.secondary",
        "&:hover": { color: "text.primary", bgcolor: "action.hover" },
      }}
    >
      {side === "left" ? (
        <ChevronLeftIcon fontSize="small" />
      ) : (
        <ChevronRightIcon fontSize="small" />
      )}
    </IconButton>
  );
}

/** 顶部模式按钮:无描边、选中有高对比胶囊底 */
function ModeButton({
  mode,
  active,
  onClick,
}: {
  mode: HeroMode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="small"
      startIcon={mode.icon}
      onClick={onClick}
      sx={{
        textTransform: "none",
        borderRadius: 999,
        px: 2.5,
        py: 0.5,
        minWidth: 110,
        border: "1px solid transparent",
        color: (theme) =>
          theme.palette.mode === "dark"
            ? active
              ? "#ffffff"
              : "#9aa3af"
            : active
              ? theme.palette.text.primary
              : theme.palette.text.secondary,
        bgcolor: (theme) =>
          active
            ? theme.palette.mode === "dark"
              ? "rgba(255,255,255,0.14)"
              : "rgba(15, 23, 42, 0.10)"
            : "transparent",
        fontWeight: active ? 600 : 400,
        fontSize: 13,
        boxShadow: active ? "0 1px 2px rgba(0,0,0,0.25)" : 0,
        "& .MuiButton-startIcon": { color: "inherit", marginRight: 0.75 },
        "&:hover": {
          color: (theme) =>
            theme.palette.mode === "dark"
              ? "#ffffff"
              : theme.palette.text.primary,
          bgcolor: (theme) =>
            theme.palette.mode === "dark"
              ? active
                ? "rgba(255,255,255,0.20)"
                : "rgba(255,255,255,0.08)"
              : active
                ? "rgba(15, 23, 42, 0.14)"
                : "rgba(15, 23, 42, 0.04)",
        },
      }}
    >
      {mode.label}
    </Button>
  );
}

/** 第二级:Skill 技能描边胶囊(对应设计图 1) */
function SkillChipButton({
  skill,
  onClick,
}: {
  skill: HeroSkill;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outlined"
      size="small"
      startIcon={skill.icon}
      onClick={onClick}
      sx={{
        textTransform: "none",
        borderRadius: 999,
        px: 1.75,
        py: 0.5,
        flexShrink: 0,
        whiteSpace: "nowrap",
        borderColor: "divider",
        color: "text.secondary",
        bgcolor: "background.paper",
        fontWeight: 400,
        fontSize: 13,
        "& .MuiButton-startIcon": { color: "inherit", marginRight: 0.75 },
        "&:hover": {
          borderColor: "primary.main",
          color: "primary.main",
          bgcolor: "action.hover",
        },
      }}
    >
      {skill.label}
    </Button>
  );
}

/** 第三级:提示词标签实心胶囊 + 右下小箭头(对应设计图 2) */
function PromptTagButton({
  tag,
  onClick,
}: {
  tag: HeroPromptTag;
  onClick: () => void;
}) {
  return (
    <Button
      size="small"
      onClick={onClick}
      endIcon={<SouthEastIcon sx={{ fontSize: 14 }} />}
      sx={{
        textTransform: "none",
        borderRadius: 999,
        px: 1.75,
        py: 0.5,
        flexShrink: 0,
        whiteSpace: "nowrap",
        bgcolor: (theme) =>
          theme.palette.mode === "dark"
            ? "rgba(255,255,255,0.07)"
            : "rgba(15, 23, 42, 0.06)",
        color: "text.primary",
        fontWeight: 500,
        fontSize: 13,
        "& .MuiButton-endIcon": {
          color: "text.secondary",
          marginLeft: 0.5,
        },
        "&:hover": {
          bgcolor: (theme) =>
            theme.palette.mode === "dark"
              ? "rgba(255,255,255,0.12)"
              : "rgba(15, 23, 42, 0.10)",
          color: "text.primary",
        },
      }}
    >
      {tag.label}
    </Button>
  );
}

/**
 * 助理（IM 频道）视图的输入区：**与任务视图同一个 Composer**，只是发送出口不同。
 *
 * ## 为什么不能直接用 `Composer` 的默认发送
 *
 * 默认出口是 `sessionsStore.send` → `streamAssistantReply` → 网关 `/v1/chat`，
 * 而引擎在那里执行 `session_key = f"api:{session_id}"`：客户端传什么都会被加上
 * `api:` 前缀，落到一个**全新的、与该 IM 线程无关**的会话。后果有两条，都很糟：
 * 1. 这一轮的历史不进 IM 会话，IM 那边的智能体看不到；
 * 2. 本地乐观上屏的消息会在下一次 4 秒轮询 `openExternal` 重建会话时被整段冲掉。
 *
 * 所以这里改走 `platform.runChannelTurn`（gateway `/v1/turn`）：文本作为渠道
 * inbound 消息进引擎，由 `AgentLoop` 在 `f"{channel}:{chat_id}"` 这个**本来就
 * 属于该 IM 线程**的会话里续跑一轮，回复经渠道出站真实投回 IM 并落盘。
 *
 * ## 为什么保留乐观上屏
 *
 * 引擎这一轮要跑若干秒，而回包只是「已受理」。不等轮询（最长 4 秒）先把自己的
 * 消息显示出来，手感才跟任务视图一致。**它不是最终事实**——真正的记录由引擎
 * 落盘后由轮询带回来覆盖，两边文本一致，所以覆盖是无感的。
 *
 * 失败时把这条乐观消息摘掉：宁可少一条，也不能留一条「说了但没发出去」的假消息。
 */
function ChannelComposer({
  sessionId,
  channel,
}: {
  sessionId: string;
  channel: string;
}) {
  const [busy, setBusy] = useState(false);
  const appendMessage = useSessionsStore((s) => s.appendChannelMessage);
  const dropMessage = useSessionsStore((s) => s.dropChannelMessage);

  /** 从 `nb:{channel}:{chatId}` 还原出站目标 chatId（chatId 本身可含冒号） */
  const chatId = sessionId.startsWith("nb:")
    ? sessionId.slice(3).split(":").slice(1).join(":")
    : "";

  const handleSubmit = useCallback(
    ({ text, attachmentCount }: ComposerSubmitPayload) => {
      const content = text.trim();
      if (!content || busy || !chatId) return;
      // 外部通道只收纯文本：附件无处可去，明确提示而不是静默丢弃
      if (attachmentCount > 0) {
        toast.warning("向 IM 会话发言暂不支持附件，已仅发送文字");
      }
      const optimisticId = appendMessage(sessionId, content);
      setBusy(true);
      void platform
        .runChannelTurn({ channel, chatId, content })
        .then((result) => {
          if (!result.ok) {
            // 撤回乐观消息 + 提示原因：这一轮没成立，输入框里的内容也已清掉，
            // 用户需要知道该重发，而不是对着一句永远等不到的回复。
            dropMessage(sessionId, optimisticId);
            toast.error(result.error ?? "发送失败");
            return;
          }
          // 已受理。引擎这一轮还在跑，回复与最终记录由轮询带回来（最多 4 秒）。
        })
        .finally(() => setBusy(false));
    },
    [appendMessage, busy, channel, chatId, dropMessage, sessionId],
  );

  return (
    <Composer
      placeholder="向该 IM 会话发言，助手会在同一会话里回复…"
      variant="floating"
      onSubmit={handleSubmit}
      busy={busy}
    />
  );
}
