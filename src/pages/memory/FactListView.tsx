import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  Divider,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { toast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { platformMemoryIo, userMemoryRef, workspaceMemoryRef } from '@/lib/memory/memoryPlatformIo';
import { createMemoryStore, type MemoryStore } from '@/lib/memory/memoryStore';
import { DEFAULT_DISTILL_POLICY } from '@/lib/memory/memoryDistill';
import { buildExportBundle, parseExportBundle, serializeExportBundle } from '@/lib/memory/memoryBundle';
import { platform } from '@/platform';
import { memoryDirDisplayPath } from '@/lib/memory/memoryPaths';
import { ensureLocalMemoryScope } from '@/lib/memory/memoryPlatformIo';
import { workspaceIdFor } from '@/lib/memory/memoryPaths';
import type { ConflictCase, CuratedEntry, EntryKey } from '@/types';

/**
 * 记忆 v2 的**事实视图**：系统到底记住了哪些**结论**。
 *
 * ## 为什么需要它（与「文件」视图的分工）
 *
 * v1 的记忆页是一个 Markdown 文件编辑器——用户看到的是**文本**。但 v2 的记忆已经被
 * 蒸馏过：磁盘上并存着证据（`daily/*.jsonl`）、结论（`curated.json`）、待裁决案件
 * （`conflicts.json`）与投影（`MEMORY.md`）。只给文件编辑器，用户就永远看不到
 * 「哪条被替代了、哪条在等我裁决、这条结论是从哪些证据来的」。
 *
 * 所以这里读的是 **canonical**（`curated.json`），不是投影：
 * - **事实视图**：active 修订，可停用 / 恢复 / 删除；
 * - **待裁决**：open 案件，选一个候选并给出理由。
 *
 * 这两个动作都**不是**改文件：它们走仓储的治理 API（带审计、带域终态墓碑，
 * 删除过的域不会被下一次蒸馏写回来）。
 */
export function FactListView({
  scope,
  workdir,
  reloadToken,
  onChanged,
}: {
  scope: 'user' | 'workspace';
  workdir: string | null;
  reloadToken: number;
  onChanged: () => void;
}) {
  const [store, setStore] = useState<MemoryStore | null>(null);
  const [entries, setEntries] = useState<CuratedEntry[]>([]);
  const [cases, setCases] = useState<ConflictCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 最近一次裁决失败的原因（用例与用户看同一条信息；成功时清空） */
  const [lastResolveError, setLastResolveError] = useState<string | null>(null);
  /** 最近一次归档/导出的结果说明（用户点完要有回音） */
  const [lastActionNote, setLastActionNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 裁决草稿：caseId → { candidateId, rationale } */
  const [drafts, setDrafts] = useState<Record<string, { candidateId: string; rationale: string }>>({});
  const [pendingDelete, setPendingDelete] = useState<CuratedEntry | null>(null);
  const [pendingDisable, setPendingDisable] = useState<CuratedEntry | null>(null);

  const diskPath = useMemo(
    () =>
      memoryDirDisplayPath(
        scope === 'user' ? { kind: 'user', userScope: 'local' } : { kind: 'workspace', workdir },
      ),
    [scope, workdir],
  );

  // 建仓储：用户级要先把本地 scope 取出来（与账户解耦，见 §4.7.0）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (scope === 'workspace') {
        const ws = workspaceIdFor(workdir);
        if (!cancelled) {
          setStore(createMemoryStore({ io: platformMemoryIo(workspaceMemoryRef(workdir)), workspaceId: ws }));
        }
        return;
      }
      const userScope = await ensureLocalMemoryScope();
      if (cancelled) return;
      setStore(
        createMemoryStore({
          io: platformMemoryIo(userMemoryRef(userScope)),
          workspaceId: userScope,
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, workdir]);

  const refresh = useCallback(async () => {
    if (!store) return;
    setLoading(true);
    setError(null);
    try {
      // 恢复未完成的事务（幂等）：用户打开记忆页时是最自然的恢复时机之一
      await store.recover(new Date());
      const [state, open] = await Promise.all([store.loadCuratedState(), store.listConflicts()]);
      setEntries(state.revisions);
      setCases(open);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [store]);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadToken]);

  const run = useCallback(
    async (action: () => Promise<void>, ok: string, fail: string) => {
      setBusy(true);
      try {
        await action();
        toast.success(ok);
        await refresh();
        onChanged();
      } catch (e) {
        toast.error(`${fail}：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [refresh, onChanged],
  );

  const resolveCase = (kase: ConflictCase) =>
    run(
      async () => {
        const draft = drafts[kase.conflictId];
        if (!store || !draft?.candidateId) throw new Error('请先选择一个候选');
        // 提交的是**页面上看到的那个案件版本**（`kase` 来自最近一次 `refresh()`）。
        // 证据在页面停留期间发生变化时，服务端会以 `StaleConflictResolutionError`
        // 拒绝——这正是要的行为：拿旧判断覆盖新证据比「多刷一次页面」严重得多。
        setLastResolveError(null);
        try {
          // 提交的是**页面上看到的那个案件版本**（`kase` 来自最近一次 `refresh()`）。
          // 证据在页面停留期间发生变化时，服务端会以 `StaleConflictResolutionError`
          // 拒绝——这正是要的行为：拿旧判断覆盖新证据比「多刷一次页面」严重得多。
          await store.resolve(
            {
              conflictId: kase.conflictId,
              candidateId: draft.candidateId,
              expectedRevision: kase.revision,
              actor: 'local-user',
              rationale: draft.rationale.trim() || '用户裁决',
              // 幂等键必须**每次提交都不同**，否则点两次会在审计流里撞同一个 eventId，
              // 第二次被判 `ConflictEventReuseError`（同 id 换参数）——用户看到的是
              // 「明明选了另一个候选却报错」，而他只是改了主意。
              // 真正的重复提交（网络重试）由调用方复用同一个 id 来挡；UI 这一层每次
              // 点击都是一次新的意图。
              eventId: newEventId(kase.conflictId, draft.candidateId),
            },
            new Date(),
          );
        } catch (e) {
          // 拒绝原因要留在界面上：否则用户看到的是「点了提交，什么都没发生」，
          // 而真实原因是「他看到的证据已经过期，需要重看」。
          setLastResolveError(e instanceof Error ? e.message : String(e));
          throw e;
        }
      },
      '已裁决',
      '裁决失败',
    );

  /**
   * 归档旧日志（FR-M33）。
   *
   * 三个概念刻意分开：**归档**作用在**日志文件**上（默认半年以前），与「事实满 30 天才能
   * 晋升」（`retentionDays`）是两件事。归档只移动、不删除——证据要能审计。
   */
  const archiveOldLogs = () =>
    run(
      async () => {
        if (!store) return;
        const result = await store.archive(new Date());
        setLastActionNote(
          result.archived.length === 0 && result.kept.length === 0
            ? '没有需要归档的日志（默认只归档半年以前的日文件）。'
            : `已归档 ${result.archived.length} 个日志文件（${result.movedLines} 条事实），` +
                `保留 ${result.kept.length} 个仍含较新事实的文件。归档只是移动，内容仍可查。`,
        );
      },
      '归档完成',
      '归档失败',
    );

  /**
   * 导出记忆包（FR-M35）。
   *
   * bundle 里放 **canonical + 证据**，不放投影：投影随时能从 canonical 重建，
   * 带上它只会让文件大一倍并给「以哪份为准」留下歧义。
   */
  const exportBundle = () =>
    run(
      async () => {
        if (!store) return;
        const [facts, curated, conflicts, adjudications] = await Promise.all([
          store.loadFacts(null, new Date()),
          store.loadCuratedState(),
          store.loadConflicts(),
          store.loadAdjudications(),
        ]);
        const bundle = buildExportBundle({
          workspaceId: store.workspaceId,
          // 工作区级导出时用户级内容不在本仓储里，作用域如实标成当前仓储的归属，
          // 避免把「这一份里有什么」说成「你的全部记忆都在里面」。
          userScope: store.workspaceId,
          facts,
          curated,
          conflicts,
          adjudications,
          profile: { schema: 2, userScope: store.workspaceId, profile: {}, updatedAt: new Date().toISOString() },
          preferences: {
            schema: 2,
            userScope: store.workspaceId,
            records: [],
            updatedAt: new Date().toISOString(),
          },
          now: new Date(),
        });
        const name = `nanowork-memory-${store.workspaceId}-${new Date().toISOString().slice(0, 10)}.json`;
        await platform.writeTextFile(name, serializeExportBundle(bundle));
        setLastActionNote(`已导出 ${name}（${facts.length} 条事实、${curated.revisions.length} 条结论）。`);
      },
      '导出完成',
      '导出失败',
    );

  /**
   * 导入记忆包（FR-M35）。
   *
   * 校验失败**必须原样把原因说出来**：跨工作区的包被拒绝时，用户需要知道「它属于哪个
   * 工作区」，否则他只会看到「导入失败」并反复重试同一个文件。
   */
  const importBundle = () =>
    run(
      async () => {
        if (!store) return;
        const picked = await platform.pickFile();
        if (!picked) return; // 用户取消
        const parsed = parseExportBundle(picked.content, {
          workspaceId: store.workspaceId,
          userScope: store.workspaceId,
        });
        const result = await store.importBundle(parsed, new Date());
        setLastActionNote(
          `已导入 ${result.factsImported} 条事实` +
            (result.curatedAdopted
              ? '，并采用了包里的结论（本地原本没有结论）。'
              : result.curatedSkipped > 0
                ? `；包里的 ${result.curatedSkipped} 条结论**未覆盖**本地已有结论——` +
                  '它们已作为证据进入，下一次蒸馏会按本地策略重新判断。'
                : '。'),
        );
      },
      '导入完成',
      '导入失败',
    );

  if (error) {
    return (
      <Alert severity="error" sx={{ my: 1 }}>
        读取记忆状态失败：{error}
      </Alert>
    );
  }  const active = entries.filter((e) => e.status === 'active');
  const history = entries.filter((e) => e.status !== 'active');

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        落点：{diskPath}
        {' · '}
        蒸馏门槛：事实满 {DEFAULT_DISTILL_POLICY.retentionDays} 天且（重要度 ≥{' '}
        {DEFAULT_DISTILL_POLICY.minImportance} 或重复出现 ≥ {DEFAULT_DISTILL_POLICY.repeatThreshold} 次）
      </Typography>

      <Stack direction="row" spacing={1} sx={{ mb: 1.5, flexWrap: 'wrap' }}>
        <Button size="small" onClick={() => void refresh()} disabled={busy || loading}>
          刷新
        </Button>
        <Button
          size="small"
          variant="outlined"
          disabled={busy || !store}
          onClick={() => void archiveOldLogs()}
        >
          整理旧日志
        </Button>
        <Button
          size="small"
          variant="outlined"
          disabled={busy || !store}
          onClick={() => void exportBundle()}
        >
          导出记忆包
        </Button>
        <Button
          size="small"
          variant="outlined"
          disabled={busy || !store}
          onClick={() => void importBundle()}
        >
          导入记忆包
        </Button>
      </Stack>

      {lastResolveError && (
        <Alert severity="warning" sx={{ mb: 1 }} onClose={() => setLastResolveError(null)}>
          上次裁决未生效：{lastResolveError}
        </Alert>
      )}

      {lastActionNote && (
        <Alert severity="info" sx={{ mb: 1 }} onClose={() => setLastActionNote(null)}>
          {lastActionNote}
        </Alert>
      )}

      {cases.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            待裁决（{cases.length}）
          </Typography>
          <Stack spacing={1}>
            {cases.map((kase) => {
              const draft = drafts[kase.conflictId] ?? { candidateId: '', rationale: '' };
              return (
                <Box
                  key={kase.conflictId}
                  sx={{ border: 1, borderColor: 'warning.main', borderRadius: 1, p: 1.5 }}
                >
                  <Typography variant="caption" color="text.secondary">
                    冲突域 {kase.memoryKey} · 案件版本 r{kase.revision} · 检测于{' '}
                    {new Date(kase.detectedAt).toLocaleString()}
                  </Typography>

                  <Stack spacing={0.5} sx={{ my: 1 }}>
                    {kase.candidates.map((c) => (
                      <ButtonBase
                        key={c.candidateId}
                        onClick={() =>
                          setDrafts((d) => ({
                            ...d,
                            [kase.conflictId]: { ...draft, candidateId: c.candidateId },
                          }))
                        }
                        sx={{
                          display: 'block',
                          textAlign: 'left',
                          width: '100%',
                          p: 1,
                          borderRadius: 1,
                          border: 1,
                          borderColor:
                            draft.candidateId === c.candidateId ? 'primary.main' : 'divider',
                        }}
                      >
                        <Typography variant="body2">{c.content}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          证据 {c.evidenceIds.length} 条 · 重要度 {c.importance} · 最近{' '}
                          {new Date(c.lastSeen).toLocaleDateString()}
                        </Typography>
                      </ButtonBase>
                    ))}
                  </Stack>
                  <TextField
                    size="small"
                    fullWidth
                    placeholder="裁决理由（会写进审计）"
                    value={draft.rationale}
                    onChange={(e) =>
                      setDrafts((d) => ({
                        ...d,
                        [kase.conflictId]: { ...draft, rationale: e.target.value },
                      }))
                    }
                  />
                  <Box sx={{ mt: 1, display: 'flex', gap: 1 }}>
                    <Button
                      size="small"
                      variant="contained"
                      disabled={busy || !draft.candidateId}
                      onClick={() => void resolveCase(kase)}
                    >
                      提交裁决
                    </Button>
                    <Button size="small" onClick={() => void refresh()} disabled={busy}>
                      刷新（证据可能已变化）
                    </Button>
                  </Box>
                </Box>
              );
            })}
          </Stack>
          <Divider sx={{ my: 2 }} />
        </Box>
      )}

      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        生效中的结论（{active.length}）
        {loading && ' · 读取中…'}
      </Typography>
      {active.length === 0 && !loading && (
        <Typography variant="body2" color="text.secondary">
          还没有蒸馏出的结论。继续工作，事实满 {DEFAULT_DISTILL_POLICY.retentionDays} 天后会自动提炼。
        </Typography>
      )}
      <Stack spacing={1}>
        {active.map((entry) => (
          <EntryRow
            key={`${entry.entryKey}#${entry.revision}`}
            entry={entry}
            busy={busy}
            onDisable={() => setPendingDisable(entry)}
            onDelete={() => setPendingDelete(entry)}
          />
        ))}
      </Stack>

      {history.length > 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            历史与已停用（{history.length}）
          </Typography>
          <Stack spacing={1}>
            {history.map((entry) => (
              <EntryRow
                key={`${entry.entryKey}#${entry.revision}`}
                entry={entry}
                busy={busy}
                onEnable={
                  entry.status === 'disabled'
                    ? () => void run(() => store!.enable(entry.entryKey, new Date()), '已恢复', '恢复失败')
                    : undefined
                }
                onDelete={() => setPendingDelete(entry)}
              />
            ))}
          </Stack>
        </>
      )}

      <ConfirmDialog
        open={pendingDisable !== null}
        title="停用这条记忆？"
        message="停用后立即停止注入，但保留在记忆里、可随时恢复。"
        confirmText="停用"
        onCancel={() => setPendingDisable(null)}
        onConfirm={() => {
          const entry = pendingDisable;
          setPendingDisable(null);
          if (entry) {
            void run(
              () => store!.disable(entry.entryKey as EntryKey, '用户在记忆页停用', new Date()),
              '已停用',
              '停用失败',
            );
          }
        }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这条记忆？"
        message="删除会移除该结论，并留下一条「这个域已被删除」的标记——之后蒸馏不会再把它写回来。"
        confirmText="删除"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const entry = pendingDelete;
          setPendingDelete(null);
          if (entry) {
            void run(
              () => store!.remove(entry.entryKey as EntryKey, '用户在记忆页删除', new Date()),
              '已删除',
              '删除失败',
            );
          }
        }}
      />
    </Box>
  );
}

/**
 * 一次 UI 裁决的幂等键。
 *
 * 要求「同一次点击重试幂等」与「两次不同点击不互相冒充」同时成立，所以用
 * **计数器 + 随机段**：计数器保证同一毫秒内的连续点击也不撞号，随机段避免
 * 多标签页/多窗口生成同一个 id。
 */
let decisionSeq = 0;
function newEventId(conflictId: string, candidateId: string): string {
  decisionSeq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `ui:${conflictId}:${candidateId}:${Date.now()}:${decisionSeq}:${rand}`;
}

/** 单条修订的行 */function EntryRow({
  entry,
  busy,
  onDisable,
  onEnable,
  onDelete,
}: {
  entry: CuratedEntry;
  busy: boolean;
  onDisable?: () => void;
  onEnable?: () => void;
  onDelete?: () => void;
}) {
  const statusChip =
    entry.status === 'active'
      ? null
      : entry.status === 'superseded'
        ? { label: '已被替代', color: 'default' as const }
        : { label: '已停用', color: 'warning' as const };

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.25 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5, flexWrap: 'wrap' }}>
        <Chip size="small" variant="outlined" label={entry.memoryKey} />
        <Chip size="small" variant="outlined" label={`r${entry.revision}`} />
        <Chip size="small" variant="outlined" label={`重要度 ${entry.importance}`} />
        {statusChip && <Chip size="small" color={statusChip.color} label={statusChip.label} />}
        <Box sx={{ flex: 1 }} />
        {onDisable && (
          <Tooltip title="停用（停止注入，可恢复）">
            <span>
              <Button size="small" disabled={busy} onClick={onDisable} startIcon={<BlockOutlinedIcon />}>
                停用
              </Button>
            </span>
          </Tooltip>
        )}
        {onEnable && (
          <Tooltip title="恢复注入">
            <span>
              <Button
                size="small"
                disabled={busy}
                onClick={onEnable}
                startIcon={<PlayCircleOutlineIcon />}
              >
                恢复
              </Button>
            </span>
          </Tooltip>
        )}
        {onDelete && (
          <Tooltip title="删除（留域级标记，蒸馏不会写回）">
            <span>
              <Button
                size="small"
                color="error"
                disabled={busy}
                onClick={onDelete}
                startIcon={<DeleteOutlineIcon />}
              >
                删除
              </Button>
            </span>
          </Tooltip>
        )}
      </Stack>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
        {entry.content === '' ? '（已被删除的域）' : entry.content}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        证据 {entry.evidenceCount} 条 · 首次 {new Date(entry.firstSeen).toLocaleDateString()} · 最近{' '}
        {new Date(entry.lastSeen).toLocaleDateString()}
        {entry.disabledReason ? ` · ${entry.disabledReason}` : ''}
      </Typography>
    </Box>
  );
}
