import { useCallback, useEffect, useMemo, useState } from "react";
import type { SelectChangeEvent } from "@mui/material";
import {
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import DownloadIcon from "@mui/icons-material/Download";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import type {
  AuditFilters,
  AuditOutcome,
  AuditRecord,
  AuditTier,
} from "@/lib/audit/auditLog";
import type { AppAuditAction, AppAuditFilters, ParsedAppAuditRecord } from "@/lib/audit/appAudit";
import type { AuditLogReadResult } from "@/platform/types";
import {
  APPROVED_BY_LABELS,
  DEFAULT_AUDIT_FILTERS,
  OUTCOME_LABELS,
  TIER_LABELS,
  distinctValues,
  exportAuditCsv,
  filterAuditRecords,
  parseAuditLog,
  sortAuditRecords,
} from "@/lib/audit/auditLog";
import {
  APP_AUDIT_ACTION_LABELS,
  APP_AUDIT_OUTCOME_LABELS,
  DEFAULT_APP_AUDIT_FILTERS,
  appAuditActorLabel,
  distinctAppAuditActions,
  exportAppAuditCsv,
  filterAppAuditRecords,
  mergeAppAuditRecords,
  parseAppAuditLog,
  sortAppAuditRecords,
} from "@/lib/audit/appAudit";
import { platform } from "@/platform";

/**
 * 审计页的两个来源（FR-8.9）。
 *
 * 刻意**同页两档**而不是两页：两者的问题常常连在一起（「模型读了不该读的文件」
 * 往往要先看「谁把这条路径规则放宽了」），而两份记录的时间轴必须能对上。
 * 但列与筛选维度不同（工具网关有档位/命令哈希，应用操作有动作/对象），
 * 所以不做「一张表混两种行」——那会让两边的筛选项互相说谎。
 */
type AuditSource = "tool" | "app";

function formatTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // 引擎写的是 UTC ISO；展示为本地时间，便于「我哪天用的」直觉对齐。
  return d.toLocaleString();
}

function tierColor(tier: string): "success" | "warning" | "error" {
  if (tier === "allow") return "success";
  if (tier === "sandbox") return "warning";
  return "error"; // deny
}

function outcomeColor(outcome: string): "success" | "error" | "warning" {
  if (outcome === "executed") return "success";
  if (outcome === "refused") return "error";
  return "warning"; // error
}

function dirOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, "");
}

function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const ellipsisCell = {
  maxWidth: 200,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

export function AuditPage() {
  const [source, setSource] = useState<AuditSource>("tool");

  // —— 工具网关（引擎写）——
  const [result, setResult] = useState<AuditLogReadResult | null>(null);
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [skipped, setSkipped] = useState(0);
  // —— 应用操作（客户端写）——
  const [appResult, setAppResult] = useState<AuditLogReadResult | null>(null);
  const [engineAppResult, setEngineAppResult] = useState<AuditLogReadResult | null>(null);
  const [appRecords, setAppRecords] = useState<ParsedAppAuditRecord[]>([]);
  const [appSkipped, setAppSkipped] = useState(0);

  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS);
  const [appFilters, setAppFilters] = useState<AppAuditFilters>(DEFAULT_APP_AUDIT_FILTERS);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 两份都读：切档不该再等一次 IO，而两份都是本地小文件
      // 三份都读：切档不该再等一次 IO，而三份都是本地小文件
      const [toolRead, appRead, engineAppRead] = await Promise.all([
        platform.auditRead(),
        platform.auditReadApp(),
        platform.auditReadAppEngine(),
      ]);
      const parsed = parseAuditLog(toolRead.content);
      // 本机（人点的）与引擎（引擎真做了的）两份文件、同一套行格式 →
      // 合并成一条时间轴，靠 `origin` 区分，而不是把两份文件合成一份。
      const localApp = parseAppAuditLog(appRead.content, "app");
      const engineApp = parseAppAuditLog(engineAppRead.content, "engine");
      setResult(toolRead);
      setRecords(parsed.records);
      setSkipped(parsed.skipped);
      setAppResult(appRead);
      setEngineAppResult(engineAppRead);
      setAppRecords(mergeAppAuditRecords(localApp.records, engineApp.records));
      setAppSkipped(localApp.skipped + engineApp.skipped);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toolOptions = useMemo(() => distinctValues(records, "tool"), [records]);
  const agentOptions = useMemo(() => distinctValues(records, "agentId"), [records]);
  const appActionOptions = useMemo(() => distinctAppAuditActions(appRecords), [appRecords]);

  const filtered = useMemo(() => {
    const f = filterAuditRecords(records, filters);
    return sortAuditRecords(f, true);
  }, [records, filters]);

  const appFiltered = useMemo(() => {
    const f = filterAppAuditRecords(appRecords, appFilters);
    return sortAppAuditRecords(f, true);
  }, [appRecords, appFilters]);

  const setOne =
    <K extends keyof AuditFilters>(key: K) =>
    (value: AuditFilters[K]) =>
      setFilters((prev) => ({ ...prev, [key]: value }));

  const setOneApp =
    <K extends keyof AppAuditFilters>(key: K) =>
    (value: AppAuditFilters[K]) =>
      setAppFilters((prev) => ({ ...prev, [key]: value }));

  const onSelect = (key: keyof AuditFilters) => (e: SelectChangeEvent) => {
    setOne(key)(e.target.value as AuditFilters[typeof key]);
  };

  const onSelectApp = (key: keyof AppAuditFilters) => (e: SelectChangeEvent) => {
    setOneApp(key)(e.target.value as AppAuditFilters[typeof key]);
  };

  // 应用操作有两份文件：优先展示本机那份的路径；本机没有记录时退到引擎那份，
  // 免得「打开目录」指向一个不存在的文件。
  const activeResult =
    source === "tool" ? result : appResult?.exists ? appResult : engineAppResult ?? appResult;
  const engineRecordCount = appRecords.filter((r) => r.origin === "engine").length;
  const activeCount = source === "tool" ? filtered.length : appFiltered.length;

  const onExport = () => {
    if (!activeCount) return;
    const stamp = new Date().toISOString().slice(0, 10);
    if (source === "tool") {
      downloadCsv(`nanowork-audit-${stamp}.csv`, exportAuditCsv(filtered));
    } else {
      downloadCsv(`nanowork-app-audit-${stamp}.csv`, exportAppAuditCsv(appFiltered));
    }
  };

  const onOpenFolder = () => {
    if (activeResult?.path) void platform.openPath(dirOf(activeResult.path));
  };

  const resetFilters = () => {
    if (source === "tool") setFilters(DEFAULT_AUDIT_FILTERS);
    else setAppFilters(DEFAULT_APP_AUDIT_FILTERS);
  };

  const filtersActive =
    source === "tool"
      ? filters.tier !== "all" ||
        filters.outcome !== "all" ||
        filters.approvedBy !== "all" ||
        filters.agentId !== "" ||
        filters.tool !== "" ||
        filters.query !== "" ||
        filters.from !== "" ||
        filters.to !== ""
      : appFilters.action !== "all" ||
        appFilters.outcome !== "all" ||
        appFilters.query !== "" ||
        appFilters.from !== "" ||
        appFilters.to !== "";

  return (
    <Box sx={{ p: 2.5, height: "100%", display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      {/* 标题栏 */}
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Box minWidth={0}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            安全审计
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {source === "tool"
              ? "工具网关操作留痕 · 谁、何时、调了什么工具、是放行还是被拦（FR-8.9）"
              : "应用操作留痕 · 技能启停 / 插件装卸 / 配置变更 / 会话删除（FR-8.9 第二条来源）"}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }} alignItems="center">
          <ToggleButtonGroup
            size="small"
            exclusive
            value={source}
            onChange={(_e, next: AuditSource | null) => {
              // 取消选中（next 为 null）时保持当前档：两档是枚举，不是可关的开关
              if (next) setSource(next);
            }}
          >
            <ToggleButton value="tool" sx={{ px: 1.5, py: 0.25, textTransform: "none" }}>
              工具网关
            </ToggleButton>
            <ToggleButton value="app" sx={{ px: 1.5, py: 0.25, textTransform: "none" }}>
              应用操作
            </ToggleButton>
          </ToggleButtonGroup>
          <Tooltip title="重新读取日志">
            <IconButton onClick={() => void load()} disabled={loading} size="small">
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Button
            variant="outlined"
            size="small"
            startIcon={<DownloadIcon />}
            onClick={onExport}
            disabled={!activeCount}
          >
            导出 CSV
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<FolderOpenIcon />}
            onClick={onOpenFolder}
            disabled={!activeResult?.path}
          >
            打开目录
          </Button>
        </Stack>
      </Stack>

      {/* 筛选条 */}
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        {source === "tool" ? (
          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>档位</InputLabel>
              <Select label="档位" value={filters.tier} onChange={onSelect("tier")}>
                <MenuItem value="all">全部档位</MenuItem>
                <MenuItem value="allow">{TIER_LABELS.allow}</MenuItem>
                <MenuItem value="sandbox">{TIER_LABELS.sandbox}</MenuItem>
                <MenuItem value="deny">{TIER_LABELS.deny}</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>结果</InputLabel>
              <Select label="结果" value={filters.outcome} onChange={onSelect("outcome")}>
                <MenuItem value="all">全部结果</MenuItem>
                <MenuItem value="executed">{OUTCOME_LABELS.executed}</MenuItem>
                <MenuItem value="refused">{OUTCOME_LABELS.refused}</MenuItem>
                <MenuItem value="error">{OUTCOME_LABELS.error}</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 130 }}>
              <InputLabel>放行来源</InputLabel>
              <Select label="放行来源" value={filters.approvedBy} onChange={onSelect("approvedBy")}>
                <MenuItem value="all">全部来源</MenuItem>
                <MenuItem value="user">{APPROVED_BY_LABELS.user}</MenuItem>
                <MenuItem value="read_only">{APPROVED_BY_LABELS.read_only}</MenuItem>
                <MenuItem value="policy">{APPROVED_BY_LABELS.policy}</MenuItem>
                <MenuItem value="none">{APPROVED_BY_LABELS.none}</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <InputLabel>工具</InputLabel>
              <Select label="工具" value={filters.tool} onChange={onSelect("tool")}>
                <MenuItem value="">全部工具</MenuItem>
                {toolOptions.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <InputLabel>Agent</InputLabel>
              <Select label="Agent" value={filters.agentId} onChange={onSelect("agentId")}>
                <MenuItem value="">全部 Agent</MenuItem>
                {agentOptions.map((a) => (
                  <MenuItem key={a} value={a}>
                    {a}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        ) : (
          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
            <FormControl size="small" sx={{ minWidth: 170 }}>
              <InputLabel>动作</InputLabel>
              <Select label="动作" value={appFilters.action} onChange={onSelectApp("action")}>
                <MenuItem value="all">全部动作</MenuItem>
                {appActionOptions.map((a) => (
                  <MenuItem key={a} value={a}>
                    {APP_AUDIT_ACTION_LABELS[a as AppAuditAction] ?? a}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>结果</InputLabel>
              <Select label="结果" value={appFilters.outcome} onChange={onSelectApp("outcome")}>
                <MenuItem value="all">全部结果</MenuItem>
                <MenuItem value="ok">{APP_AUDIT_OUTCOME_LABELS.ok}</MenuItem>
                <MenuItem value="failed">{APP_AUDIT_OUTCOME_LABELS.failed}</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        )}
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center" sx={{ mt: 1.5 }}>
          <TextField
            size="small"
            label="关键词"
            placeholder={source === "tool" ? "工具 / Agent / 原因 / 哈希…" : "动作 / 对象 / 详情…"}
            value={source === "tool" ? filters.query : appFilters.query}
            onChange={(e) =>
              source === "tool" ? setOne("query")(e.target.value) : setOneApp("query")(e.target.value)
            }
            sx={{ minWidth: 220 }}
          />
          <TextField
            size="small"
            label="起始日期"
            type="date"
            value={source === "tool" ? filters.from : appFilters.from}
            onChange={(e) =>
              source === "tool" ? setOne("from")(e.target.value) : setOneApp("from")(e.target.value)
            }
            InputLabelProps={{ shrink: true }}
            sx={{ minWidth: 150 }}
          />
          <TextField
            size="small"
            label="截止日期"
            type="date"
            value={source === "tool" ? filters.to : appFilters.to}
            onChange={(e) =>
              source === "tool" ? setOne("to")(e.target.value) : setOneApp("to")(e.target.value)
            }
            InputLabelProps={{ shrink: true }}
            sx={{ minWidth: 150 }}
          />
          {filtersActive && (
            <Button size="small" onClick={resetFilters}>
              清除筛选
            </Button>
          )}
        </Stack>
      </Paper>

      {/* 摘要行 */}
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="body2" color="text.secondary">
          {source === "tool" ? (
            <>
              共 <b>{records.length}</b> 条
              {filtersActive && <> · 筛选后 <b>{filtered.length}</b> 条</>}
              {skipped > 0 && <> · <b>{skipped}</b> 行解析失败已跳过</>}
            </>
          ) : (
            <>
              共 <b>{appRecords.length}</b> 条
              {engineRecordCount > 0 && <> · 其中引擎记录 <b>{engineRecordCount}</b> 条</>}
              {filtersActive && <> · 筛选后 <b>{appFiltered.length}</b> 条</>}
              {appSkipped > 0 && <> · <b>{appSkipped}</b> 行解析失败已跳过</>}
            </>
          )}
        </Typography>
        {activeResult?.path && (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
            {activeResult.path}
          </Typography>
        )}
      </Stack>

      <Divider />

      {/* 表格 */}
      {!activeResult ? (
        <Typography color="text.secondary">读取中…</Typography>
      ) : !activeResult.exists ? (
        <Stack spacing={1} sx={{ mt: 4 }} alignItems="center" justifyContent="center">
          <Typography color="text.secondary">
            {source === "tool" ? "尚未生成审计日志" : "尚无应用操作记录"}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 560, textAlign: "center" }}>
            {source === "tool"
              ? `工具网关一旦执行或拦截工具调用，记录会写入 ${activeResult.path || "审计日志文件"}`
              : "在这台机器上启停技能/插件、修改连接器与渠道配置、增删专家与定时任务、删除会话、调整安全策略，都会写入这里（只记录用户发起的操作，不含从其他设备同步过来的变更；浏览器端没有本地文件，不记录）。引擎自己的动作——采纳 Dream 合并、热加载配置、重载任务库、经网关把消息发到 IM——由引擎单独写入，也会出现在这张表里（来源=引擎）"}
          </Typography>
        </Stack>
      ) : source === "tool" ? (
        <TableContainer component={Paper} variant="outlined" sx={{ flex: 1, minHeight: 0 }}>
          <Table stickyHeader size="small" sx={{ minWidth: 900 }}>
            <TableHead>
              <TableRow>
                <TableCell>时间</TableCell>
                <TableCell>工具</TableCell>
                <TableCell>档位</TableCell>
                <TableCell>结果</TableCell>
                <TableCell>放行来源</TableCell>
                <TableCell>Agent</TableCell>
                <TableCell>会话</TableCell>
                <TableCell>渠道</TableCell>
                <TableCell>命令哈希</TableCell>
                <TableCell>原因</TableCell>
                <TableCell>参数</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={`${r.line}-${r.timestamp}-${r.tool}`} hover>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{formatTime(r.timestamp)}</TableCell>
                  <TableCell sx={{ fontFamily: "monospace" }}>{r.tool}</TableCell>
                  <TableCell>
                    <Chip size="small" label={TIER_LABELS[r.tier] ?? r.tier} color={tierColor(r.tier)} variant="outlined" />
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={OUTCOME_LABELS[r.outcome] ?? r.outcome}
                      color={outcomeColor(r.outcome)}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell>{APPROVED_BY_LABELS[r.approvedBy] ?? r.approvedBy}</TableCell>
                  <TableCell sx={{ fontFamily: "monospace" }}>{r.agentId ?? "—"}</TableCell>
                  <TableCell sx={{ fontFamily: "monospace", ...ellipsisCell, maxWidth: 160 }}>
                    {r.sessionKey ?? "—"}
                  </TableCell>
                  <TableCell>{r.channel ?? "—"}</TableCell>
                  <TableCell sx={{ fontFamily: "monospace", ...ellipsisCell, maxWidth: 130 }}>
                    {r.argsDigest ? r.argsDigest.slice(0, 12) : "—"}
                  </TableCell>
                  <TableCell sx={ellipsisCell}>
                    {r.reason ? (
                      <Tooltip title={r.reason}>
                        <span>{r.reason}</span>
                      </Tooltip>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell sx={ellipsisCell}>
                    {r.args ? (
                      <Tooltip title={JSON.stringify(r.args)}>
                        <span>{JSON.stringify(r.args)}</span>
                      </Tooltip>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11} align="center" sx={{ py: 4 }} color="text.secondary">
                    没有匹配的审计记录
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ flex: 1, minHeight: 0 }}>
          <Table stickyHeader size="small" sx={{ minWidth: 900 }}>
            <TableHead>
              <TableRow>
                <TableCell>时间</TableCell>
                <TableCell>动作</TableCell>
                <TableCell>对象</TableCell>
                <TableCell>结果</TableCell>
                <TableCell>来源</TableCell>
                <TableCell>操作者</TableCell>
                <TableCell>设备</TableCell>
                <TableCell>详情</TableCell>
                <TableCell>原因</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {appFiltered.map((r) => (
                <TableRow key={`${r.line}-${r.ts}-${r.action}`} hover>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>{formatTime(r.ts)}</TableCell>
                  <TableCell>
                    <Tooltip title={r.action}>
                      <span>{APP_AUDIT_ACTION_LABELS[r.action as AppAuditAction] ?? r.action}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell sx={ellipsisCell}>
                    {r.targetLabel ?? r.targetId ?? "—"}
                    {r.targetLabel && r.targetId && r.targetLabel !== r.targetId && (
                      <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                        {r.targetId.slice(0, 8)}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={APP_AUDIT_OUTCOME_LABELS[r.outcome as "ok" | "failed"] ?? r.outcome}
                      color={r.outcome === "ok" ? "success" : "error"}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={r.origin === "engine" ? "引擎" : "本机"}
                      sx={{ fontSize: 11, color: "text.secondary" }}
                    />
                  </TableCell>
                  <TableCell sx={{ fontFamily: "monospace" }}>{appAuditActorLabel(r.actor)}</TableCell>
                  <TableCell sx={{ fontFamily: "monospace", ...ellipsisCell, maxWidth: 120 }}>
                    {r.deviceId ? r.deviceId.slice(0, 8) : "—"}
                  </TableCell>
                  <TableCell sx={ellipsisCell}>
                    {r.detail ? (
                      <Tooltip title={JSON.stringify(r.detail, null, 0)}>
                        <span>{JSON.stringify(r.detail)}</span>
                      </Tooltip>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell sx={ellipsisCell}>
                    {r.reason ? (
                      <Tooltip title={r.reason}>
                        <span>{r.reason}</span>
                      </Tooltip>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {appFiltered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} align="center" sx={{ py: 4 }} color="text.secondary">
                    没有匹配的应用操作记录
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
