import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import AddIcon from "@mui/icons-material/Add";
import { ROUTES } from "@/lib/constants";
import { toast } from "@/components/Toast";
import {
  KB_LOGIN_REQUIRED,
  KB_ROLE_LABELS,
  createKbGateway,
  type KbApiResult,
  type KbClientConfig,
  type KbDocument,
  type KbGateway,
  type KbOrg,
  type KbSearchHit,
  type KbSummary,
} from "@/lib/kbClient";
import { resolveSyncBaseUrl } from "@/sync/baseUrl";
import { getSyncRuntime } from "@/sync/runtime";

/**
 * 知识库（M7 客户端）：组织 → 知识库 → 文档 / 检索。
 *
 * ## 三条设计取舍
 *
 * 1. **不复制服务端的可见性判断**：列表与检索结果都原样显示服务端给的集合。
 *    客户端再筛一次会让「服务端漏过滤」变成看不见的 bug（而它正是本模块最该防的事）。
 * 2. **不做全局 store**：这是**服务端状态**，不是本地领域数据；进 zustand + persist
 *    只会带来「离线时读到上周的库列表」这种更糟的错觉。页面持有即用即取。
 * 3. **网关可注入**（`gateway` prop）：页面逻辑可以在用例里跑，不必 mock 整个同步运行时。
 */

const ALL_ROLES = ["member", "admin", "owner"] as const;

export function createRuntimeGateway(): KbGateway | null {
  const runtime = getSyncRuntime();
  const token = runtime?.account.getAccessToken() ?? null;
  if (!runtime || !token) return null;
  const config: KbClientConfig = { baseUrl: resolveSyncBaseUrl(), token };
  return createKbGateway(config);
}

function roleLabels(roles: readonly string[]): string {
  return roles.map((role) => KB_ROLE_LABELS[role] ?? role).join(" / ");
}

function errorText<T>(result: KbApiResult<T>): string {
  return result.ok ? "" : result.message;
}

export function KnowledgePage({ gateway }: { gateway?: KbGateway }) {
  const navigate = useNavigate();

  const [client, setClient] = useState<KbGateway | null>(gateway ?? null);
  const [needLogin, setNeedLogin] = useState(false);

  const [orgs, setOrgs] = useState<KbOrg[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string>("");
  const [orgsError, setOrgsError] = useState("");
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");

  const [kbs, setKbs] = useState<KbSummary[]>([]);
  const [activeKbId, setActiveKbId] = useState<string>("");
  const [kbsError, setKbsError] = useState("");
  const [kbsLoading, setKbsLoading] = useState(false);
  const [newKbName, setNewKbName] = useState("");
  const [newKbRoles, setNewKbRoles] = useState<string[]>([...ALL_ROLES]);

  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [docsError, setDocsError] = useState("");
  const [docsLoading, setDocsLoading] = useState(false);
  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KbSearchHit[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [searching, setSearching] = useState(false);

  const activeOrg = useMemo(() => orgs.find((org) => org.id === activeOrgId) ?? null, [orgs, activeOrgId]);
  const activeKb = useMemo(() => kbs.find((kb) => kb.id === activeKbId) ?? null, [kbs, activeKbId]);

  /** 首次进入：有注入网关就用它，否则从同步运行时取 token。 */
  useEffect(() => {
    if (gateway) {
      setClient(gateway);
      return;
    }
    const resolved = createRuntimeGateway();
    if (!resolved) {
      setNeedLogin(true);
      return;
    }
    setClient(resolved);
  }, [gateway]);

  const loadOrgs = useCallback(
    async (target: KbGateway) => {
      setOrgsLoading(true);
      setOrgsError("");
      const result = await target.listOrgs();
      setOrgsLoading(false);
      if (!result.ok) {
        if (result.unauthorized) setNeedLogin(true);
        setOrgsError(result.message);
        return;
      }
      setOrgs(result.data);
      // 只在「当前选择失效」时改选中项：否则每次刷新都会把用户踢回第一个组织
      setActiveOrgId((prev) =>
        result.data.some((org) => org.id === prev) ? prev : result.data[0]?.id ?? "",
      );
    },
    [],
  );

  useEffect(() => {
    if (client) void loadOrgs(client);
  }, [client, loadOrgs]);

  const loadKbs = useCallback(async (target: KbGateway, orgId: string) => {
    if (!orgId) {
      setKbs([]);
      setActiveKbId("");
      return;
    }
    setKbsLoading(true);
    setKbsError("");
    const result = await target.listKbs(orgId);
    setKbsLoading(false);
    if (!result.ok) {
      setKbs([]);
      setKbsError(result.message);
      return;
    }
    setKbs(result.data);
    setActiveKbId((prev) =>
      result.data.some((kb) => kb.id === prev) ? prev : result.data[0]?.id ?? "",
    );
  }, []);

  useEffect(() => {
    if (client) void loadKbs(client, activeOrgId);
  }, [client, activeOrgId, loadKbs]);

  const loadDocs = useCallback(async (target: KbGateway, kbId: string) => {
    if (!kbId) {
      setDocs([]);
      return;
    }
    setDocsLoading(true);
    setDocsError("");
    const result = await target.listDocuments(kbId);
    setDocsLoading(false);
    if (!result.ok) {
      setDocs([]);
      setDocsError(result.message);
      return;
    }
    setDocs(result.data);
  }, []);

  useEffect(() => {
    if (client) void loadDocs(client, activeKbId);
  }, [client, activeKbId, loadDocs]);

  const handleCreateOrg = async () => {
    if (!client || !newOrgName.trim()) return;
    const result = await client.createOrg(newOrgName.trim());
    if (!result.ok) {
      toast.error(errorText(result));
      return;
    }
    setNewOrgName("");
    toast.success(`已创建「${result.data.name}」`);
    await loadOrgs(client);
  };

  const handleCreateKb = async () => {
    if (!client || !activeOrgId || !newKbName.trim()) return;
    if (newKbRoles.length === 0) {
      toast.error("至少要选一个可见角色");
      return;
    }
    const result = await client.createKb(activeOrgId, {
      name: newKbName.trim(),
      allowedRoles: newKbRoles,
    });
    if (!result.ok) {
      toast.error(errorText(result));
      return;
    }
    setNewKbName("");
    setNewKbRoles([...ALL_ROLES]);
    toast.success(`已创建知识库「${result.data.name}」`);
    await loadKbs(client, activeOrgId);
  };

  const handleUpload = async () => {
    if (!client || !activeKbId || !docTitle.trim() || !docContent.trim()) return;
    const result = await client.uploadDocument(activeKbId, {
      title: docTitle.trim(),
      content: docContent,
    });
    if (!result.ok) {
      toast.error(errorText(result));
      return;
    }
    setDocTitle("");
    setDocContent("");
    toast.success(`已入库：${result.data.chunkCount} 块`);
    await loadDocs(client, activeKbId);
    await loadKbs(client, activeOrgId);
  };

  const handleSearch = async () => {
    if (!client || !activeOrgId || !query.trim()) return;
    setSearching(true);
    setSearchError("");
    const result = await client.search(activeOrgId, {
      query: query.trim(),
      kbId: activeKbId || undefined,
    });
    setSearching(false);
    if (!result.ok) {
      setHits(null);
      setSearchError(result.message);
      return;
    }
    setHits(result.data);
  };

  if (needLogin) {
    return (
      <Box sx={{ p: 2.5 }}>
        <Alert severity="info" action={<Button onClick={() => navigate(ROUTES.auth)}>去登录</Button>}>
          {KB_LOGIN_REQUIRED}。知识库是云端资源：资料的存取与可见范围都在服务端判定。
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2.5, height: "100%", display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      {/* 标题栏 */}
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Box minWidth={0}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            知识库
          </Typography>
          <Typography variant="caption" color="text.secondary">
            团队共享资料 · 按角色可见 · 检索在服务端先过滤再打分（当前为词法检索，向量检索未接入）
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          {orgs.length > 0 && (
            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel>组织</InputLabel>
              <Select
                label="组织"
                value={activeOrgId}
                onChange={(event) => {
                  setActiveOrgId(event.target.value);
                  setHits(null);
                  setSearchError("");
                }}
              >
                {orgs.map((org) => (
                  <MenuItem key={org.id} value={org.id}>
                    {org.name}（{KB_ROLE_LABELS[org.role] ?? org.role}）
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          <Button
            size="small"
            startIcon={<RefreshIcon />}
            disabled={!client || orgsLoading}
            onClick={() => {
              if (!client) return;
              void loadOrgs(client);
              void loadKbs(client, activeOrgId);
              void loadDocs(client, activeKbId);
            }}
          >
            刷新
          </Button>
        </Stack>
      </Stack>

      {orgsError && (
        <Alert severity="error" action={<Button onClick={() => client && void loadOrgs(client)}>重试</Button>}>
          {orgsError}
        </Alert>
      )}

      {/* 没有任何组织：说明白 + 给创建入口（不假装「加载中」） */}
      {!orgsLoading && !orgsError && orgs.length === 0 && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography sx={{ fontSize: 13.5, mb: 1 }}>
            你还没有加入任何组织。知识库挂在组织下，先建一个（你成为所有者），或让管理员把你加进去。
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              label="组织名称"
              value={newOrgName}
              onChange={(event) => setNewOrgName(event.target.value)}
              inputProps={{ "data-testid": "new-org-name" }}
            />
            <Button
              variant="contained"
              size="small"
              startIcon={<AddIcon />}
              disabled={!client || !newOrgName.trim()}
              onClick={() => void handleCreateOrg()}
            >
              创建组织
            </Button>
          </Stack>
        </Paper>
      )}

      {orgsLoading && (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size={14} />
          <Typography variant="caption" color="text.secondary">
            正在读取组织…
          </Typography>
        </Stack>
      )}

      {activeOrg && (
        <Stack direction="row" spacing={2} sx={{ flex: 1, minHeight: 0 }}>
          {/* 左：知识库列表 */}
          <Paper
            variant="outlined"
            sx={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0 }}
          >
            <Box sx={{ p: 1.5 }}>
              <Typography sx={{ fontSize: 13.5, fontWeight: 600, mb: 1 }}>知识库</Typography>
              <Stack direction="row" spacing={1}>
                <TextField
                  size="small"
                  placeholder="新建知识库"
                  value={newKbName}
                  onChange={(event) => setNewKbName(event.target.value)}
                  inputProps={{ "data-testid": "new-kb-name" }}
                  fullWidth
                />
                <Button
                  size="small"
                  variant="outlined"
                  disabled={!newKbName.trim()}
                  onClick={() => void handleCreateKb()}
                  sx={{ flexShrink: 0 }}
                >
                  建
                </Button>
              </Stack>
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                {ALL_ROLES.map((role) => (
                  <FormControlLabel
                    key={role}
                    control={
                      <Checkbox
                        size="small"
                        checked={newKbRoles.includes(role)}
                        onChange={(_event, checked) =>
                          setNewKbRoles((prev) =>
                            checked ? [...prev, role] : prev.filter((item) => item !== role),
                          )
                        }
                      />
                    }
                    label={<Typography sx={{ fontSize: 12 }}>{KB_ROLE_LABELS[role]}可见</Typography>}
                  />
                ))}
              </Stack>
            </Box>
            <Divider />
            {kbsError && (
              <Alert severity="error" sx={{ m: 1 }}>
                {kbsError}
              </Alert>
            )}
            <List dense sx={{ overflowY: "auto", flex: 1 }}>
              {kbs.map((kb) => (
                <ListItemButton
                  key={kb.id}
                  selected={kb.id === activeKbId}
                  onClick={() => {
                    setActiveKbId(kb.id);
                    setHits(null);
                    setSearchError("");
                  }}
                >
                  <ListItemText
                    primary={kb.name}
                    secondary={`${kb.documentCount} 篇 · ${roleLabels(kb.allowedRoles)}可见`}
                    primaryTypographyProps={{ fontSize: 13.5 }}
                  />
                </ListItemButton>
              ))}
              {!kbsLoading && kbs.length === 0 && !kbsError && (
                <Typography sx={{ fontSize: 12, color: "text.secondary", p: 2 }}>
                  这个组织下还没有你能看到的知识库。
                </Typography>
              )}
            </List>
          </Paper>

          {/* 右：选中库的文档 / 上传 / 检索 */}
          <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  size="small"
                  label="在组织内检索"
                  placeholder="例如：报销流程"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleSearch();
                  }}
                  inputProps={{ "data-testid": "kb-query" }}
                  sx={{ flex: 1 }}
                />
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<SearchIcon />}
                  disabled={searching || !query.trim()}
                  onClick={() => void handleSearch()}
                >
                  检索
                </Button>
              </Stack>
              {searchError && (
                <Alert severity="error" sx={{ mt: 1 }}>
                  {searchError}
                </Alert>
              )}
              {hits !== null && !searchError && (
                <Box sx={{ mt: 1 }} data-testid="kb-hits">
                  {hits.length === 0 ? (
                    <Typography sx={{ fontSize: 12.5, color: "text.secondary" }}>
                      没有命中。换个关键词试试（当前是词法匹配，同义词不会命中）。
                    </Typography>
                  ) : (
                    <Stack spacing={1}>
                      {hits.map((hit) => (
                        <Paper key={hit.chunkId} variant="outlined" sx={{ p: 1.25 }}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{hit.docTitle}</Typography>
                            <Chip size="small" variant="outlined" label={hit.score.toFixed(3)} />
                          </Stack>
                          <Typography sx={{ fontSize: 12.5, color: "text.secondary", mt: 0.5 }}>
                            {hit.snippet}
                          </Typography>
                        </Paper>
                      ))}
                    </Stack>
                  )}
                </Box>
              )}
            </Paper>

            <Paper variant="outlined" sx={{ p: 1.5, display: "flex", flexDirection: "column", gap: 1 }}>
              <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>
                {activeKb ? `上传到「${activeKb.name}」` : "上传文档"}
              </Typography>
              <Stack direction="row" spacing={1}>
                <TextField
                  size="small"
                  label="标题"
                  value={docTitle}
                  onChange={(event) => setDocTitle(event.target.value)}
                  inputProps={{ "data-testid": "doc-title" }}
                  sx={{ width: 240 }}
                />
                <Button
                  size="small"
                  variant="contained"
                  disabled={!activeKbId || !docTitle.trim() || !docContent.trim()}
                  onClick={() => void handleUpload()}
                >
                  入库
                </Button>
              </Stack>
              <TextField
                size="small"
                label="正文（纯文本，按空行分段；单篇上限 20 万字符）"
                value={docContent}
                onChange={(event) => setDocContent(event.target.value)}
                inputProps={{ "data-testid": "doc-content" }}
                multiline
                minRows={3}
                maxRows={6}
              />
              <Typography variant="caption" color="text.secondary">
                正文会被切成若干块入库，只有块参与检索；Office / PDF 解析尚未接入。
              </Typography>
            </Paper>

            <Paper variant="outlined" sx={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {docsError && (
                <Alert severity="error" sx={{ m: 1 }}>
                  {docsError}
                </Alert>
              )}
              <List dense>
                {docs.map((doc) => (
                  <ListItemButton key={doc.id} disabled>
                    <ListItemText
                      primary={doc.title}
                      secondary={`${doc.chars} 字 · ${doc.chunkCount} 块`}
                      primaryTypographyProps={{ fontSize: 13 }}
                    />
                  </ListItemButton>
                ))}
                {!docsLoading && docs.length === 0 && !docsError && (
                  <Typography sx={{ fontSize: 12, color: "text.secondary", p: 2 }}>
                    {activeKbId ? "这个知识库还没有文档。" : "先在左侧选一个知识库。"}
                  </Typography>
                )}
              </List>
            </Paper>
          </Box>
        </Stack>
      )}
    </Box>
  );
}
