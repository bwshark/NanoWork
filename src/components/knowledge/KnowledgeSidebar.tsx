import { useState } from "react";
import { Box, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import BookmarkBorderOutlinedIcon from "@mui/icons-material/BookmarkBorderOutlined";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import type { KbOrg, KbSummary } from "@/lib/kb/kbClient";
import { SidebarSectionLabel } from "@/components/knowledge/kbAtoms";

/**
 * 左侧导航：个人知识库（占位）+ 团队 → 知识库两级树。
 *
 * ## 三条取舍
 *
 * 1. **树是全展开的**，不是「点团队才去加载它的库」：团队通常只有两三个，
 *    懒加载省下的那次请求换不来任何等待，反而让「同事说他有个库」在自己侧栏里
 *    看不见（要猜是哪一个团队）。
 * 2. **个人知识库显式标成未开放**，而不是藏起来：参考界面有它，用户会找；
 *    找不到比看到一句「还在做」更糟。
 * 3. **选中态只有一处**（当前库）：团队行也有「当前团队」的意思，但它只在
 *    没有选库时才是焦点，所以用底色深浅区分，不用两个选中样式打架。
 */
export interface KnowledgeSidebarProps {
  orgs: readonly KbOrg[];
  /** 团队 id → 该团队下我可见的知识库（服务端已按角色过滤，这里不再筛） */
  kbsByOrg: Record<string, KbSummary[]>;
  activeOrgId: string;
  activeKbId: string;
  onSelectTeam: (orgId: string) => void;
  onSelectKb: (orgId: string, kbId: string) => void;
  onCreateTeam: () => void;
  onCreateKb: (orgId: string) => void;
}

export function KnowledgeSidebar({
  orgs,
  kbsByOrg,
  activeOrgId,
  activeKbId,
  onSelectTeam,
  onSelectKb,
  onCreateTeam,
  onCreateKb,
}: KnowledgeSidebarProps) {
  // 折叠状态记「收起了哪些」，而不是「展开了哪些」：新加进来的团队默认是展开的
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (orgId: string) =>
    setCollapsed((previous) => ({ ...previous, [orgId]: !previous[orgId] }));

  return (
    <Box
      component="nav"
      data-testid="kb-sidebar"
      sx={{
        width: 236,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        bgcolor: "background.default",
        borderRight: "1px solid",
        borderColor: "divider",
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ px: 2, pt: 1.75, pb: 1.5 }}
      >
        <Typography sx={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.2 }}>
          知识库
        </Typography>
        <Box
          sx={{
            px: 0.75,
            height: 18,
            borderRadius: 9,
            display: "flex",
            alignItems: "center",
            bgcolor: "action.selected",
            color: "text.secondary",
            fontSize: 10.5,
            fontWeight: 600,
          }}
        >
          免费版
        </Box>
      </Stack>

      <Box sx={{ px: 1, pb: 1 }}>
        <SidebarSectionLabel>个人知识库</SidebarSectionLabel>
        <Tooltip
          title="个人知识库还没做：当前只支持团队知识库（资料按组织隔离）"
          placement="right"
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              px: 1.25,
              height: 30,
              borderRadius: 1.5,
              color: "text.disabled",
              cursor: "not-allowed",
            }}
          >
            <BookmarkBorderOutlinedIcon sx={{ fontSize: 16 }} />
            <Typography sx={{ fontSize: 12.5 }}>我的个人知识库</Typography>
          </Box>
        </Tooltip>
      </Box>

      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ pl: 1, pr: 0.5, pb: 0.25 }}
      >
        <SidebarSectionLabel>团队知识库</SidebarSectionLabel>
        <Tooltip title="新建团队">
          <IconButton
            size="small"
            aria-label="新建团队"
            data-testid="kb-new-team"
            onClick={onCreateTeam}
            sx={{ mb: 0.25 }}
          >
            <AddIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 1, pb: 2 }}>
        {orgs.map((org) => {
          const expanded = !collapsed[org.id];
          const kbs = kbsByOrg[org.id] ?? [];
          const isActiveTeam = org.id === activeOrgId && activeKbId === "";
          return (
            <Box key={org.id} sx={{ mb: 0.25 }}>
              <Box
                data-testid={`kb-team-${org.id}`}
                onClick={() => onSelectTeam(org.id)}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.5,
                  height: 32,
                  pr: 0.5,
                  pl: 0.5,
                  borderRadius: 1.5,
                  cursor: "pointer",
                  bgcolor: isActiveTeam ? "action.selected" : "transparent",
                  "&:hover": {
                    bgcolor: isActiveTeam ? "action.selected" : "action.hover",
                  },
                  "&:hover .kb-team-add": { opacity: 1 },
                }}
              >
                <IconButton
                  size="small"
                  aria-label={
                    expanded ? `收起 ${org.name}` : `展开 ${org.name}`
                  }
                  onClick={(event) => {
                    // 展开/收起不该顺手切换右侧内容：用户只是想把树折起来
                    event.stopPropagation();
                    toggle(org.id);
                  }}
                  sx={{ p: 0.25, color: "text.secondary" }}
                >
                  {expanded ? (
                    <ExpandMoreIcon sx={{ fontSize: 16 }} />
                  ) : (
                    <ChevronRightIcon sx={{ fontSize: 16 }} />
                  )}
                </IconButton>
                <Typography
                  sx={{
                    fontSize: 13,
                    fontWeight: isActiveTeam ? 600 : 500,
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {org.name}
                </Typography>
                <Tooltip title={`在「${org.name}」下新建知识库`}>
                  <IconButton
                    className="kb-team-add"
                    size="small"
                    aria-label={`在 ${org.name} 新建知识库`}
                    data-testid={`kb-new-kb-${org.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCreateKb(org.id);
                    }}
                    sx={{ p: 0.25, opacity: 0, transition: "opacity .12s" }}
                  >
                    <AddIcon sx={{ fontSize: 15 }} />
                  </IconButton>
                </Tooltip>
              </Box>

              {expanded && (
                <Box sx={{ pl: 2.75, pr: 0.5, pt: 0.25 }}>
                  {kbs.length === 0 ? (
                    <Typography
                      sx={{ fontSize: 11.5, color: "text.disabled", py: 0.5 }}
                    >
                      还没有知识库
                    </Typography>
                  ) : (
                    kbs.map((kb) => {
                      const selected = kb.id === activeKbId;
                      return (
                        <Box
                          key={kb.id}
                          data-testid={`kb-tree-${kb.id}`}
                          onClick={() => onSelectKb(org.id, kb.id)}
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.75,
                            height: 30,
                            px: 1,
                            borderRadius: 1.5,
                            cursor: "pointer",
                            bgcolor: selected
                              ? "action.selected"
                              : "transparent",
                            color: selected ? "text.primary" : "text.secondary",
                            "&:hover": {
                              bgcolor: selected
                                ? "action.selected"
                                : "action.hover",
                            },
                          }}
                        >
                          <MenuBookOutlinedIcon
                            sx={{ fontSize: 14, flexShrink: 0 }}
                          />
                          <Typography
                            sx={{
                              fontSize: 12.5,
                              fontWeight: selected ? 600 : 400,
                              color: selected ? "text.primary" : "inherit",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {kb.name}
                          </Typography>
                        </Box>
                      );
                    })
                  )}
                </Box>
              )}
            </Box>
          );
        })}

        {orgs.length === 0 && (
          <Typography
            sx={{ fontSize: 11.5, color: "text.disabled", px: 1.25, py: 1 }}
          >
            还没有团队。知识库挂在团队下，先建一个。
          </Typography>
        )}
      </Box>
    </Box>
  );
}
