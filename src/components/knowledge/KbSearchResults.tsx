import { useState } from "react";
import { Box, Button, Chip, Paper, Stack, Tooltip, Typography } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import type { KbSearchHit } from "@/lib/kb/kbClient";
import { KbDocIcon } from "@/components/knowledge/kbAtoms";

/**
 * 「检索结果」面板。
 *
 * ## 为什么不再是一条命中一张卡
 *
 * 服务端返回的是**分块**（chunk）命中：一篇文档切 7 块、7 块都被命中，旧排版就
 * 会画出 7 张一模一样的标题卡，读起来像「库里有 7 篇同名文档」，而真正要找的
 * 那篇反而被埋了。这里按文档归组：**一篇文档一张卡**，卡上是它最好的那条命中，
 * 其余收进「展开其余 N 处」。
 *
 * ## 另外三条
 *
 * 1. **片段必须截断**。分块是原文（还可能是整段 JSON），原样铺开会把一张卡撑成
 *    十几行，把下面的文件列表挤没。这里统一压成两行，并且 `overflow-wrap` 打开，
 *    否则那种没有空格的长串（id / 单行 JSON）会把整页顶出横向滚动条。
 * 2. **查询词要标出来**。用户搜「养殖」，命中片段里 4 个「养殖」要一眼看见，
 *    否则「这条跟我的查询有什么关系」得自己逐字比对。
 * 3. **必须能点开**。命中片段只有上下文，要判断「是不是我要的那篇」得看全文。
 */

export interface KbSearchResultsProps {
  hits: readonly KbSearchHit[];
  /** 原样的查询串：只用来做高亮，不改检索行为 */
  query: string;
  /** 纯词法引擎时补一句「同义词不会命中」 */
  lexicalOnly: boolean;
  /** 命中所在文档的类型（决定图标）。库里找不到时返回 undefined = 通用图标 */
  kindOf: (docId: string) => string | undefined;
  /** 点卡片 → 打开该文档；同时把命中的上下文带出去（见页面里的 viewDocId） */
  onOpenHit: (hit: KbSearchHit) => void;
  /** 关掉结果面板（不清空输入框，方便改词再搜） */
  onClear: () => void;
}

interface HitGroup {
  docId: string;
  docTitle: string;
  /** 组内最高分：排序依据是它，所以卡片上显示它而不是最后一条的分数 */
  best: number;
  hits: KbSearchHit[];
}

/** 按文档归组，**保留首次出现的顺序**（= 服务端的相关度顺序）。 */
function groupHits(hits: readonly KbSearchHit[]): HitGroup[] {
  const groups = new Map<string, HitGroup>();
  for (const hit of hits) {
    const existing = groups.get(hit.docId);
    if (existing === undefined) {
      groups.set(hit.docId, {
        docId: hit.docId,
        docTitle: hit.docTitle,
        best: hit.score,
        hits: [hit],
      });
      continue;
    }
    existing.hits.push(hit);
    if (hit.score > existing.best) existing.best = hit.score;
  }
  return [...groups.values()];
}

/**
 * 高亮词表：按空白切（与服务端一致），去重，**长的优先**。
 * 长词优先是为了「管理费用」不被「管理」先切碎。
 */
function termsOf(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.split(/\s+/)) {
    const term = raw.trim();
    if (term !== "") seen.add(term);
  }
  return [...seen].sort((left, right) => right.length - left.length);
}

interface Part {
  text: string;
  mark: boolean;
}

/** 按词表切片段（大小写不敏感）。不产生空片段，避免渲染一堆空 span。 */
function splitByTerms(text: string, terms: readonly string[]): Part[] {
  if (terms.length === 0) return [{ text, mark: false }];
  const lower = text.toLowerCase();
  const parts: Part[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let at = -1;
    let len = 0;
    for (const term of terms) {
      const found = lower.indexOf(term.toLowerCase(), cursor);
      if (found === -1) continue;
      if (at === -1 || found < at || (found === at && term.length > len)) {
        at = found;
        len = term.length;
      }
    }
    if (at === -1) {
      parts.push({ text: text.slice(cursor), mark: false });
      break;
    }
    if (at > cursor) parts.push({ text: text.slice(cursor, at), mark: false });
    parts.push({ text: text.slice(at, at + len), mark: true });
    cursor = at + len;
  }
  return parts;
}

/** 高亮底色：半透明琥珀，深浅两套主题上都不糊字（不用 `warning.main` 实心）。 */
const MARK_SX = {
  bgcolor: "rgba(250, 204, 21, .28)",
  color: "text.primary",
  borderRadius: 0.5,
  px: 0.15,
} as const;

function Snippet({ text, terms }: { text: string; terms: readonly string[] }) {
  // 分块里保留着换行与多空格（原文如此）：压成单行再截断，否则两行 clamp 会先被空行吃掉
  const flat = text.replace(/\s+/g, " ").trim();
  return (
    <Typography
      component="div"
      sx={{
        fontSize: 12,
        lineHeight: 1.6,
        color: "text.secondary",
        // 长串（id / 单行 JSON）是横向滚动条的来源，必须允许任意位置断行
        wordBreak: "break-word",
        overflowWrap: "anywhere",
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}
    >
      {splitByTerms(flat, terms).map((part, index) =>
        part.mark ? (
          <Box component="mark" key={index} sx={MARK_SX}>
            {part.text}
          </Box>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </Typography>
  );
}

/** 一条文档组默认展开几条命中：两条足够判断「是不是这页」，再多就得自己点 */
const VISIBLE_HITS = 2;

export function KbSearchResults({
  hits,
  query,
  lexicalOnly,
  kindOf,
  onOpenHit,
  onClear,
}: KbSearchResultsProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (hits.length === 0) {
    return (
      <Box sx={{ px: 2.5, pt: 0.5, pb: 1 }} data-testid="kb-hits">
        <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
          没有命中。换个关键词试试
          {lexicalOnly ? "（当前是词法匹配，同义词不会命中）" : "。"}
        </Typography>
      </Box>
    );
  }

  const groups = groupHits(hits);
  const terms = termsOf(query);

  return (
    <Box sx={{ px: 2.5, pt: 0.5, pb: 1 }} data-testid="kb-hits">
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
        <Typography sx={{ fontSize: 12, fontWeight: 600 }}>检索结果</Typography>
        <Typography
          data-testid="kb-hits-count"
          sx={{ fontSize: 11.5, color: "text.secondary" }}
        >
          {hits.length} 条命中 · {groups.length} 篇文档
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          data-testid="kb-hits-clear"
          onClick={onClear}
          sx={{ minWidth: 0, fontSize: 11.5, color: "text.secondary" }}
        >
          清空
        </Button>
      </Stack>

      {/* 面板自己滚：命中多的时候不能把下面的文件列表挤没（那是另一件事，不该被吃掉） */}
      <Stack spacing={0.75} sx={{ maxHeight: 296, overflowY: "auto", pr: 0.5 }}>
        {groups.map((group) => {
          const open = expanded[group.docId] === true;
          const visible = open ? group.hits : group.hits.slice(0, VISIBLE_HITS);
          const rest = group.hits.length - visible.length;
          const target = group.hits[0];
          return (
            <Paper
              key={group.docId}
              variant="outlined"
              role="button"
              tabIndex={0}
              aria-label={`打开文档 ${group.docTitle}`}
              data-testid={`kb-hit-doc-${group.docId}`}
              onClick={() => onOpenHit(target)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenHit(target);
                }
              }}
              sx={{
                borderRadius: 1.5,
                overflow: "hidden",
                cursor: "pointer",
                transition: "border-color .12s, background-color .12s",
                "&:hover": { bgcolor: "action.hover", borderColor: "text.disabled" },
                "&:focus-visible": {
                  outline: "2px solid",
                  outlineColor: "primary.main",
                  outlineOffset: -2,
                },
              }}
            >
              <Stack direction="row" alignItems="center" spacing={0.75} sx={{ px: 1.25, pt: 0.75 }}>
                <KbDocIcon kind={kindOf(group.docId)} size={15} />
                <Typography
                  sx={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {group.docTitle}
                </Typography>
                {group.hits.length > 1 && (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${group.hits.length} 处`}
                    sx={{ height: 17, fontSize: 10.5, flexShrink: 0 }}
                  />
                )}
                <Box sx={{ flex: 1 }} />
                <Tooltip title="相关度分数（越大越相关）">
                  <Typography
                    sx={{
                      fontSize: 10.5,
                      color: "text.secondary",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {group.best.toFixed(3)}
                  </Typography>
                </Tooltip>
                <OpenInNewIcon sx={{ fontSize: 13, color: "text.disabled" }} />
              </Stack>

              {/* 片段缩进到标题文字的左沿（跳过图标）：不缩进的话，多条命中会糊成
                  一坨没有归属的灰字，看不出「这两段是两条命中」 */}
              <Stack spacing={0.5} sx={{ pl: 2.75, pr: 1.25, pb: 0.75, pt: 0.25 }}>
                {visible.map((hit) => (
                  <Snippet key={hit.chunkId} text={hit.snippet} terms={terms} />
                ))}
                {rest > 0 && (
                  <Button
                    size="small"
                    data-testid={`kb-hit-more-${group.docId}`}
                    // 展开是组内动作：不拦住的话会顺带把文档打开
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpanded((previous) => ({ ...previous, [group.docId]: true }));
                    }}
                    sx={{ minWidth: 0, fontSize: 11, alignSelf: "flex-start", px: 0.5 }}
                  >
                    展开其余 {rest} 处
                  </Button>
                )}
              </Stack>
            </Paper>
          );
        })}
      </Stack>
    </Box>
  );
}
