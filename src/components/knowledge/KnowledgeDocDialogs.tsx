import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
  Typography,
} from "@mui/material";
import type { KbDepartment, KbDocument, KbSummary } from "@/lib/kb/kbClient";
import { KbAccessFields } from "@/components/knowledge/kbAtoms";

/**
 * 知识库页的四个确认 / 设置弹窗。
 *
 * 收在一个文件里而不是四个：它们共享同一套「小弹窗」排版（标题 15px、正文 13px、
 * 右下两个按钮），分开写迟早会有一个长歪。真正的业务判断都在页面里，这里只负责
 * 把当前的结论说清楚 —— 尤其是**后果不同**的那对：
 *
 * - 「删除」进回收站（可恢复）vs「彻底删除」（不可撤销）。
 *
 * 「新建文档」不在这里：它是一个整屏的编辑器抽屉，见 `NewDocDrawer`。
 */

export interface RenameDocDialogProps {
  target: KbDocument | null;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * 重命名：内容不动，所以只有一个输入框。
 *
 * 它非有不可：判重会让「同内容换个标题重传」变成 409，标题不能单独改的话，
 * 改错标题就只能删了再传（还会丢掉原来的创建时间）。
 */
export function RenameDocDialog({
  target,
  value,
  busy,
  onChange,
  onClose,
  onConfirm,
}: RenameDocDialogProps) {
  return (
    <Dialog open={target !== null} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>重命名文档</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          size="small"
          label="标题"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputProps={{ "data-testid": "kb-rename-input" }}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>
          取消
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={busy || value.trim() === ""}
          data-testid="kb-rename-confirm"
          onClick={onConfirm}
        >
          保存
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export interface DeleteDocDialogProps {
  target: KbDocument | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/** 删除（进回收站）。文案必须写清「还能捞回来」，否则用户不敢点。 */
export function DeleteDocDialog({ target, busy, onClose, onConfirm }: DeleteDocDialogProps) {
  return (
    <Dialog open={target !== null} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>删除「{target?.title}」？</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: 13 }}>
          这篇文档会进入回收站，立刻从检索结果里消失；{target?.chunkCount ?? 0} 个分块和
          索引会保留 30 天，期间可以恢复。
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>
          取消
        </Button>
        <Button
          size="small"
          color="error"
          variant="contained"
          disabled={busy}
          data-testid="kb-delete-confirm"
          onClick={onConfirm}
        >
          删除
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export interface PurgeDocDialogProps {
  target: KbDocument | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * 彻底删除：**独立的确认弹窗**。
 *
 * 与「删除」分开是刻意的：删除可恢复，彻底删除不可撤销。两者共用一个弹窗，
 * 用户会以为「反正能恢复」然后点错 —— 那是这一屏唯一一个真正不可逆的操作。
 */
export function PurgeDocDialog({ target, busy, onClose, onConfirm }: PurgeDocDialogProps) {
  return (
    <Dialog open={target !== null} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>
        彻底删除「{target?.title}」？
      </DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: 13 }}>
          分块与向量索引会被清空，无法恢复，只能重新上传。
          只想暂时移除的话，先返回文档列表再点删除即可（那会进回收站）。
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>
          取消
        </Button>
        <Button
          size="small"
          color="error"
          variant="contained"
          disabled={busy}
          data-testid="kb-purge-confirm"
          onClick={onConfirm}
        >
          彻底删除
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export interface VisibilityDialogProps {
  /** 正在改的库（null = 弹窗关着） */
  target: KbSummary | null;
  busy: boolean;
  roles: readonly string[];
  onToggleRole: (role: string) => void;
  deptIds: readonly string[];
  onToggleDept: (id: string) => void;
  departments: readonly KbDepartment[];
  onClose: () => void;
  onSave: () => void;
}

/** 改可见范围：必须回填当前值，否则用户不知道这次是收紧还是放开。 */
export function VisibilityDialog({
  target,
  busy,
  roles,
  onToggleRole,
  deptIds,
  onToggleDept,
  departments,
  onClose,
  onSave,
}: VisibilityDialogProps) {
  return (
    <Dialog open={target !== null} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontSize: 15, fontWeight: 600 }}>
        「{target?.name}」的成员与权限
      </DialogTitle>
      <DialogContent>
        <KbAccessFields
          idPrefix="kb-scope"
          roles={roles}
          onToggleRole={onToggleRole}
          departments={departments}
          deptIds={deptIds}
          onToggleDepartment={onToggleDept}
          rolesHint="角色决定「谁有这个身份能看」，部门再收窄一层；普通成员要同时满足两者。管理员与所有者始终可见。"
          emptyDepartmentsHint="这个团队还没有部门。要按部门收窄，先在「⋯ → 团队管理」里建几个。"
        />
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>
          取消
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={busy}
          data-testid="kb-scope-save"
          onClick={onSave}
        >
          保存
        </Button>
      </DialogActions>
    </Dialog>
  );
}
