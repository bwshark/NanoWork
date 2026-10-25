import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import PersonRemoveOutlinedIcon from "@mui/icons-material/PersonRemoveOutlined";
import { toast } from "@/components/Toast";
import { KB_ROLE_LABELS, type KbGateway, type KbOrgMember } from "@/lib/kb/kbClient";

/**
 * 团队成员与权限（组织成员）。
 *
 * ## 这一层与「知识库的可见角色」不是一回事
 *
 * 这里改的是「他在这家公司是什么身份」，会同时影响**所有**知识库的默认可见性；
 * 库级的 `allowedRoles` 决定的是「这个身份能不能看这一本」。界面上把两者混着说，
 * 用户会以为「把他从管理员降成成员」= 「把他从某个库踢出去」。
 *
 * ## 服务端会拦的三件事（前端只负责原样转达）
 *
 * - 不能授予高于自己的角色（403）；
 * - 不能把最后一个 owner 降级 / 移除（409）；
 * - 按邮箱加人要求对方**已有账户**（404）。
 */
export interface TeamMembersDialogProps {
  open: boolean;
  orgId: string;
  teamName: string;
  gateway: KbGateway | null;
  onClose: () => void;
  /** 成员变动后通知页面（侧栏的库列表可能跟着变） */
  onChanged?: () => void;
}

export function TeamMembersDialog({
  open,
  orgId,
  teamName,
  gateway,
  onClose,
  onChanged,
}: TeamMembersDialogProps) {
  const [members, setMembers] = useState<KbOrgMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");

  const load = useCallback(async () => {
    if (!gateway || orgId === "") return;
    setLoading(true);
    const result = await gateway.listMembers(orgId);
    setLoading(false);
    if (!result.ok) {
      setMembers([]);
      setError(result.message);
      return;
    }
    setError("");
    setMembers(result.data);
  }, [gateway, orgId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const changeRole = async (member: KbOrgMember, role: string) => {
    if (!gateway || role === member.role) return;
    setBusy(true);
    const result = await gateway.updateMemberRole(orgId, member.userId, role);
    setBusy(false);
    if (!result.ok) {
      // 409「至少要保留一个 owner」这类原因必须原样说出来，压成「更新失败」等于让用户去猜
      toast.error(result.message);
      return;
    }
    toast.success(`已把 ${member.email} 设为${KB_ROLE_LABELS[result.data.role] ?? result.data.role}`);
    await load();
    onChanged?.();
  };

  const remove = async (member: KbOrgMember) => {
    if (!gateway) return;
    setBusy(true);
    const result = await gateway.removeMember(orgId, member.userId);
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(`已移除 ${member.email}`);
    await load();
    onChanged?.();
  };

  const add = async () => {
    if (!gateway || email.trim() === "") return;
    setBusy(true);
    const result = await gateway.addMember(orgId, { email: email.trim().toLowerCase() });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    setEmail("");
    toast.success(`已加入 ${result.data.email}`);
    await load();
    onChanged?.();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 0.5 }}>
        成员与权限
        <Typography component="div" sx={{ fontSize: 11.5, color: "text.secondary", mt: 0.25 }}>
          {teamName} · {members.length} 人
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
          <TextField
            size="small"
            fullWidth
            placeholder="按邮箱加人（对方需已有账户）"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void add();
            }}
            inputProps={{ "data-testid": "team-member-email" }}
          />
          <Button
            size="small"
            variant="outlined"
            disabled={busy || email.trim() === ""}
            data-testid="team-member-add"
            onClick={() => void add()}
            sx={{ flexShrink: 0 }}
          >
            添加
          </Button>
        </Stack>

        {error !== "" && (
          <Typography sx={{ fontSize: 12.5, color: "error.main", mb: 1 }}>{error}</Typography>
        )}
        {loading && members.length === 0 && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}>
            <CircularProgress size={13} />
            <Typography sx={{ fontSize: 12, color: "text.secondary" }}>正在读取成员…</Typography>
          </Stack>
        )}

        <Box sx={{ maxHeight: 280, overflowY: "auto" }}>
          {members.map((member) => (
            <Stack
              key={member.userId}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{
                py: 0.75,
                borderBottom: "1px solid",
                borderColor: "divider",
              }}
            >
              <Typography
                sx={{
                  fontSize: 12.5,
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {member.email}
              </Typography>
              <Select
                size="small"
                native
                value={member.role}
                disabled={busy}
                onChange={(event) => void changeRole(member, event.target.value)}
                inputProps={{ "data-testid": `team-member-role-${member.userId}` }}
                sx={{ fontSize: 12, height: 30, width: 92 }}
              >
                {(["owner", "admin", "member"] as const).map((role) => (
                  <option key={role} value={role}>
                    {KB_ROLE_LABELS[role]}
                  </option>
                ))}
              </Select>
              <IconButton
                size="small"
                disabled={busy}
                aria-label={`移除 ${member.email}`}
                data-testid={`team-member-remove-${member.userId}`}
                onClick={() => void remove(member)}
              >
                <PersonRemoveOutlinedIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" onClick={onClose}>
          关闭
        </Button>
      </DialogActions>
    </Dialog>
  );
}
