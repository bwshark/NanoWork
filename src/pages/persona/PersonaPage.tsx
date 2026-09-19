import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import { IdentityService } from '@/lib/identity';
import { PromptLibrary } from '@/lib/promptLibrary';
import { QUALITY_CLAUSE_MARKER, styleKeepsQualityClause } from '@/lib/promptCatalog';
import { toast } from '@/components/Toast';
import type {
  IdentityFileKind,
  IdentityFileState,
  PromptSlot,
  PromptSlotKind,
  PromptSlotState,
} from '@/types';

/**
 * 「人格」页（FR-4.3 身份文件 + FR 提示词外置，design §13 / §14.1 L4）。
 *
 * 两块内容共处一页，因为它们是同一条注入链上的相邻两层：
 *
 * - **身份文件**（`SOUL.md` / `IDENTITY.md` / `USER.md`）回答「我是谁、我怎么做事、
 *   用户是谁」，每轮会话在 `<identity_context>` 标签块内注入；
 * - **提示词模板**（模式 × 领域 × 风格）回答「这一轮该用什么姿态说话」，
 *   并以 `<tone_and_style>` 等标签块紧随其后。
 *
 * 两点刻意的设计：
 *
 * 1. **「恢复默认」= 删文件，不是写空文件**。身份文件的「恢复默认」删掉磁盘文件，
 *    回到「没写过」；提示词槽位的「恢复默认」同理回到内置正文。写一份空文件会让
 *    磁盘上出现一个「看起来被自定义过、实际什么都没改」的幽灵文件。
 * 2. **空文件与未写过是两种状态**。身份文件用 `exists` 单独表达前者（用户故意清空），
 *    UI 上必须能区分，否则「恢复默认」按钮的语义会自相矛盾。
 */
type PersonaTab = 'identity' | 'prompts';

/**
 * @param embedded 嵌入设置弹窗时传 true：去掉外层页面内边距、`maxWidth` 与大标题——
 *   弹窗标题栏已经写了分区名，正文再顶一个 h5 等于同一句话说两遍。引导横幅、
 *   Tab、编辑弹窗等业务内容在两种宿主下完全一致。
 */
export function PersonaPage({ embedded = false }: { embedded?: boolean }) {
  const [tab, setTab] = useState<PersonaTab>('identity');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [identityStates, setIdentityStates] = useState<IdentityFileState[]>([]);
  const [promptStates, setPromptStates] = useState<PromptSlotState[]>([]);

  /** 同步把两个服务的快照投影到本地 state（保存/删除后调用） */
  const syncLocal = useCallback(() => {
    setIdentityStates(IdentityService.statesSync());
    setPromptStates(PromptLibrary.statesSync());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.all([IdentityService.loadAll(), PromptLibrary.loadAll()]);
      if (!cancelled) {
        syncLocal();
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [syncLocal]);

  const runAction = useCallback(
    async (action: () => Promise<void>, okMsg: string, failPrefix: string) => {
      setBusy(true);
      try {
        await action();
        syncLocal();
        toast.success(okMsg);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(`${failPrefix}：${msg}`);
      } finally {
        setBusy(false);
      }
    },
    [syncLocal],
  );

  // -------------------------------------------------------------------------
  // 身份文件编辑
  // -------------------------------------------------------------------------
  const [identityEdit, setIdentityEdit] = useState<{
    kind: IdentityFileKind;
    draft: string;
  } | null>(null);

  const openIdentityEditor = async (kind: IdentityFileKind) => {
    // 直接读盘而非用快照：快照可能落后于外部编辑（用户用编辑器改了文件）
    const text = await IdentityService.read(kind);
    setIdentityEdit({ kind, draft: text });
  };

  const saveIdentity = () =>
    runAction(
      async () => {
        if (!identityEdit) return;
        await IdentityService.save(identityEdit.kind, identityEdit.draft);
        setIdentityEdit(null);
      },
      '身份文件已保存',
      '保存失败',
    );

  const resetIdentity = (kind: IdentityFileKind) =>
    runAction(
      () => IdentityService.remove(kind),
      '已恢复默认（文件已删除）',
      '恢复默认失败',
    );

  /** 一次性引导：删除 BOOTSTRAP.md，之后新会话不再进入引导态 */
  const finishOnboarding = () =>
    runAction(
      async () => {
        const had = await IdentityService.completeOnboarding();
        if (!had) toast.info('本来就没有待完成的引导');
      },
      '引导已完成，BOOTSTRAP.md 已删除',
      '结束引导失败',
    );

  const onboarding = IdentityService.isOnboarding();

  // -------------------------------------------------------------------------
  // 提示词槽位编辑
  // -------------------------------------------------------------------------
  const [slotEdit, setSlotEdit] = useState<{
    slot: PromptSlot;
    /** 磁盘上是否已有覆盖（决定「恢复默认」是否需要提示） */
    customized: boolean;
    draft: string;
  } | null>(null);

  const openSlotEditor = (state: PromptSlotState) => {
    setSlotEdit({
      slot: state.slot,
      customized: state.override !== null,
      // 预填最终生效正文（有覆盖用覆盖、没有用内置默认）：用户从一份可用的
      // 正文开始改，比面对空白框更实际
      draft: state.effective,
    });
  };

  const saveSlot = () =>
    runAction(
      async () => {
        if (!slotEdit) return;
        // 空白正文在 PromptLibrary 内等价于恢复默认（删文件），与这里提示一致
        await PromptLibrary.save(slotEdit.slot.kind, slotEdit.slot.key, slotEdit.draft);
        setSlotEdit(null);
      },
      '提示词已保存',
      '保存失败',
    );

  const resetSlot = (slot: PromptSlot) =>
    runAction(
      () => PromptLibrary.reset(slot.kind, slot.key),
      '已恢复内置默认',
      '恢复默认失败',
    );

  const identityByKind = useMemo(() => {
    const map = new Map<IdentityFileKind, IdentityFileState>();
    for (const s of identityStates) map.set(s.kind, s);
    return map;
  }, [identityStates]);

  const customizedCount = promptStates.filter((s) => s.override !== null).length;

  return (
    <Box sx={embedded ? undefined : { p: 3, maxWidth: 900, margin: '0 auto' }}>
      {!embedded && (
        <Typography variant="h5" fontWeight={700} gutterBottom>
          人格
        </Typography>
      )}
      <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 2 }}>
        身份文件与提示词模板都在这里外置维护：改完即生效，不需要重新编译前端，也不会被
        Agent 自身的系统提示词覆盖。
      </Typography>

      {/* 引导态横幅：BOOTSTRAP.md 存在即进入一次性引导 */}
      {onboarding && (
        <Alert
          severity="info"
          icon={<RocketLaunchIcon fontSize="inherit" />}
          sx={{ mb: 2 }}
          action={
            <Button
              color="inherit"
              size="small"
              disabled={busy}
              onClick={() => void finishOnboarding()}
            >
              完成引导
            </Button>
          }
        >
          当前处于一次性引导态：Agent 会先按 BOOTSTRAP.md 完成自我设定。设定产出落到
          SOUL / IDENTITY / USER 之后，点「完成引导」删除该文件——否则之后每个新会话都会重新进入引导。
        </Alert>
      )}

      <Tabs
        value={tab}
        onChange={(_e, v: PersonaTab) => setTab(v)}
        sx={{
          minHeight: 40,
          borderBottom: '1px solid',
          borderColor: 'divider',
          mb: 2,
          '& .MuiTab-root': {
            minHeight: 40,
            textTransform: 'none',
            fontSize: 13.5,
            fontWeight: 600,
            px: 1,
            mr: 2,
          },
        }}
      >
        <Tab value="identity" label="身份文件" />
        <Tab value="prompts" label={`提示词模板${customizedCount ? `（${customizedCount} 项自定义）` : ''}`} />
      </Tabs>

      {/* ---------------------------------------------------------------- */}
      {/* 身份文件                                                          */}
      {/* ---------------------------------------------------------------- */}
      {tab === 'identity' && (
        <Stack spacing={1.5}>
          {identityStates.map((state) => (
            <Paper
              key={state.kind}
              variant="outlined"
              sx={{ p: 2, bgcolor: 'background.paper' }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
                  {state.label}
                </Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  label={state.filename}
                  sx={{
                    fontSize: 11,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  }}
                />
                <Chip
                  size="small"
                  label={
                    !state.exists
                      ? '未写过'
                      : state.content.trim() === ''
                        ? '空文件'
                        : `${state.content.length} 字符`
                  }
                  color={
                    !state.exists ? 'default' : state.content.trim() === '' ? 'warning' : 'success'
                  }
                  variant={state.exists && state.content.trim() !== '' ? 'filled' : 'outlined'}
                />
                <Box sx={{ flex: 1 }} />
                <Tooltip title="编辑">
                  <span>
                    <IconButton
                      size="small"
                      aria-label={`编辑 ${state.filename}`}
                      disabled={loading || busy}
                      onClick={() => void openIdentityEditor(state.kind)}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip
                  title={
                    state.exists
                      ? '恢复默认（删除该文件）'
                      : '本来就没有同名文件，无需恢复'
                  }
                >
                  <span>
                    <IconButton
                      size="small"
                      aria-label={`恢复默认 ${state.filename}`}
                      disabled={loading || busy || !state.exists}
                      onClick={() => void resetIdentity(state.kind)}
                    >
                      <RestartAltIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
              <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
                {state.description}
              </Typography>
              {/* 空文件与未写过是两种状态：前者是用户故意清空，说清楚免得疑惑 */}
              {state.exists && state.content.trim() === '' && (
                <Typography sx={{ fontSize: 12, color: 'warning.main', mt: 0.5 }}>
                  文件存在但内容为空——注入时会被跳过，不再影响会话。
                </Typography>
              )}
            </Paper>
          ))}

          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
            这三个文件每轮以 <code>&lt;identity_context&gt;</code> 标签块注入；同目录下的
            AGENTS.md 属于项目约定，不在此块内。
          </Typography>
        </Stack>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 提示词模板                                                        */}
      {/* ---------------------------------------------------------------- */}
      {tab === 'prompts' && (
        <Stack spacing={2}>
          {(['mode', 'domain', 'style'] as PromptSlotKind[]).map((kind) => (
            <Box key={kind}>
              <Typography sx={{ fontSize: 13, fontWeight: 700, mb: 0.5 }}>
                {KIND_LABEL[kind]}
              </Typography>
              <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 1 }}>
                {KIND_DESC[kind]}
              </Typography>
              <Stack spacing={1}>
                {promptStates
                  .filter((s) => s.slot.kind === kind)
                  .map((state) => (
                    <SlotRow
                      key={`${state.slot.kind}.${state.slot.key}`}
                      state={state}
                      disabled={loading || busy}
                      onEdit={() => openSlotEditor(state)}
                      onReset={() => void resetSlot(state.slot)}
                    />
                  ))}
              </Stack>
              {kind !== 'style' && <Divider sx={{ mt: 2 }} />}
            </Box>
          ))}
        </Stack>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 身份文件编辑弹窗                                                  */}
      {/* ---------------------------------------------------------------- */}
      <Dialog
        open={!!identityEdit}
        onClose={() => setIdentityEdit(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle sx={{ fontSize: 16, fontWeight: 700 }}>
          编辑{' '}
          {identityEdit
            ? identityByKind.get(identityEdit.kind)?.filename ?? identityEdit.kind
            : ''}
        </DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 1 }}>
            {identityEdit
              ? identityByKind.get(identityEdit.kind)?.description ?? ''
              : ''}
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={12}
            maxRows={24}
            value={identityEdit?.draft ?? ''}
            onChange={(e) =>
              setIdentityEdit((prev) =>
                prev ? { ...prev, draft: e.target.value } : prev,
              )
            }
            InputProps={{
              sx: {
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 13,
              },
            }}
          />
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1 }}>
            保存空内容 = 保留一个空文件（该文件被跳过，但不等于删除）；想回到出厂状态请用
            「恢复默认」删除文件。
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          {identityEdit && identityByKind.get(identityEdit.kind)?.exists && (
            <Button
              color="error"
              startIcon={<DeleteOutlineIcon />}
              disabled={busy}
              onClick={() => {
                const kind = identityEdit.kind;
                setIdentityEdit(null);
                void resetIdentity(kind);
              }}
              sx={{ mr: 'auto', textTransform: 'none', fontSize: 13 }}
            >
              删除文件
            </Button>
          )}
          <Button
            onClick={() => setIdentityEdit(null)}
            sx={{ textTransform: 'none', fontSize: 13 }}
          >
            取消
          </Button>
          <Button
            variant="contained"
            disabled={busy}
            onClick={() => void saveIdentity()}
            sx={{ textTransform: 'none', fontSize: 13 }}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* ---------------------------------------------------------------- */}
      {/* 提示词槽位编辑弹窗                                                */}
      {/* ---------------------------------------------------------------- */}
      <Dialog
        open={!!slotEdit}
        onClose={() => setSlotEdit(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle sx={{ fontSize: 16, fontWeight: 700 }}>
          编辑提示词 · {slotEdit?.slot.label ?? ''}
        </DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 0.5 }}>
            {slotEdit?.slot.description ?? ''}
          </Typography>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 1 }}>
            {slotEdit?.customized
              ? `当前为自定义版本。留空并保存即恢复内置默认（${renderPath(slotEdit?.slot)}）。`
              : `当前使用内置默认，编辑后保存即写入 ${renderPath(slotEdit?.slot)}。`}
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={10}
            maxRows={22}
            value={slotEdit?.draft ?? ''}
            onChange={(e) =>
              setSlotEdit((prev) =>
                prev ? { ...prev, draft: e.target.value } : prev,
              )
            }
            InputProps={{
              sx: {
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 13,
              },
            }}
          />
          {/* 风格护栏提示：删掉护栏不阻止保存（风格是用户的自由），但必须让人知道
              这一行不是装饰——它是「风格不污染事实」的唯一拦截点。 */}
          {slotEdit?.slot.kind === 'style' &&
            slotEdit.draft.trim() !== '' &&
            !styleKeepsQualityClause(slotEdit.draft) && (
              <Alert severity="warning" sx={{ mt: 1.5 }}>
                正文缺少内容质量护栏（应包含「{QUALITY_CLAUSE_MARKER}」）。
                风格可以改表达方式，但不该让事实与准确性跟着变——建议保留这一条。
              </Alert>
            )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          {slotEdit?.customized && (
            <Button
              color="error"
              startIcon={<RestartAltIcon />}
              disabled={busy}
              onClick={() => {
                const slot = slotEdit.slot;
                setSlotEdit(null);
                void resetSlot(slot);
              }}
              sx={{ mr: 'auto', textTransform: 'none', fontSize: 13 }}
            >
              恢复内置默认
            </Button>
          )}
          <Button
            onClick={() => setSlotEdit(null)}
            sx={{ textTransform: 'none', fontSize: 13 }}
          >
            取消
          </Button>
          <Button
            variant="contained"
            disabled={busy}
            onClick={() => void saveSlot()}
            sx={{ textTransform: 'none', fontSize: 13 }}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

/** 槽位三个维度的分组标题与说明 */
const KIND_LABEL: Record<PromptSlotKind, string> = {
  mode: '执行模式',
  domain: '工作领域',
  style: '语气风格',
};

const KIND_DESC: Record<PromptSlotKind, string> = {
  mode: '由会话当前模式自动选用（问答 / 规划 / 执行），通常无需逐条编辑。',
  domain: '由设置页或 Agent 级覆盖选中其中一项，作为「这一轮在干什么活」的说明。',
  style: '由设置页或 Agent 级覆盖选中其中一项；正文必须保留内容质量护栏。',
};

/** 槽位落盘路径（展示用，与 electron/storageRoutes.ts 的路由规则一致） */
function renderPath(slot?: PromptSlot): string {
  if (!slot) return '';
  return `~/.nanowork/prompts/${slot.kind}/${slot.key}.md`;
}

/** 单个提示词槽位行 */
function SlotRow({
  state,
  disabled,
  onEdit,
  onReset,
}: {
  state: PromptSlotState;
  disabled: boolean;
  onEdit: () => void;
  onReset: () => void;
}) {
  const customized = state.override !== null;
  /** 自定义正文丢了护栏时在列表上也要有痕迹，不能只在编辑弹窗里提示 */
  const missingClause =
    state.slot.kind === 'style' &&
    customized &&
    !styleKeepsQualityClause(state.override ?? '');

  return (
    <Paper
      variant="outlined"
      sx={{ p: 1.5, bgcolor: 'background.paper' }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: 13.5, fontWeight: 600 }}>
          {state.slot.label}
        </Typography>
        <Chip
          size="small"
          label={customized ? '已自定义' : '内置默认'}
          color={customized ? 'primary' : 'default'}
          variant={customized ? 'filled' : 'outlined'}
        />
        {missingClause && (
          <Chip size="small" color="warning" label="缺少质量护栏" />
        )}
        <Box sx={{ flex: 1 }} />
        <Tooltip title="编辑">
          <span>
            <IconButton
              size="small"
              aria-label={`编辑提示词 ${state.slot.label}`}
              disabled={disabled}
              onClick={onEdit}
            >
              <EditIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={customized ? '恢复内置默认' : '已是内置默认'}>
          <span>
            <IconButton
              size="small"
              aria-label={`恢复默认提示词 ${state.slot.label}`}
              disabled={disabled || !customized}
              onClick={onReset}
            >
              <RestartAltIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
        {state.slot.description}
      </Typography>
      <Typography
        sx={{
          fontSize: 11,
          color: 'text.secondary',
          mt: 0.5,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        {renderPath(state.slot)} · {state.effective.length} 字符
      </Typography>
    </Paper>
  );
}
