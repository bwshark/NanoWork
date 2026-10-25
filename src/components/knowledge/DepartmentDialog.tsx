import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { toast } from "@/components/Toast";
import {
  type KbDepartment,
  type KbDepartmentMember,
  type KbGateway,
} from "@/lib/kb/kbClient";

/**
 * 部门管理（FR-12.2 / FR-4.7）：建树、改名、删除、加人减人。
 *
 * ## 为什么把「新建/改名/删除」收成一组按钮，而不是行内图标
 *
 * 部门树通常只有几个节点，而**选中 + 操作**比「每行三个图标」更不容易点错：
 * 删除部门是有guard的（有子部门/有成员/被知识库引用都会 409），点错一次的代价
 * 是一句看不懂的报错。共用顶部一个输入框之后，"改名"也只需要一次点击。
 *
 * ## 三条必须说清楚的状态
 *
 * 1. **未选中 = 建根部门**：界面上用按钮文案显式表达（「新建根部门」/「在「X」下新建」）。
 * 2. **删除失败要原样报**：409 的 detail 里写着「还有 2 名成员」「仍是知识库 XX 的可见范围」，
 *    压成「删除失败」等于让用户去猜。
 * 3. **加人要求已是组织成员**：服务端会回 422，这里原样提示——部门不是邀请入口。
 */
export interface DepartmentDialogProps {
  open: boolean;
  orgId: string;
  gateway: KbGateway | null;
  onClose: () => void;
  /** 部门树变化后通知调用方（知识库页的「仅限部门」选项要跟着刷新） */
  onChanged?: () => void;
}

/** 按 `parentId` 链算深度（孤儿当根；有环时截断，不会死循环）。 */
export function departmentDepth(items: readonly KbDepartment[], id: string): number {
  const byId = new Map(items.map((item) => [item.id, item]));
  let depth = 0;
  let current = byId.get(id)?.parentId ?? "";
  while (current && depth < items.length) {
    depth += 1;
    current = byId.get(current)?.parentId ?? "";
  }
  return depth;
}

/**
 * 某部门的全部子孙 id：**移动时不可选**。
 *
 * 客户端先筛掉是为了让下拉框里只剩合法选项（选完才报错体验很差）；
 * 服务端仍然要独立校验 —— 这层筛选是可以被绕过的，它只是体验优化。
 */
function descendantIds(items: KbDepartment[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const item of items) {
    const list = childrenOf.get(item.parentId) ?? [];
    list.push(item.id);
    childrenOf.set(item.parentId, list);
  }
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}

export function DepartmentDialog({ open, orgId, gateway, onClose, onChanged }: DepartmentDialogProps) {
  const [items, setItems] = useState<KbDepartment[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [members, setMembers] = useState<KbDepartmentMember[]>([]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // 移动目标父部门（空串 = 根）。用独立状态而不是复用 `selectedId`：
  // 后者是"当前正在看的部门"，把两者混起来会出现"选了下拉框就换了右侧面板"。
  const [moveParent, setMoveParent] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  const load = useCallback(async () => {
    if (!gateway) return;
    setLoading(true);
    const result = await gateway.listDepartments(orgId);
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError("");
    setItems(result.data);
    // 选中的部门可能刚被删掉：清掉，别让右侧挂着一个不存在的部门
    setSelectedId((prev) =>
      result.data.some((item) => item.id === prev) ? prev : "",
    );
  }, [gateway, orgId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const loadMembers = useCallback(
    async (departmentId: string) => {
      if (!gateway || departmentId === "") {
        setMembers([]);
        return;
      }
      const result = await gateway.listDepartmentMembers(departmentId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setMembers(result.data);
    },
    [gateway],
  );

  useEffect(() => {
    void loadMembers(selectedId);
  }, [selectedId, loadMembers]);

  const afterChange = async () => {
    await load();
    onChanged?.();
  };

  const handleCreate = async () => {
    if (!gateway || name.trim() === "") return;
    setBusy(true);
    const result = await gateway.createDepartment(orgId, {
      name: name.trim(),
      ...(selectedId ? { parentId: selectedId } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    setName("");
    toast.success(`已创建部门「${result.data.name}」`);
    setSelectedId(result.data.id);
    await afterChange();
  };

  const handleRename = async () => {
    if (!gateway || !selected || name.trim() === "") return;
    setBusy(true);
    const result = await gateway.updateDepartment(selected.id, { name: name.trim() });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    setName("");
    toast.success("已改名");
    await afterChange();
  };

  const handleMove = async () => {
    if (!gateway || !selected) return;
    setBusy(true);
    const result = await gateway.updateDepartment(selected.id, { parentId: moveParent });
    setBusy(false);
    if (!result.ok) {
      // 环 / 层级上限的报错必须原样给出来：它解释了"为什么这次不行"
      toast.error(result.message);
      return;
    }
    toast.success(`已移动到${moveParent === "" ? "根" : "新上级"}下`);
    setMoveParent("");
    await afterChange();
  };

  const handleToggleManager = async (member: KbDepartmentMember) => {
    if (!gateway || !selected) return;
    const next = member.departmentRole === "manager" ? "member" : "manager";
    setBusy(true);
    const result = await gateway.setDepartmentMemberRole(selected.id, member.userId, next);
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    await loadMembers(selected.id);
    await afterChange();
  };

  const handleDelete = async () => {
    if (!gateway || !selected) return;
    setBusy(true);
    const result = await gateway.deleteDepartment(selected.id);
    setBusy(false);
    if (!result.ok) {
      // 409 的 detail 里写着具体原因（还有成员 / 被知识库引用），必须原样给出来
      toast.error(result.message);
      return;
    }
    toast.success(`已删除部门「${selected.name}」`);
    setSelectedId("");
    await afterChange();
  };

  const handleAddMember = async () => {
    if (!gateway || !selected || email.trim() === "") return;
    setBusy(true);
    const result = await gateway.addDepartmentMember(selected.id, email.trim());
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    setEmail("");
    await loadMembers(selected.id);
    await afterChange();
  };

  const handleRemoveMember = async (userId: string) => {
    if (!gateway || !selected) return;
    setBusy(true);
    const result = await gateway.removeDepartmentMember(selected.id, userId);
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    await loadMembers(selected.id);
    await afterChange();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>部门</DialogTitle>
      <DialogContent dividers>
        {error !== "" && (
          <Typography sx={{ fontSize: 12.5, color: "warning.main", mb: 1 }} data-testid="dept-error">
            {error}
          </Typography>
        )}

        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <TextField
            size="small"
            label="部门名称"
            value={name}
            onChange={(event) => setName(event.target.value)}
            inputProps={{ "data-testid": "dept-name-input" }}
            sx={{ width: 220 }}
          />
          <Button
            size="small"
            variant="contained"
            data-testid="dept-create"
            disabled={busy || name.trim() === ""}
            onClick={() => void handleCreate()}
          >
            {selected ? `在「${selected.name}」下新建` : "新建根部门"}
          </Button>
          <Button
            size="small"
            data-testid="dept-rename"
            disabled={busy || !selected || name.trim() === ""}
            onClick={() => void handleRename()}
          >
            改名
          </Button>
          <Button
            size="small"
            color="warning"
            data-testid="dept-delete"
            disabled={busy || !selected}
            onClick={() => void handleDelete()}
          >
            删除
          </Button>
        </Stack>

        {/* 移动：换父节点。下拉里只列**合法**目标（自己和自己的子孙不可选），
            层级上限由服务端按"整棵子树"算，所以这里不做猜测性禁用。 */}
        {selected !== null && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
            <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>移到</Typography>
            <Select
              size="small"
              displayEmpty
              value={moveParent}
              onChange={(event) => setMoveParent(event.target.value as string)}
              inputProps={{ "data-testid": "dept-move-parent" }}
              sx={{ width: 220, fontSize: 13 }}
              renderValue={(value) =>
                value === ""
                  ? "根（最外层）"
                  : (items.find((item) => item.id === value)?.name ?? String(value))
              }
            >
              <MenuItem value="" sx={{ fontSize: 13 }}>
                根（最外层）
              </MenuItem>
              {items
                .filter(
                  (item) =>
                    item.id !== selected.id &&
                    !descendantIds(items, selected.id).has(item.id),
                )
                .map((item) => (
                  <MenuItem key={item.id} value={item.id} sx={{ fontSize: 13 }}>
                    {item.name}
                  </MenuItem>
                ))}
            </Select>
            <Button
              size="small"
              variant="outlined"
              data-testid="dept-move"
              disabled={busy || moveParent === selected.parentId}
              onClick={() => void handleMove()}
            >
              移动
            </Button>
          </Stack>
        )}

        <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mt: 1 }}>
          <Box sx={{ width: { md: 320 }, flexShrink: 0 }}>
            {loading ? (
              <CircularProgress size={16} />
            ) : items.length === 0 ? (
              <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                还没有部门。部门用来把知识库的可见范围收窄到「某几条线的人」。
              </Typography>
            ) : (
              <List dense disablePadding>
                {items.map((item) => (
                  <ListItemButton
                    key={item.id}
                    data-testid={`dept-row-${item.id}`}
                    selected={item.id === selectedId}
                    onClick={() => {
                      setSelectedId(item.id);
                      setName("");
                    }}
                    sx={{ pl: 1 + departmentDepth(items, item.id) * 2 }}
                  >
                    <ListItemText
                      primary={item.name}
                      secondary={`${item.memberCount} 人`}
                      primaryTypographyProps={{ fontSize: 13.5 }}
                      secondaryTypographyProps={{ fontSize: 11.5 }}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
          </Box>

          <Divider orientation="vertical" flexItem sx={{ display: { xs: "none", md: "block" } }} />

          <Box sx={{ flex: 1, minWidth: 0 }}>
            {selected === null ? (
              <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                选中一个部门后可以管理它的成员。
              </Typography>
            ) : (
              <>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                  <TextField
                    size="small"
                    label="成员邮箱"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    inputProps={{ "data-testid": "dept-member-email" }}
                    helperText="只能加已经在组织里的人（部门不是邀请入口）"
                    sx={{ width: 260 }}
                  />
                  <Button
                    size="small"
                    variant="outlined"
                    data-testid="dept-add-member"
                    disabled={busy || email.trim() === ""}
                    onClick={() => void handleAddMember()}
                  >
                    加入
                  </Button>
                </Stack>
                {members.length === 0 ? (
                  <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                    「{selected.name}」还没有成员。
                  </Typography>
                ) : (
                  <Stack spacing={0.5}>
                    {members.map((member) => (
                      <Stack
                        key={member.userId}
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        data-testid={`dept-member-${member.userId}`}
                      >
                        <Typography sx={{ fontSize: 13 }}>{member.email}</Typography>
                        {/* 两个角色都要显示：组织角色决定"能不能看"，部门角色决定
                            "这条线归不归他管"，合成一个会让负责人看起来像管理员 */}
                        <Chip size="small" variant="outlined" label={member.role} />
                        <Chip
                          size="small"
                          variant={member.departmentRole === "manager" ? "filled" : "outlined"}
                          color={member.departmentRole === "manager" ? "primary" : "default"}
                          label={member.departmentRole === "manager" ? "负责人" : "成员"}
                          data-testid={`dept-member-role-${member.userId}`}
                        />
                        <Button
                          size="small"
                          data-testid={`dept-toggle-manager-${member.userId}`}
                          disabled={busy}
                          onClick={() => void handleToggleManager(member)}
                        >
                          {member.departmentRole === "manager" ? "取消负责人" : "设为负责人"}
                        </Button>
                        <Button
                          size="small"
                          color="warning"
                          onClick={() => void handleRemoveMember(member.userId)}
                        >
                          移除
                        </Button>
                      </Stack>
                    ))}
                  </Stack>
                )}
              </>
            )}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}
