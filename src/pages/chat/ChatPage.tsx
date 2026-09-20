import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Box, Button, IconButton, InputBase, Typography } from "@mui/material";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import SouthEastIcon from "@mui/icons-material/SouthEast";
import SendIcon from "@mui/icons-material/Send";
import { ChatHeader } from "./ChatHeader";
import { chatColumnSx } from "./chatColumnSx";
import { MessageStream } from "./MessageStream";
import { Composer, type ComposerApi } from "./Composer";
import {
  HERO_MODES,
  type HeroMode,
  type HeroModeId,
  type HeroPromptTag,
  type HeroSkill,
} from "./heroPresets";
import { ChannelIcon } from "@/components/im/ChannelIcon";
import { toast } from "@/components/Toast";
import { hasConversation } from "@/lib/conversation";
import { platform } from "@/platform";
import { useSessionsStore } from "@/stores/sessionsStore";
import { useChannelSessionsStore } from "@/stores/channelSessionsStore";
import type { ChannelKind } from "@/types";

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
  // 空状态输入框受控文本:点击提示词标签时填入对应提示词
  const [heroText, setHeroText] = useState("");
  const composerApi = useRef<ComposerApi | null>(null);

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
        ) : session?.readonly ? (
          // 只读会话(如定时任务执行留痕):隐藏输入框,仅展示执行过程
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

/** 渠道字符串 → ChannelKind(兼容 `feishu.feishu` 前缀变体) */
function toChannelKind(channel: string): ChannelKind {
  const head = channel.split(".")[0];
  const kinds: ChannelKind[] = [
    "dingtalk",
    "feishu",
    "lark",
    "weixin",
    "wecom",
  ];
  return kinds.find((k) => k === head) ?? "dingtalk";
}

/**
 * 频道会话发送栏:智能体侧主动向 IM 用户发消息。
 * 经 gateway `/v1/send` 出站投递,gateway 同时把消息镜像进会话历史,
 * 发送成功后主动刷新一次历史,使消息立即上屏(无需等待轮询)。
 */
function ChannelComposer({
  sessionId,
  channel,
}: {
  sessionId: string;
  channel: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  /** 从 `nb:{channel}:{chatId}` 还原出站目标 chatId */
  const chatId = sessionId.startsWith("nb:")
    ? sessionId.slice(3).split(":").slice(1).join(":")
    : "";

  const handleSend = async () => {
    const content = text.trim();
    if (!content || sending || !chatId) return;
    setSending(true);
    try {
      const result = await platform.sendChannelMessage({
        channel,
        chatId,
        content,
      });
      if (result.ok) {
        setText("");
        // 镜像写入有极短延迟,稍候再刷新历史确保上屏
        setTimeout(
          () => void useChannelSessionsStore.getState().refresh(),
          400,
        );
      } else {
        toast.error(result.error ?? "发送失败");
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Box
      sx={{
        px: 2,
        py: 1.2,
        borderTop: "1px solid",
        borderColor: "divider",
        display: "flex",
        alignItems: "flex-end",
        gap: 1,
      }}
    >
      <ChannelIcon kind={toChannelKind(channel)} />
      <InputBase
        multiline
        maxRows={6}
        value={text}
        disabled={sending}
        placeholder="向该 IM 用户发送消息…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void handleSend();
          }
        }}
        sx={{ flex: 1, fontSize: 13.5, py: 0.5 }}
      />
      <IconButton
        color="primary"
        size="small"
        disabled={sending || text.trim() === ""}
        onClick={() => void handleSend()}
        aria-label="发送"
      >
        <SendIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}
