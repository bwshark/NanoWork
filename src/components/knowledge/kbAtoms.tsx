import type { ReactNode } from "react";
import { Box, Chip, Stack, Tooltip, Typography } from "@mui/material";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import SlideshowOutlinedIcon from "@mui/icons-material/SlideshowOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import { KB_ROLE_LABELS, type KbDepartment } from "@/lib/kb/kbClient";
import { docLook, type KbDocGlyph } from "@/lib/kb/kbDocumentMeta";

/**
 * 知识库页的共用小块（图标 / 色块 / 权限字段）。
 *
 * 抽出来的唯一理由是**一致性**：同一篇 PDF 在文件列表、知识库卡片预览、检索命中
 * 三处必须是同一个颜色，同一个团队在侧栏与标题栏必须是同一个图标。三处各写一遍
 * 图标映射，必然有一处先腐坏，而腐坏的表现是「这两个是同一个东西吗」。
 */

/** 文档类型图标（`kind` → 图标 + 配色）。 */
export function KbDocIcon({ kind, size = 18 }: { kind?: string; size?: number }) {
  const look = docLook(kind);
  const sx = { fontSize: size, color: look.tint };
  const glyphs: Record<KbDocGlyph, ReactNode> = {
    text: <ArticleOutlinedIcon sx={sx} />,
    word: <DescriptionOutlinedIcon sx={sx} />,
    pdf: <PictureAsPdfOutlinedIcon sx={sx} />,
    sheet: <TableChartOutlinedIcon sx={sx} />,
    slides: <SlideshowOutlinedIcon sx={sx} />,
  };
  return <>{glyphs[look.glyph]}</>;
}

/**
 * 圆角色块：团队 / 知识库的头像位。
 *
 * 不用彩色渐变图：这一页里「哪个是团队、哪个是库」已经由位置说清了，
 * 头像的作用只是给这一行一个视觉锚点。
 */
export function KbTile({
  variant,
  size = 36,
}: {
  variant: "team" | "kb";
  size?: number;
}) {
  return (
    <Box
      sx={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: 2,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: variant === "team" ? "action.selected" : "action.hover",
        border: "1px solid",
        borderColor: "divider",
        color: variant === "team" ? "text.primary" : "info.main",
      }}
    >
      {variant === "team" ? (
        <GroupsOutlinedIcon sx={{ fontSize: size * 0.55 }} />
      ) : (
        <MenuBookOutlinedIcon sx={{ fontSize: size * 0.55 }} />
      )}
    </Box>
  );
}

/** 侧栏分组标题（`个人知识库` / `团队知识库`）。 */
export function SidebarSectionLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      sx={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.4,
        color: "text.secondary",
        px: 1.25,
        mb: 0.5,
      }}
    >
      {children}
    </Typography>
  );
}

/** 空态文案（列表 / 卡片网格共用一套排版）。 */
export function KbEmpty({ children }: { children: ReactNode }) {
  return (
    <Box sx={{ p: 3, textAlign: "center" }}>
      <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>{children}</Typography>
    </Box>
  );
}

export interface KbAccessFieldsProps {
  /** testid 前缀：改可见范围用 `kb-scope`，新建知识库用 `new-kb` */
  idPrefix: string;
  roles: readonly string[];
  onToggleRole: (role: string) => void;
  departments: readonly KbDepartment[];
  deptIds: readonly string[];
  onToggleDepartment: (id: string) => void;
  /** 「角色」与「部门」各自的一句话说明（新建与改范围要说的不是同一句） */
  rolesHint: ReactNode;
  /** 部门为空时的说明；不传 = 整块不渲染（没部门时留一个空控件只会让人困惑） */
  emptyDepartmentsHint?: string;
}

/**
 * 「谁能看见」的字段组：角色 + 部门。
 *
 * 两个入口（新建知识库 / 改可见范围）必须用**同一份控件**：分开写的话，
 * 新建时能选的组合与改范围时能选的组合会慢慢分叉，用户会以为「建的时候少给了一个选项」。
 *
 * ## 只有「成员」是可切换的
 *
 * `cloud/app/kb/visibility.py::allows()` 对 admin / owner 是**无条件放行**（管理豁免：
 * 少了它会出现「建完看不见、也改不了」的死锁）。所以这里把这两个角色画成固定的、
 * 不可点的开关——点得动却不改变任何结果，比画死更糟：用户会以为「我把管理员关了」，
 * 然后发现同事照样看得见，进而怀疑整个权限系统。
 */
export function KbAccessFields({
  idPrefix,
  roles,
  onToggleRole,
  departments,
  deptIds,
  onToggleDepartment,
  rolesHint,
  emptyDepartmentsHint,
}: KbAccessFieldsProps) {
  return (
    <Box>
      <Typography sx={{ fontSize: 12.5, color: "text.secondary", mb: 1 }}>
        {rolesHint}
      </Typography>
      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
        <Chip
          size="small"
          label={KB_ROLE_LABELS.member}
          data-testid={`${idPrefix}-role-member`}
          color={roles.includes("member") ? "primary" : "default"}
          variant={roles.includes("member") ? "filled" : "outlined"}
          onClick={() => onToggleRole("member")}
        />
        {(["admin", "owner"] as const).map((role) => (
          <Tooltip key={role} title="管理员与所有者始终可见（服务端管理豁免），不可关闭">
            <Chip
              size="small"
              disabled
              label={KB_ROLE_LABELS[role]}
              data-testid={`${idPrefix}-role-${role}`}
              variant="outlined"
              sx={{ opacity: 0.8 }}
            />
          </Tooltip>
        ))}
      </Stack>

      {departments.length > 0 ? (
        <>
          <Typography sx={{ fontSize: 12.5, mt: 1.5, mb: 0.75 }}>
            仅限部门（不选 = 不按部门收窄）
          </Typography>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            {departments.map((item) => {
              const checked = deptIds.includes(item.id);
              return (
                <Chip
                  key={item.id}
                  size="small"
                  label={item.name}
                  data-testid={`${idPrefix}-dept-${item.id}`}
                  color={checked ? "primary" : "default"}
                  variant={checked ? "filled" : "outlined"}
                  onClick={() => onToggleDepartment(item.id)}
                />
              );
            })}
          </Stack>
          <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 0.75 }}>
            {deptIds.length === 0
              ? "不选 = 角色能看就能看"
              : "普通成员还需属于这些部门（含子部门）"}
          </Typography>
        </>
      ) : (
        emptyDepartmentsHint !== undefined && (
          <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 1.5 }}>
            {emptyDepartmentsHint}
          </Typography>
        )
      )}
    </Box>
  );
}
