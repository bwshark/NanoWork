import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import type { KbDepartment } from "@/lib/kb/kbClient";
import { KbAccessFields } from "@/components/knowledge/kbAtoms";

/**
 * 新建知识库。
 *
 * 完全受控（名称 / 简介 / 角色 / 部门都由调用方持有）：这个弹窗提交之后，页面还要
 * 用同一份值发请求、失败时保住用户已填的内容。把状态藏在弹窗里，失败一次就得重填。
 */
export interface CreateKbDialogProps {
  open: boolean;
  busy: boolean;
  /** 归属团队（服务端建库必须挂组织，这里只显示，不可改） */
  teamName: string;
  name: string;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  roles: readonly string[];
  onToggleRole: (role: string) => void;
  deptIds: readonly string[];
  onToggleDept: (id: string) => void;
  departments: readonly KbDepartment[];
  onClose: () => void;
  onSubmit: () => void;
}

export function CreateKbDialog({
  open,
  busy,
  teamName,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  roles,
  onToggleRole,
  deptIds,
  onToggleDept,
  departments,
  onClose,
  onSubmit,
}: CreateKbDialogProps) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>新建知识库</DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ mb: 1.5 }}>
          <Box
            sx={{
              width: 48,
              height: 48,
              flexShrink: 0,
              borderRadius: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              bgcolor: "action.hover",
              border: "1px solid",
              borderColor: "divider",
              color: "info.main",
            }}
          >
            <MenuBookOutlinedIcon sx={{ fontSize: 24 }} />
          </Box>
          <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
            <TextField
              autoFocus
              fullWidth
              size="small"
              placeholder="请输入知识库名称"
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && name.trim() !== "" && !busy) onSubmit();
              }}
              inputProps={{ "data-testid": "new-kb-name" }}
            />
            <TextField
              fullWidth
              size="small"
              placeholder="请输入知识库简介（可选）"
              value={description}
              onChange={(event) => onDescriptionChange(event.target.value)}
              inputProps={{ "data-testid": "new-kb-description" }}
            />
          </Stack>
        </Stack>

        <Stack direction="row" spacing={0.5} alignItems="baseline" sx={{ mb: 1.5 }}>
          <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>新建到团队：</Typography>
          <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{teamName}</Typography>
        </Stack>

        <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 0.5 }}>
          知识库成员与权限
        </Typography>
        <KbAccessFields
          idPrefix="new-kb"
          roles={roles}
          onToggleRole={onToggleRole}
          departments={departments}
          deptIds={deptIds}
          onToggleDepartment={onToggleDept}
          rolesHint="管理员与所有者始终可见（否则会出现「建完自己看不见、也改不了」）；取消「成员」= 这个库只对管理员开放。"
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={busy || name.trim() === ""}
          data-testid="new-kb-confirm"
          onClick={onSubmit}
        >
          {busy ? "创建中…" : "新建知识库"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
