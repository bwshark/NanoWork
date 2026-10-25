import { useState, type ReactNode } from "react";
import {
  Box,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import { KbTile } from "@/components/knowledge/kbAtoms";

/** 「+」/「⋯」菜单里的一项。`group` 变化时插一条分组标题。 */
export interface KbMenuItem {
  key: string;
  label: string;
  group: string;
  icon?: ReactNode;
  /** 副标题：用来解释「点了会发生什么」，或者说明为什么点不了 */
  hint?: string;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface KnowledgeHeaderProps {
  variant: "team" | "kb";
  title: string;
  subtitle: ReactNode;
  /** 「+」里的项（新建 / 上传 / 导入） */
  addItems: readonly KbMenuItem[];
  /** 「⋯」里的项（成员与权限 / 管理 / 刷新） */
  moreItems: readonly KbMenuItem[];
  /** 最右侧的主操作（新建知识库 / 上传文件）。刻意放在 + 之后，与参考界面一致 */
  primary?: ReactNode;
}

/**
 * 内容区顶栏：头像 + 名称 + 「+」+「⋯」+ 主操作。
 *
 * 「+」里的未开放项**显式灰掉并写「暂未支持」**，不做成可点但无反应：
 * 点了没反应会被读成「卡了」，而灰掉 + 一句原因是一个明确的结论。
 */
export function KnowledgeHeader({
  variant,
  title,
  subtitle,
  addItems,
  moreItems,
  primary,
}: KnowledgeHeaderProps) {
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);

  const renderItems = (items: readonly KbMenuItem[]) => {
    let lastGroup = "";
    const nodes: ReactNode[] = [];
    for (const item of items) {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        nodes.push(
          <Typography
            key={`group-${item.group}`}
            sx={{
              px: 2,
              pt: nodes.length === 0 ? 0.75 : 1.25,
              pb: 0.5,
              fontSize: 11,
              fontWeight: 600,
              color: "text.secondary",
            }}
          >
            {item.group}
          </Typography>,
        );
      }
      nodes.push(
        <MenuItem
          key={item.key}
          data-testid={`kb-menu-${item.key}`}
          disabled={item.disabled}
          onClick={() => {
            setAddAnchor(null);
            setMoreAnchor(null);
            item.onSelect?.();
          }}
          sx={{ py: 0.6 }}
        >
          {item.icon !== undefined && (
            <ListItemIcon sx={{ minWidth: 34, color: "text.secondary" }}>{item.icon}</ListItemIcon>
          )}
          <ListItemText
            primary={item.label}
            secondary={item.hint}
            primaryTypographyProps={{ fontSize: 13 }}
            secondaryTypographyProps={{ fontSize: 11 }}
          />
        </MenuItem>,
      );
    }
    return nodes;
  };

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.5}
      sx={{ px: 2.5, py: 1.5, borderBottom: "1px solid", borderColor: "divider" }}
    >
      <KbTile variant={variant} size={38} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography
          data-testid="kb-title"
          sx={{
            fontSize: 15.5,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </Typography>
        <Box sx={{ minWidth: 0 }}>{subtitle}</Box>
      </Box>

      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ flexShrink: 0 }}>
        <IconButton
          size="small"
          aria-label="添加知识"
          data-testid="kb-add-menu"
          onClick={(event) => setAddAnchor(event.currentTarget)}
        >
          <AddIcon fontSize="small" />
        </IconButton>
        <IconButton
          size="small"
          aria-label="更多操作"
          data-testid="kb-more-menu"
          onClick={(event) => setMoreAnchor(event.currentTarget)}
        >
          <MoreHorizIcon fontSize="small" />
        </IconButton>
        {primary}
      </Stack>

      <Menu
        anchorEl={addAnchor}
        open={addAnchor !== null}
        onClose={() => setAddAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: 264, py: 0.5 } } }}
      >
        {renderItems(addItems)}
      </Menu>

      <Menu
        anchorEl={moreAnchor}
        open={moreAnchor !== null}
        onClose={() => setMoreAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: 232, py: 0.5 } } }}
      >
        {renderItems(moreItems)}
      </Menu>
    </Stack>
  );
}

/** 顶栏副标题（角色 / 数量这类一行字）。 */
export function HeaderSubtitle({ children }: { children: ReactNode }) {
  return (
    <Typography
      sx={{
        fontSize: 11.5,
        color: "text.secondary",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </Typography>
  );
}
