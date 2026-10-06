import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SelectChangeEvent } from '@mui/material';
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
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import type {
  AuditFilters,
  AuditOutcome,
  AuditRecord,
  AuditTier,
} from '@/lib/auditLog';
import type { AuditLogReadResult } from '@/platform/types';
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
} from '@/lib/auditLog';
import { platform } from '@/platform';

function formatTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // 引擎写的是 UTC ISO；展示为本地时间，便于「我哪天用的」直觉对齐。
  return d.toLocaleString();
}

function tierColor(tier: string): 'success' | 'warning' | 'error' {
  if (tier === 'allow') return 'success';
  if (tier === 'sandbox') return 'warning';
  return 'error'; // deny
}

function outcomeColor(outcome: string): 'success' | 'error' | 'warning' {
  if (outcome === 'executed') return 'success';
  if (outcome === 'refused') return 'error';
  return 'warning'; // error
}

function dirOf(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, '');
}

function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function AuditPage() {
  const [result, setResult] = useState<AuditLogReadResult | null>(null);
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await platform.auditRead();
      const parsed = parseAuditLog(r.content);
      setResult(r);
      setRecords(parsed.records);
      setSkipped(parsed.skipped);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toolOptions = useMemo(() => distinctValues(records, 'tool'), [records]);
  const agentOptions = useMemo(() => distinctValues(records, 'agentId'), [records]);

  const filtered = useMemo(() => {
    const f = filterAuditRecords(records, filters);
    return sortAuditRecords(f, true);
  }, [records, filters]);

  const setOne =
    <K extends keyof AuditFilters>(key: K) =>
    (value: AuditFilters[K]) =>
      setFilters((prev) => ({ ...prev, [key]: value }));

  const onSelect = (key: keyof AuditFilters) => (e: SelectChangeEvent) => {
    setOne(key)(e.target.value as AuditFilters[typeof key]);
  };

  const onExport = () => {
    if (!filtered.length) return;
    downloadCsv(`nanowork-audit-${new Date().toISOString().slice(0, 10)}.csv`, exportAuditCsv(filtered));
  };

  const onOpenFolder = () => {
    if (result?.path) void platform.openPath(dirOf(result.path));
  };

  const resetFilters = () => setFilters(DEFAULT_AUDIT_FILTERS);
  const filtersActive =
    filters.tier !== 'all' ||
    filters.outcome !== 'all' ||
    filters.approvedBy !== 'all' ||
    filters.agentId !== '' ||
    filters.tool !== '' ||
    filters.query !== '' ||
    filters.from !== '' ||
    filters.to !== '';

  return (
    <Box sx={{ p: 2.5, height: '100%', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      {/* 标题栏 */}
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Box minWidth={0}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            安全审计
          </Typography>
          <Typography variant="caption" color="text.secondary">
            工具网关操作留痕 · 谁、何时、调了什么工具、是放行还是被拦（FR-8.9）
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
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
            disabled={!filtered.length}
          >
            导出 CSV
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<FolderOpenIcon />}
            onClick={onOpenFolder}
            disabled={!result?.path}
          >
            打开目录
          </Button>
        </Stack>
      </Stack>

      {/* 筛选条 */}
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>档位</InputLabel>
            <Select label="档位" value={filters.tier} onChange={onSelect('tier')}>
              <MenuItem value="all">全部档位</MenuItem>
              <MenuItem value="allow">{TIER_LABELS.allow}</MenuItem>
              <MenuItem value="sandbox">{TIER_LABELS.sandbox}</MenuItem>
              <MenuItem value="deny">{TIER_LABELS.deny}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel>结果</InputLabel>
            <Select label="结果" value={filters.outcome} onChange={onSelect('outcome')}>
              <MenuItem value="all">全部结果</MenuItem>
              <MenuItem value="executed">{OUTCOME_LABELS.executed}</MenuItem>
              <MenuItem value="refused">{OUTCOME_LABELS.refused}</MenuItem>
              <MenuItem value="error">{OUTCOME_LABELS.error}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 130 }}>
            <InputLabel>放行来源</InputLabel>
            <Select label="放行来源" value={filters.approvedBy} onChange={onSelect('approvedBy')}>
              <MenuItem value="all">全部来源</MenuItem>
              <MenuItem value="user">{APPROVED_BY_LABELS.user}</MenuItem>
              <MenuItem value="read_only">{APPROVED_BY_LABELS.read_only}</MenuItem>
              <MenuItem value="policy">{APPROVED_BY_LABELS.policy}</MenuItem>
              <MenuItem value="none">{APPROVED_BY_LABELS.none}</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>工具</InputLabel>
            <Select label="工具" value={filters.tool} onChange={onSelect('tool')}>
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
            <Select label="Agent" value={filters.agentId} onChange={onSelect('agentId')}>
              <MenuItem value="">全部 Agent</MenuItem>
              {agentOptions.map((a) => (
                <MenuItem key={a} value={a}>
                  {a}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            size="small"
            label="关键词"
            placeholder="工具 / Agent / 原因 / 哈希…"
            value={filters.query}
            onChange={(e) => setOne('query')(e.target.value)}
            sx={{ minWidth: 200 }}
          />
          <TextField
            size="small"
            label="起始日期"
            type="date"
            value={filters.from}
            onChange={(e) => setOne('from')(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ minWidth: 150 }}
          />
          <TextField
            size="small"
            label="截止日期"
            type="date"
            value={filters.to}
            onChange={(e) => setOne('to')(e.target.value)}
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
          共 <b>{records.length}</b> 条
          {filtersActive && <> · 筛选后 <b>{filtered.length}</b> 条</>}
          {skipped > 0 && <> · <b>{skipped}</b> 行解析失败已跳过</>}
        </Typography>
        {result?.path && (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
            {result.path}
          </Typography>
        )}
      </Stack>

      <Divider />

      {/* 表格 */}
      {!result ? (
        <Typography color="text.secondary">读取中…</Typography>
      ) : !result.exists ? (
        <Stack spacing={1} sx={{ mt: 4 }} alignItems="center" justifyContent="center">
          <Typography color="text.secondary">尚未生成审计日志</Typography>
          <Typography variant="caption" color="text.secondary">
            工具网关一旦执行或拦截工具调用，记录会写入 {result.path || '审计日志文件'}
          </Typography>
        </Stack>
      ) : (
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
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatTime(r.timestamp)}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{r.tool}</TableCell>
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
                  <TableCell sx={{ fontFamily: 'monospace' }}>{r.agentId ?? '—'}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.sessionKey ?? '—'}
                  </TableCell>
                  <TableCell>{r.channel ?? '—'}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.argsDigest ? r.argsDigest.slice(0, 12) : '—'}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.reason ? (
                      <Tooltip title={r.reason}>
                        <span>{r.reason}</span>
                      </Tooltip>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.args ? (
                      <Tooltip title={JSON.stringify(r.args)}>
                        <span>{JSON.stringify(r.args)}</span>
                      </Tooltip>
                    ) : (
                      '—'
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
      )}
    </Box>
  );
}
