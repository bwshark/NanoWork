import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";

/**
 * 新建团队（= 组织）。
 *
 * ## 为什么成员是「创建时按邮箱一起加」
 *
 * 服务端的加人接口要求组织已经存在，所以只能「先建团队、再逐个加人」。把它做成
 * 一个动作（提交时顺序执行）而不是「建完再让你回去点成员管理」：刚建的团队只有
 * 自己一个人，是**最需要立刻加人**的时刻。
 *
 * ⚠️ 这里不做「可见性设置」——服务端没有「可被搜索到 / 可主动申请加入」这回事，
 * 画一个开关出来只会让人以为它生效了。
 */
export interface CreateTeamDialogProps {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  /** 提交；页面负责建团队并按邮箱加人，失败原因原样 toast */
  onSubmit: (input: { name: string; emails: string[] }) => void;
  /** 空态里已经有内联入口时，这里只作为「新建团队」按钮的落点 */
  defaultName?: string;
}

export function CreateTeamDialog({
  open,
  busy,
  onClose,
  onSubmit,
  defaultName = "",
}: CreateTeamDialogProps) {
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState("");
  const [emails, setEmails] = useState<string[]>([]);

  // 每次打开都清空：上一次失败留下的半截输入，会让人以为那是新团队的内容
  useEffect(() => {
    if (!open) return;
    setName(defaultName);
    setEmail("");
    setEmails([]);
  }, [open, defaultName]);

  const addEmail = () => {
    const value = email.trim().toLowerCase();
    if (value === "") return;
    // 去重但保序：重复输入同一个邮箱是常事，报错反而是噪音
    setEmails((previous) => (previous.includes(value) ? previous : [...previous, value]));
    setEmail("");
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>新建团队</DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <Box
            sx={{
              width: 48,
              height: 48,
              borderRadius: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              bgcolor: "action.selected",
              border: "1px solid",
              borderColor: "divider",
            }}
          >
            <GroupsOutlinedIcon sx={{ fontSize: 24 }} />
          </Box>
          <Box sx={{ flex: 1 }}>
            <TextField
              autoFocus
              fullWidth
              size="small"
              placeholder="请输入团队名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && name.trim() !== "" && !busy) {
                  onSubmit({ name: name.trim(), emails });
                }
              }}
              inputProps={{ "data-testid": "new-team-name" }}
            />
          </Box>
        </Stack>

        <Typography sx={{ fontSize: 12.5, mb: 0.75 }}>团队成员（可选）</Typography>
        <Stack direction="row" spacing={1}>
          <TextField
            size="small"
            fullWidth
            placeholder="输入成员邮箱后回车"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addEmail();
              }
            }}
            inputProps={{ "data-testid": "new-team-email" }}
          />
          <Button
            size="small"
            variant="outlined"
            disabled={email.trim() === ""}
            onClick={addEmail}
            sx={{ flexShrink: 0 }}
          >
            添加
          </Button>
        </Stack>
        {emails.length > 0 && (
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
            {emails.map((item) => (
              <Chip
                key={item}
                size="small"
                label={item}
                onDelete={() => setEmails((previous) => previous.filter((one) => one !== item))}
              />
            ))}
          </Stack>
        )}
        <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 1 }}>
          对方必须已经注册过账户（这里不发邀请邮件，加不上就说明没这个人）。
          创建后你是所有者，可随时在「成员与权限」里调整角色。
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={busy || name.trim() === ""}
          data-testid="new-team-confirm"
          onClick={() => onSubmit({ name: name.trim(), emails })}
        >
          {busy ? "创建中…" : "新建团队"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
