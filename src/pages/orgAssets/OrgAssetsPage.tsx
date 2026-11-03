import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DownloadIcon from "@mui/icons-material/Download";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { toast } from "@/components/Toast";
import { findSlot } from "@/lib/prompt/promptCatalog";
import { PromptLibrary } from "@/lib/prompt/promptLibrary";
import { recordAppAudit } from "@/lib/audit/appAudit";
import {
  KB_OFFLINE_HINT,
  type KbGateway,
  type KbOrg,
} from "@/lib/kb/kbClient";
import {
  ORG_ASSET_LOGIN_REQUIRED,
  ORG_ASSET_SESSION_EXPIRED,
  type OrgAssetGateway,
} from "@/lib/orgAsset/orgAssetClient";
import {
  landAgent,
  landPrompt,
  landSkill,
  publishCandidates,
  publishDraft,
  type PublishSource,
} from "@/lib/orgAsset/orgAssetPayload";
import { createRuntimeKbGateway } from "@/sync/kbGateway";
import { createRuntimeOrgAssetGateway } from "@/sync/orgAssetGateway";
import { useAgentsStore } from "@/stores/agentsStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSkillsStore } from "@/stores/skillsStore";
import {
  ORG_ASSET_KINDS,
  ORG_ASSET_KIND_DESC,
  ORG_ASSET_KIND_LABEL,
  type OrgAsset,
  type OrgAssetKind,
  type OrgPromptPayload,
} from "@/types/orgAsset";

/**
 * 组织资产页（FR-2.6 客户端）。
 *
 * 三条纪律，都是这一页最容易做错的地方：
 *
 * 1. **能不能发布只认服务端给的角色**（`KbOrg.role`）。前端不自己算「我是不是管理员
 *    」，更不靠「接口会不会 403」来试探——角色是组织接口已经算好的事实。
 * 2. **发布的是快照，不是引用**。发布后本机那个专家再改，组织里那份**不会跟着变**
 *    （见 `types/orgAsset.ts` 文件头）。界面上「发布」按钮的文案是「发布快照」，
 *    不要写成「共享」，那会让人以为改一处全体生效。
 * 3. **导入不重复记账**。专家走 `importAgent`、技能走 `installSkill`，两者各自已经
 *    记了 `agent.import` / `skill.install`；再补一条 `orgAsset.import` 会让同一个
 *    动作在审计里出现两条（「谁改的」反而更难读）。只有提示词模板那条路径本来没有
 *    记账点，才由本页补 `orgAsset.import`。
 */
export function OrgAssetsPage({
  gateway,
  kbGateway,
}: {
  /** 用例注入用；运行时传 `undefined` 走 `sync/` 的装配 */
  gateway?: OrgAssetGateway | null;
  kbGateway?: KbGateway | null;
} = {}) {
  const client = useMemo<OrgAssetGateway | null>(
    () => (gateway !== undefined ? gateway : createRuntimeOrgAssetGateway()),
    [gateway],
  );
  const kb = useMemo<KbGateway | null>(
    () => (kbGateway !== undefined ? kbGateway : createRuntimeKbGateway()),
    [kbGateway],
  );

  const agents = useAgentsStore((s) => s.agents);
  const importAgent = useAgentsStore((s) => s.importAgent);
  const skills = useSkillsStore((s) => s.skills);
  const installSkill = useSkillsStore((s) => s.installSkill);
  const models = useModelsStore((s) => s.models);

  const [orgs, setOrgs] = useState<KbOrg[]>([]);
  const [activeOrgId, setActiveOrgId] = useState("");
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  const [assets, setAssets] = useState<OrgAsset[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [kindFilter, setKindFilter] = useState<OrgAssetKind | "all">("all");

  const [publishOpen, setPublishOpen] = useState(false);
  const [publishKind, setPublishKind] = useState<OrgAssetKind>("agent");
  const [sourceId, setSourceId] = useState("");
  const [publishName, setPublishName] = useState("");
  const [publishDesc, setPublishDesc] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");

  const [withdrawTarget, setWithdrawTarget] = useState<OrgAsset | null>(null);
  /**
   * 正在改元信息的那一条（`null` = 弹窗关闭）。
   *
   * ⛔ 这个弹窗**只改名称与说明，不给改载荷**。载荷是发布那一刻的快照，
   * 组织侧没有版本链——允许在这里改正文等于「悄悄替换掉别人已经导入的那份」，
   * 而对方本机那份不会变，两边从此对不上号。要换内容请撤回后重新发布：
   * 那会明确产生一条新资产，谁导入过一目了然。
   */
  const [editTarget, setEditTarget] = useState<OrgAsset | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  /** 待确认「覆盖我的自定义提示词」的那一条（`ConfirmDialog` 的载荷） */
  const [overwrite, setOverwrite] = useState<{
    asset: OrgAsset;
    prompt: OrgPromptPayload;
  } | null>(null);

  const activeOrg = orgs.find((org) => org.id === activeOrgId) ?? null;
  // 与 `ProjectsPage` / `KnowledgePage` 同一个判据：角色是服务端算好的，这里只是读
  const isOrgAdmin = activeOrg?.role === "admin" || activeOrg?.role === "owner";

  const loadOrgs = useCallback(async () => {
    if (!kb) return;
    setOrgsLoading(true);
    setOffline(false);
    const result = await kb.listOrgs();
    setOrgsLoading(false);
    if (!result.ok) {
      if (result.status === 0) setOffline(true);
      else if (result.unauthorized) setSessionExpired(true);
      return;
    }
    setOrgs(result.data);
    setActiveOrgId((prev) => prev || result.data[0]?.id || "");
  }, [kb]);

  const loadAssets = useCallback(
    async (orgId: string) => {
      if (!client || !orgId) return;
      setListLoading(true);
      setListError("");
      const result = await client.listAssets(orgId);
      setListLoading(false);
      if (!result.ok) {
        if (result.unauthorized) setSessionExpired(true);
        else setListError(result.message);
        setAssets([]);
        return;
      }
      setAssets(result.data);
    },
    [client],
  );

  useEffect(() => {
    void loadOrgs();
  }, [loadOrgs]);

  useEffect(() => {
    if (activeOrgId) void loadAssets(activeOrgId);
  }, [activeOrgId, loadAssets]);

  const visibleAssets = useMemo(
    () => (kindFilter === "all" ? assets : assets.filter((a) => a.kind === kindFilter)),
    [assets, kindFilter],
  );

  /** 可发布的候选：本机的专家 / 技能 / 已自定义的提示词槽位 */
  /** 提示词槽位快照：发布候选与草稿都要看它（只在用到时读一次盘内存快照） */
  const promptStates = useMemo(() => PromptLibrary.statesSync(), []);

  /** 本机的可发布来源（三个 store 的快照合在一起，判据在纯函数里） */
  const source = useMemo<PublishSource>(
    () => ({ agents, skills, promptStates }),
    [agents, skills, promptStates],
  );

  const candidates = useMemo(
    () => publishCandidates(publishKind, source),
    [publishKind, source],
  );

  /** 换种类 / 换组织时清掉上一次的选择，避免把 A 的 id 拿去发 B */
  const resetPublishForm = (kind: OrgAssetKind) => {
    setPublishKind(kind);
    setSourceId("");
    setPublishName("");
    setPublishDesc("");
    setPublishError("");
  };

  const handlePickSource = (kind: OrgAssetKind, id: string) => {
    setSourceId(id);
    setPublishError("");
    const draft = publishDraft(kind, id, source);
    if (draft) {
      setPublishName(draft.name);
      setPublishDesc(draft.description);
    }
  };

  const handlePublish = async () => {
    if (!client || !activeOrgId) return;
    const draft = publishDraft(publishKind, sourceId, source);
    if (!draft) {
      setPublishError("请选择要发布的内容");
      return;
    }
    setPublishing(true);
    setPublishError("");
    const result = await client.publishAsset(activeOrgId, {
      kind: publishKind,
      name: (publishName || draft.name).trim(),
      description: publishDesc.trim(),
      payload: draft.payload,
    });
    setPublishing(false);
    if (!result.ok) {
      // 服务端的文案会指出「缺哪个字段 / 带了哪个敏感键」，别翻译成笼统的失败
      if (result.unauthorized) setSessionExpired(true);
      else setPublishError(result.message);
      return;
    }
    recordAppAudit({
      action: "orgAsset.publish",
      targetId: result.data.id,
      targetLabel: result.data.name,
      detail: { kind: result.data.kind },
    });
    toast.success(`已发布到组织：${result.data.name}`);
    setPublishOpen(false);
    void loadAssets(activeOrgId);
  };

  const handleWithdraw = async () => {
    const target = withdrawTarget;
    if (!client || !activeOrgId || !target) return;
    setWithdrawTarget(null);
    const result = await client.withdrawAsset(activeOrgId, target.id);
    if (!result.ok) {
      if (result.unauthorized) setSessionExpired(true);
      else setListError(result.message);
      return;
    }
    recordAppAudit({
      action: "orgAsset.withdraw",
      targetId: target.id,
      targetLabel: target.name,
      detail: { kind: target.kind },
    });
    toast.success(`已撤回：${target.name}`);
    void loadAssets(activeOrgId);
  };

  /** 打开编辑弹窗：用列表里的现值回填。列表就是最新快照，不必再请求一次 */
  const openEdit = (asset: OrgAsset) => {
    setEditTarget(asset);
    setEditName(asset.name);
    setEditDesc(asset.description ?? "");
    setEditError("");
  };

  const handleEdit = async () => {
    const target = editTarget;
    if (!client || !activeOrgId || !target) return;
    const name = editName.trim();
    if (name === "") {
      setEditError("名称不能为空");
      return;
    }

    // 只送**真正改过**的字段：两个都没动就不发请求，也就不留一条空审计
    const patch: { name?: string; description?: string } = {};
    if (name !== target.name) patch.name = name;
    const desc = editDesc.trim();
    if (desc !== (target.description ?? "")) patch.description = desc;
    if (Object.keys(patch).length === 0) {
      setEditTarget(null);
      return;
    }

    setEditSaving(true);
    setEditError("");
    const result = await client.updateAsset(activeOrgId, target.id, patch);
    setEditSaving(false);

    if (!result.ok) {
      // 与发布同一条纪律：服务端的原话（「名称已被占用」之类）直接给人看
      if (result.unauthorized) {
        setSessionExpired(true);
        setEditTarget(null);
      } else {
        setEditError(result.message);
      }
      return;
    }

    recordAppAudit({
      action: "orgAsset.update",
      targetId: target.id,
      targetLabel: result.data.name,
      // 记**字段名**而不是值：审计要能回答「改了什么」，但不是内容仓库
      detail: { fields: Object.keys(patch).join(",") },
    });
    toast.success(`已更新：${result.data.name}`);
    setEditTarget(null);
    void loadAssets(activeOrgId);
  };

  /** 真正把提示词模板写进槽位（覆盖确认之后走这里） */
  const applyPrompt = async (asset: OrgAsset, prompt: OrgPromptPayload) => {
    await PromptLibrary.save(prompt.kind, prompt.key, prompt.text);
    // 这条路径本来没有任何记账点（`PromptLibrary.save` 不记审计），所以由本页补一条
    recordAppAudit({
      action: "orgAsset.import",
      targetId: asset.id,
      targetLabel: asset.name,
      detail: { slot: `${prompt.kind}.${prompt.key}` },
    });
    toast.success(`已应用到提示词模板：${prompt.kind}.${prompt.key}`);
  };

  const handleImport = async (asset: OrgAsset) => {
    if (asset.kind === "agent") {
      const { draft, warnings } = landAgent(asset, {
        existingNames: agents.map((a) => a.name),
        knownSkillIds: skills.map((s) => s.id),
        knownPresetIds: models.map((m) => m.id),
      });
      const created = importAgent(draft);
      toast.success(`已导入专家：${created.name}`);
      // 降级说明必须显示：缺技能 / 缺模型的专家看起来与正常的一模一样
      if (warnings.length > 0) toast.warning(warnings.join("；"));
      return;
    }
    if (asset.kind === "skill") {
      const skill = landSkill(asset);
      if (!skill.prompt.trim()) {
        toast.error("这条技能没有正文，无法导入");
        return;
      }
      installSkill(skill);
      toast.success(`已安装技能：${skill.name}`);
      return;
    }
    const prompt = landPrompt(asset);
    if (!prompt || !findSlot(prompt.kind, prompt.key)) {
      toast.error("这条提示词模板的槽位已不存在，无法导入");
      return;
    }
    // 覆盖自己的自定义正文是破坏性的：先问一句（用 ConfirmDialog 而不是
    // `window.confirm` —— 后者在 Electron 里是阻塞式原生弹窗，会卡住渲染进程）
    if (PromptLibrary.isCustomized(prompt.kind, prompt.key)) {
      setOverwrite({ asset, prompt });
      return;
    }
    await applyPrompt(asset, prompt);
  };

  if (!client) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="h5" sx={{ mb: 1 }}>
          组织资产
        </Typography>
        <Alert severity="info">{ORG_ASSET_LOGIN_REQUIRED}</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3, maxWidth: 1080, margin: "0 auto" }}>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        组织资产
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        管理员把个人专家 / 技能 / 提示词模板发布为组织资产，组织内全员可见。发布的是快照：
        本机后续改动不会同步到已发布的那一份。
      </Typography>

      {sessionExpired && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {ORG_ASSET_SESSION_EXPIRED}
        </Alert>
      )}
      {offline && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {KB_OFFLINE_HINT}
        </Alert>
      )}

      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2 }}>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="org-asset-org-label">组织</InputLabel>
          <Select
            labelId="org-asset-org-label"
            label="组织"
            value={orgs.find((o) => o.id === activeOrgId) ? activeOrgId : ""}
            onChange={(e) => setActiveOrgId(e.target.value)}
            disabled={orgsLoading || orgs.length === 0}
          >
            {orgs.map((org) => (
              <MenuItem key={org.id} value={org.id}>
                {org.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        {isOrgAdmin && (
          <Button
            variant="contained"
            startIcon={<CloudUploadOutlinedIcon />}
            onClick={() => {
              setPublishOpen(true);
              resetPublishForm(kindFilter === "all" ? "agent" : kindFilter);
            }}
          >
            发布资产
          </Button>
        )}
        {!isOrgAdmin && activeOrg && (
          <Typography variant="caption" color="text.secondary">
            只有组织管理员可以发布或撤回资产
          </Typography>
        )}
      </Stack>

      <Tabs
        value={kindFilter}
        onChange={(_, value) => setKindFilter(value as OrgAssetKind | "all")}
        sx={{ mb: 2, minHeight: 36 }}
      >
        <Tab value="all" label="全部" sx={{ minHeight: 36 }} />
        {ORG_ASSET_KINDS.map((kind) => (
          <Tab
            key={kind}
            value={kind}
            label={ORG_ASSET_KIND_LABEL[kind]}
            sx={{ minHeight: 36 }}
          />
        ))}
      </Tabs>

      {listError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {listError}
        </Alert>
      )}

      {listLoading ? (
        <Typography variant="body2" color="text.secondary">
          加载中…
        </Typography>
      ) : visibleAssets.length === 0 ? (
        <Box sx={{ py: 6, textAlign: "center" }}>
          <Typography variant="body2" color="text.secondary">
            {orgs.length === 0 ? "还没有加入任何组织" : "这个组织还没有发布任何资产"}
          </Typography>
        </Box>
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 1.5,
          }}
        >
          {visibleAssets.map((asset) => (
            <Card key={asset.id} variant="outlined">
              <CardContent sx={{ pb: "12px !important" }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  <Chip
                    size="small"
                    label={ORG_ASSET_KIND_LABEL[asset.kind]}
                    variant="outlined"
                  />
                  <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                    {asset.name}
                  </Typography>
                </Stack>
                {asset.description && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{
                      mb: 1,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {asset.description}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary">
                  {asset.publishedByEmail || "未知发布人"} · {formatTime(asset.publishedAt)}
                </Typography>
                <Divider sx={{ my: 1 }} />
                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    startIcon={<DownloadIcon />}
                    onClick={() => void handleImport(asset)}
                  >
                    添加到我的
                  </Button>
                  {isOrgAdmin && (
                    <Button
                      size="small"
                      startIcon={<EditOutlinedIcon />}
                      onClick={() => openEdit(asset)}
                    >
                      编辑
                    </Button>
                  )}
                  {isOrgAdmin && (
                    <Button
                      size="small"
                      color="error"
                      startIcon={<DeleteOutlineIcon />}
                      onClick={() => setWithdrawTarget(asset)}
                    >
                      撤回
                    </Button>
                  )}
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Box>
      )}

      <Dialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>发布为组织资产</DialogTitle>
        <DialogContent>
          <Tabs
            value={publishKind}
            onChange={(_, value) => resetPublishForm(value as OrgAssetKind)}
            sx={{ mb: 2 }}
          >
            {ORG_ASSET_KINDS.map((kind) => (
              <Tab key={kind} value={kind} label={ORG_ASSET_KIND_LABEL[kind]} />
            ))}
          </Tabs>
          <Typography variant="caption" color="text.secondary">
            {ORG_ASSET_KIND_DESC[publishKind]}
          </Typography>

          <FormControl fullWidth size="small" sx={{ mt: 2 }}>
            <InputLabel id="org-asset-source-label">
              选择{ORG_ASSET_KIND_LABEL[publishKind]}
            </InputLabel>
            <Select
              labelId="org-asset-source-label"
              label={`选择${ORG_ASSET_KIND_LABEL[publishKind]}`}
              value={candidates.some((c) => c.id === sourceId) ? sourceId : ""}
              onChange={(e) => handlePickSource(publishKind, e.target.value)}
            >
              {candidates.length === 0 && (
                <MenuItem value="" disabled>
                  本机没有可发布的{ORG_ASSET_KIND_LABEL[publishKind]}
                </MenuItem>
              )}
              {candidates.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <TextField
            fullWidth
            size="small"
            label="名称"
            value={publishName}
            onChange={(e) => setPublishName(e.target.value)}
            sx={{ mt: 2 }}
          />
          <TextField
            fullWidth
            size="small"
            label="说明（可选）"
            value={publishDesc}
            onChange={(e) => setPublishDesc(e.target.value)}
            sx={{ mt: 2 }}
            multiline
            minRows={2}
          />

          {publishError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {publishError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setPublishOpen(false)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => void handlePublish()}
            disabled={publishing || !sourceId || publishName.trim() === ""}
          >
            {publishing ? "发布中…" : "发布"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>编辑资产信息</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            size="small"
            label="名称"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            sx={{ mt: 1 }}
          />
          <TextField
            fullWidth
            size="small"
            label="说明（可选）"
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            sx={{ mt: 2 }}
            multiline
            minRows={2}
          />
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 2 }}>
            这里只改名称与说明。内容本身是发布时的快照，改内容请撤回后重新发布——
            否则别人已经导入的那份会与组织里这份对不上。
          </Typography>

          {editError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {editError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditTarget(null)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => void handleEdit()}
            disabled={editSaving || editName.trim() === ""}
          >
            {editSaving ? "保存中…" : "保存"}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={withdrawTarget !== null}
        title="撤回组织资产"
        message={`撤回后组织里所有人都看不到「${withdrawTarget?.name ?? ""}」。已导入到别人本机的那一份不受影响。`}
        confirmText="撤回"
        danger
        onConfirm={() => void handleWithdraw()}
        onCancel={() => setWithdrawTarget(null)}
      />

      <ConfirmDialog
        open={overwrite !== null}
        title="覆盖自定义提示词"
        message={`槽位 ${overwrite?.prompt.kind ?? ""}.${overwrite?.prompt.key ?? ""} 已有自定义正文，导入会覆盖它（可在设置里恢复默认）。`}
        confirmText="覆盖"
        danger
        onConfirm={() => {
          const pending = overwrite;
          setOverwrite(null);
          if (pending) void applyPrompt(pending.asset, pending.prompt);
        }}
        onCancel={() => setOverwrite(null)}
      />
    </Box>
  );
}

/** 发布时间的展示：只到分钟，避免卡片里塞一串毫秒。ISO 解析失败就原样显示。 */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
