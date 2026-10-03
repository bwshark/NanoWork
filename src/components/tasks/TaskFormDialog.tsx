/**
 * 受控的任务表单弹窗（TasksPage 与聊天入口共用的唯一表单实现）。
 *
 * 设计要点：
 * - **受控 + 无副作用**：只把校验通过的草稿交给 `onSubmit`，不碰 store。写库由调用方
 *   （TasksPage 走 add/update、聊天入口走 addTask + toast）决定，因此表单本身可复用。
 * - **UI 状态与调度结构分离**：`TaskSchedule` 是给引擎的（cron/interval/once），
 *   但「周期」在 UI 上要拆成 频率 + 星期/日期 + 时间 + 生效区间，两者不是一一对应，
 *   所以内部维护 `UiState` 并双向转换（`scheduleToUi` / `uiToSchedule`）。
 *   cron 与 UI 无法互推时（如带步长的表达式）退化成「高级」里的 `cronOverride` 原文覆盖。
 * - **校验走 toast 而不是禁用提交按钮**：禁用按钮说不出「为什么不能提交」，
 *   而本表单有 4 类互相独立的错误（名称/间隔/日期/cron/生效区间），必须给出具体原因。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import PsychologyIcon from '@mui/icons-material/Psychology';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import GppMaybeIcon from '@mui/icons-material/GppMaybe';
import { toast } from '@/components/Toast';
import { DeliveryField } from '@/components/tasks/DeliveryField';
import { WorkdirField } from '@/components/tasks/WorkdirField';
import { isAbsoluteWorkspacePath } from '@/lib/workspaceLabel';
import { validateCron } from '@/lib/cron';
import { describeRrule, lowerRrule } from '@/lib/rrule';
import { useAgentsStore } from '@/stores/agentsStore';
import { useSkillsStore } from '@/stores/skillsStore';
import { describeModelId, useModelsStore } from '@/stores/modelsStore';
import type { TaskConfig, TaskDelivery, TaskSchedule, TaskStatus } from '@/types';
import type { TaskDraft } from '@/lib/taskDraft';

/** 调度类型：周期（daily/weekly/monthly）/ 按间隔 / 单次 */
type ScheduleMode = 'periodic' | 'interval' | 'once' | 'rrule';

/** 周期频率 */
type PeriodFreq = 'daily' | 'weekly' | 'monthly';

/** 表单里的「执行频率」UI 状态（与 TaskSchedule 多对多转换） */
interface UiState {
  mode: ScheduleMode;
  freq: PeriodFreq;
  /** 1-7，7 表示周日（与 cron 的 0=周日 做转换） */
  weekday: number;
  /** 1-31，仅 monthly 使用 */
  monthDay: number;
  /** "HH:mm" */
  time: string;
  /** 间隔分钟数，仅 interval 使用 */
  minutes: number;
  /** "yyyy-MM-dd"，仅 once 使用 */
  date: string;
  validFrom: string;
  validTo: string;
  /** 高级：直接写 cron，覆盖上方结构化设置 */
  cronOverride: string;
  /**
   * 循环规则原文（FR-5.4）。它是**本层的表达形态**，提交时原样存进
   * `TaskConfig.schedule`；降级成引擎能跑的 cron / interval 是同步时做的（`src/lib/rrule.ts`）。
   * 之所以不在这里就降级：用户下次打开表单要看到自己写的那条规则。
   */
  rrule: string;
  tz: string;
}

/** 任务级执行配置（模型 / 技能 / 权限）的编辑态 */
interface RunState {
  /** '' 表示跟随全局默认模型 */
  model: string;
  skillIds: string[];
  fullAccess: boolean;
}

interface FormState {
  name: string;
  prompt: string;
  agentId: string;
  status: TaskStatus;
  ui: UiState;
  run: RunState;
  /** 结果推送（FR-5.6）；`undefined` = 不推送，与「有目标」是两个不同的状态 */
  delivery: TaskDelivery | undefined;
  /**
   * 任务级工作目录（FR-5.8）。空串 = 不绑定（跟随默认工作空间）。
   *
   * 与 `delivery` 一样：状态里**保留这个键**，因为它也是一个可以被「清空」的设置，
   * 而清空动作必须能真的传到 store（`updateTask` 是浅合并，省略键 = 旧值留下）。
   */
  workdir: string;
}

/** UI 默认值：周期 + 每天 09:00（最贴近「定时任务」的直觉） */
const EMPTY_UI: UiState = {
  mode: 'periodic',
  freq: 'daily',
  weekday: 1,
  monthDay: 1,
  time: '09:00',
  minutes: 60,
  date: '',
  validFrom: '',
  validTo: '',
  cronOverride: '',
  rrule: '',
  tz: '',
};

const WEEKDAYS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
];

/** 把数字夹到 [min, max]；NaN 回退 min（输入框清空时会得到 NaN） */
function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Date → "yyyy-MM-dd"（本地时区，不经过 toISOString 以免时区偏移） */
function toDateInput(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Date → "HH:mm"（本地时区） */
function toTimeInput(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 已有调度 → UI 状态（表单预填）。
 *
 * cron 的可逆性有限，按「能否无损还原成结构化 UI」分级回退：
 * 1. 纯 `分 时 * * *` → daily；`分 时 * * N` → weekly；
 * 2. 日/月字段非 `*`（如月初执行、带生效区间） → 无法结构化表达，落到 `cronOverride`；
 * 3. 带步长等非常规写法 → 同样落到 `cronOverride`（原文回显，用户仍能看到并修改）。
 */
function scheduleToUi(schedule?: TaskSchedule): UiState {
  const next: UiState = { ...EMPTY_UI };
  if (!schedule) return next;

  if (schedule.kind === 'interval') {
    return { ...next, mode: 'interval', minutes: schedule.minutes };
  }

  if (schedule.kind === 'once') {
    const d = new Date(schedule.at);
    if (!Number.isNaN(d.getTime())) {
      next.mode = 'once';
      next.date = toDateInput(d);
      next.time = toTimeInput(d);
    }
    return next;
  }

  if (schedule.kind === 'rrule') {
    // 循环规则**原样回显**：结构化 UI 表达不了 RRULE 的自由组合，
    // 强行反推只会让用户看到一条自己没写过的规则
    return { ...next, mode: 'rrule', rrule: schedule.rrule, tz: schedule.tz ?? '' };
  }

  next.tz = schedule.tz ?? '';
  const matched = schedule.expr.match(/^(\d+) (\d+) (\*|\d+) (\*|\d+) (\*|\d+)$/);
  if (!matched) return { ...next, mode: 'periodic', cronOverride: schedule.expr };

  const [, minute, hour, dom, month, dow] = matched;
  next.time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  // 日/月字段被限定：属于「每月某天」或「生效区间」，结构化 UI 表达不了 → 保留原文
  if (dom !== '*' || month !== '*') {
    return { ...next, mode: 'periodic', cronOverride: schedule.expr };
  }
  if (dow === '*') {
    next.freq = 'daily';
  } else {
    next.freq = 'weekly';
    next.weekday = Number(dow) === 0 ? 7 : Number(dow);
  }
  return next;
}

/**
 * UI 状态 → 调度结构（提交）。
 *
 * ⚠️ **不把生效区间编进 cron**。曾经把 `validFrom` 的「日 / 月」硬编码成 cron 的第 3、4 段
 * 来「近似表达区间」，那是错的：`每天 09:00` + 开始日期 `2026-10-15` 会变成
 * `0 9 15 10 *`，也就是**每年** 10 月 15 日才跑一次——把用户最常见的诉求静默改成一年一次。
 * cron 根本没有「从哪天起生效」这种字段，能表达它的只有 `validFrom` / `validUntil`
 * 本身（由 `computeNextRunMs` 在算下次触发时刻时体现，见 `TaskConfig` 的字段注释）。
 */
function uiToSchedule(ui: UiState): TaskSchedule {
  const tz = ui.tz.trim() ? ui.tz.trim() : undefined;

  if (ui.mode === 'interval') {
    return { kind: 'interval', minutes: clamp(ui.minutes, 1, 59999) };
  }

  if (ui.mode === 'once') {
    return {
      kind: 'once',
      at: new Date(`${ui.date}T${ui.time || '00:00'}`).toISOString(),
    };
  }

  if (ui.mode === 'rrule') {
    // 原样存**规则本身**（不是降级结果）：引擎形态是下发时才决定的，
    // 而用户下次编辑要看到自己写的规则
    return { kind: 'rrule', rrule: ui.rrule.trim(), tz };
  }

  if (ui.cronOverride.trim()) {
    return { kind: 'cron', expr: ui.cronOverride.trim(), tz };
  }

  const [hour, minute] = (ui.time || '09:00').split(':').map((n) => Number(n));
  const dom = ui.freq === 'monthly' ? String(clamp(ui.monthDay, 1, 31)) : '*';
  const dow = ui.freq === 'weekly' ? String(ui.weekday === 7 ? 0 : ui.weekday) : '*';

  return { kind: 'cron', expr: `${minute} ${hour} ${dom} * ${dow}`, tz };
}

/**
 * 循环规则（RRULE）输入 + **降级结果实时回显**（FR-5.4）。
 *
 * 这个回显不是装饰：引擎只认 cron / every / at，RRULE 是前端降级后才下发的。
 * 用户必须能看到「我写的规则会被执行成什么」，以及**写不了的规则为什么写不了**
 * ——设计 §15.3 明确要求「这个降级必须显式」。
 *
 * 与 `validateForm` 共用同一个 `lowerRrule`，因此不会出现「提示说可以、提交却被拒」
 * 这种自相矛盾的状态（两处各判一次的写法必然会漂移）。
 */
function RruleField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const text = value.trim();
  const lowered = text === '' ? null : lowerRrule(text);

  let hint: React.ReactNode;
  if (lowered === null) {
    hint = (
      <Typography variant="caption" color="text.secondary">
        示例：FREQ=MONTHLY;BYMONTHDAY=1,15,28;BYHOUR=9 —— 每月 1、15、28 日 09:00
      </Typography>
    );
  } else if (!lowered.ok) {
    hint = (
      <Alert severity="warning" sx={{ py: 0.25 }}>
        <Typography variant="caption">{lowered.reason}</Typography>
      </Alert>
    );
  } else {
    const as = lowered.schedule;
    const what =
      as.kind === 'cron'
        ? `cron「${as.expr}」`
        : as.kind === 'interval'
          ? `固定间隔「每 ${as.minutes} 分钟」`
          : '单次';
    hint = (
      <Alert severity="info" icon={false} sx={{ py: 0.25 }}>
        <Typography variant="caption" color="text.secondary">
          {describeRrule(text)} · 引擎将按 {what} 执行
          {lowered.until ? ` · 至 ${lowered.until.slice(0, 10)}` : ''}
          {lowered.note ? ` · ${lowered.note}` : ''}
        </Typography>
      </Alert>
    );
  }

  return (
    <Box sx={{ mb: 1.5 }}>
      <TextField
        size="small"
        fullWidth
        multiline
        minRows={2}
        placeholder="FREQ=MONTHLY;BYMONTHDAY=1,15,28;BYHOUR=9;BYMINUTE=0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        InputProps={{ sx: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 } }}
      />
      <Box sx={{ mt: 0.5 }}>{hint}</Box>
    </Box>
  );
}

/** 校验表单；返回空串表示通过（文案即 toast 内容） */
function validateForm(form: FormState): string {
  if (!form.name.trim()) return '请填写任务名称';

  const { ui } = form;
  if (ui.mode === 'interval' && !(ui.minutes >= 1)) return '间隔分钟数需 ≥ 1';
  if (ui.mode === 'once' && !ui.date) return '请选择单次执行日期';

  if (ui.mode === 'periodic' && ui.cronOverride.trim()) {
    const check = validateCron(ui.cronOverride.trim());
    if (!check.valid) return check.error ?? 'Cron 表达式不合法';
  }

  if (ui.mode === 'rrule') {
    if (!ui.rrule.trim()) return '请填写循环规则（RRULE，如 FREQ=MONTHLY;BYMONTHDAY=1,15）';
    // ⭐ FR-5.4 的「降级必须显式」：引擎只认 cron / every / at，降不了就必须**当场说清原因**，
    // 而不是存下来、等到执行时静默不跑
    const lowered = lowerRrule(ui.rrule.trim());
    if (!lowered.ok) return `该循环规则引擎无法执行：${lowered.reason}`;
  }

  if (ui.validFrom && ui.validTo && ui.validFrom > ui.validTo) {
    return '生效开始日期不能晚于结束日期';
  }

  // 工作目录必须是绝对路径：引擎对相对路径抛 `WorkspaceScopeError`，而那个错会被
  // **静默吞掉并回落默认工作空间** —— 用户只会看到「配了没生效，也查不出原因」。
  // 录入侧拦住是唯一便宜的时机（客户端查不了存在性，但查得了形状）。
  if (form.workdir.trim() && !isAbsoluteWorkspacePath(form.workdir)) {
    return '工作目录需填绝对路径（如 C:\\proj 或 /home/me/proj）';
  }
  return '';
}

/** ISO 时间戳 → `type="date"` 的 'YYYY-MM-DD'（按**本地**日，与 `toDateInput` 同口径） */
function isoToDayInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : toDateInput(d);
}

/** 'YYYY-MM-DD' → ISO 下界（本地零点）；空串 → undefined（= 不设下界） */
function dayStartIso(day: string): string | undefined {
  return day ? new Date(`${day}T00:00:00`).toISOString() : undefined;
}

/** 'YYYY-MM-DD' → ISO 上界（本地当日 23:59:59.999）；`validUntil` 是**含**的 */
function dayEndIso(day: string): string | undefined {
  return day ? new Date(`${day}T23:59:59.999`).toISOString() : undefined;
}

/** 预填值 → 表单状态；缺省字段回退 UI 默认 */
function toForm(initial?: Partial<TaskConfig>): FormState {
  return {
    name: initial?.name ?? '',
    prompt: initial?.prompt ?? '',
    agentId: initial?.agentId ?? '',
    status: initial?.status ?? 'enabled',
    ui: {
      ...scheduleToUi(initial?.schedule),
      /*
       * 生效区间**不在** schedule 里（`scheduleToUi` 只拿得到调度结构），必须单独回填。
       * 漏了这一步的后果是：编辑一条设过区间的任务时两个日期框是空的，一保存就把区间
       * 清掉了 —— 而用户什么都没改。
       */
      validFrom: isoToDayInput(initial?.validFrom),
      validTo: isoToDayInput(initial?.validUntil),
    },
    run: {
      model: initial?.runOptions?.model ?? '',
      skillIds: initial?.runOptions?.skillIds ?? [],
      fullAccess: initial?.runOptions?.fullAccess ?? false,
    },
    // 空目标收敛成 undefined：手改过 / 老数据可能留一个 `{ targets: [], on }`，
    // 它与「不推送」是同一个意思，不该在表单里表现成「配了推送却没有目标」
    delivery:
      initial?.delivery && initial.delivery.targets.length > 0 ? initial.delivery : undefined,
    workdir: initial?.workdir ?? '',
  };
}

export interface TaskFormDialogProps {
  open: boolean;
  /** 预填值；schedule 默认「周期 · 每天 09:00」，agentId 默认待上层给定 */
  initial?: Partial<TaskConfig>;
  /**
   * 执行频率的**来源说明**（如「每周一 09:00」）。
   *
   * 只为聊天入口准备：那里的调度是从用户消息里推断出来的（FR-5.5 补），不说一句的话
   * 「打开表单就是填好的」会看起来像上次编辑的残留。推断不出来时传 `null`。
   */
  scheduleHint?: string | null;
  /** 标题，默认 '新建任务'；聊天入口传 '创建定时任务（来自对话）' */
  title?: string;
  /** 提交按钮文案，默认 '保存'；聊天入口传 '创建任务' */
  submitLabel?: string;
  /** 校验通过后回调，data 已剔除 id/createdAt */
  onSubmit: (data: TaskDraft) => void;
  onClose: () => void;
}

export function TaskFormDialog({
  open,
  initial,
  title = '新建任务',
  submitLabel = '保存',
  scheduleHint = null,
  onSubmit,
  onClose,
}: TaskFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => toForm(initial));
  /** 顶部「勿关闭客户端」提示条的可见性（本次打开内可关闭） */
  const [noticeVisible, setNoticeVisible] = useState(true);
  /** 「高级（Cron / 时区）」折叠状态 */
  const [advancedOpen, setAdvancedOpen] = useState(false);

  /*
   * 只在「打开」这一刻把 initial 快照进表单。
   *
   * 依赖里刻意不含 initial：父组件（TasksPage / CreateTaskDialog）每次渲染都会新建一个
   * initial 对象，若列入依赖，任务列表轮询 / hover 等任一次父级重渲染都会重置用户正在
   * 填写的表单。需要「换一条任务」时由父级用 key 重挂载即可（TasksPage 已传
   * key={editing?.id ?? 'new'}）。
   */
  useEffect(() => {
    if (!open) return;
    const next = toForm(initial);
    setForm(next);
    setNoticeVisible(true);
    /*
     * 调度**无法结构化回显**时默认展开「高级」。
     *
     * 这不是少见情况：推断出的「每周一、三、五」或「每个工作日」在结构化控件里表达不了，
     * `scheduleToUi` 会把原文落到折叠区里的 `cronOverride`。默认收起的话，用户看到的是
     * 结构化控件的**默认值**（每天 09:00），而他真正生效的规则藏在折叠区里 —— 等于
     * 「配了看不见」。编辑既有任务时同理（带步长的 cron 就属于这一类）。
     */
    setAdvancedOpen(Boolean(next.ui.cronOverride));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const error = useMemo(() => validateForm(form), [form]);
  const ui = form.ui;

  const patchUi = (patch: Partial<UiState>) =>
    setForm((v) => ({ ...v, ui: { ...v.ui, ...patch } }));

  const submit = () => {
    if (error) {
      toast.error(error);
      return;
    }
    onSubmit({
      name: form.name.trim(),
      prompt: form.prompt,
      agentId: form.agentId,
      status: form.status,
      schedule: uiToSchedule(form.ui),
      /*
       * 显式带上 `delivery`（值可能是 `undefined`）。
       *
       * ⚠️ 不能写成 `...(form.delivery ? { delivery } : {})`：`updateTask` 是**浅合并**
       * （`{...t, ...patch}`），省略这个键会让「把最后一个推送目标删掉」永远删不掉
       * ——旧配置被原样留下，而界面上已经看不到了。显式给 `undefined` 才能真正清掉。
       */
      delivery: form.delivery,
      /*
       * 生效区间同理**显式带上**（值可能是 `undefined`）：清空那两个日期框必须能真的
       * 清掉旧区间，而 `updateTask` 的浅合并会把省略的键原样留下。
       */
      validFrom: dayStartIso(form.ui.validFrom),
      validUntil: dayEndIso(form.ui.validTo),
      /*
       * 工作目录同理**显式带上**：空串是「不绑定」，必须真的清掉旧值。
       * 收敛成 `undefined` 而不是空串——「未指定」在类型上就该是缺席。
       */
      workdir: form.workdir.trim() ? form.workdir.trim() : undefined,
      runOptions: {
        ...(form.run.model ? { model: form.run.model } : {}),
        ...(form.run.skillIds.length > 0 ? { skillIds: form.run.skillIds } : {}),
        ...(form.run.fullAccess ? { fullAccess: true } : {}),
      },
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>{title}</DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        <Collapse in={noticeVisible}>
          <Alert
            severity="info"
            sx={{
              mb: 2,
              borderRadius: 2,
              alignItems: 'center',
              py: 0.5,
              '& .MuiAlert-message': {
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                paddingTop: 0,
                paddingBottom: 0,
              },
              '& .MuiAlert-icon': { paddingTop: 0, paddingBottom: 0 },
              '& .MuiAlert-action': { pl: 1, pr: 0 },
            }}
            action={
              <IconButton size="small" onClick={() => setNoticeVisible(false)}>
                <CloseIcon fontSize="small" />
              </IconButton>
            }
          >
            <span title="自动化任务执行时，请勿关闭电脑或退出客户端，否则任务将无法正常执行">
              自动化任务执行时，请勿关闭电脑或退出客户端，否则任务将无法正常执行
            </span>
          </Alert>
        </Collapse>

        {/* 执行频率的**来源说明**（FR-5.5 补）：只有聊天入口认出了正文里的时间才会传 */}
        {scheduleHint && (
          <Alert severity="success" sx={{ mb: 2, borderRadius: 2, py: 0.25 }}>
            已从消息里识别执行频率：{scheduleHint}（可修改）
          </Alert>
        )}

        <TextField
          fullWidth
          size="small"
          margin="dense"
          label="名称"
          value={form.name}
          onChange={(e) => setForm((v) => ({ ...v, name: e.target.value }))}
        />

        <FieldLabel label="提示词" />
        <Box
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            mb: 1,
            overflow: 'hidden',
          }}
        >
          {/* 提示词与执行配置同框：它们共同决定「这次任务跑什么」，分开会让用户漏配 */}
          <TextField
            fullWidth
            size="small"
            variant="standard"
            multiline
            minRows={4}
            placeholder="触发时发送给 Agent 的指令"
            value={form.prompt}
            onChange={(e) => setForm((v) => ({ ...v, prompt: e.target.value }))}
            sx={{
              px: 1.5,
              pt: 1,
              '& .MuiInputBase-root': {
                bgcolor: 'transparent',
                '&:before, &:after': { borderBottom: 'none' },
              },
            }}
          />
          <RunOptionsBar
            model={form.run.model}
            skillIds={form.run.skillIds}
            agentId={form.agentId}
            fullAccess={form.run.fullAccess}
            onModel={(model) => setForm((v) => ({ ...v, run: { ...v.run, model } }))}
            onSkills={(skillIds) => setForm((v) => ({ ...v, run: { ...v.run, skillIds } }))}
            onAgent={(agentId) => setForm((v) => ({ ...v, agentId }))}
            onFullAccess={(fullAccess) =>
              setForm((v) => ({ ...v, run: { ...v.run, fullAccess } }))
            }
          />
        </Box>

        <FieldLabel
          label="执行频率"
          hint="建议避开上午高峰时段，高峰期容易排队等待；选择非高峰期执行更稳定"
        />
        <ToggleButtonGroup
          exclusive
          size="small"
          value={ui.mode}
          onChange={(_e, value) => {
            if (value) patchUi({ mode: value as ScheduleMode });
          }}
          sx={{ mb: 1.5 }}
        >
          <ToggleButton value="periodic">周期</ToggleButton>
          <ToggleButton value="interval">按间隔</ToggleButton>
          <ToggleButton value="once">单次</ToggleButton>
          <ToggleButton value="rrule">循环规则</ToggleButton>
        </ToggleButtonGroup>

        {ui.mode === 'rrule' && <RruleField value={ui.rrule} onChange={(rrule) => patchUi({ rrule })} />}

        {ui.mode === 'periodic' && (
          <Box sx={{ display: 'flex', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
            <TextField
              select
              size="small"
              value={ui.freq}
              onChange={(e) => patchUi({ freq: e.target.value as PeriodFreq })}
              sx={{ minWidth: 96 }}
            >
              <MenuItem value="daily">每天</MenuItem>
              <MenuItem value="weekly">每周</MenuItem>
              <MenuItem value="monthly">每月</MenuItem>
            </TextField>

            {ui.freq === 'weekly' && (
              <TextField
                select
                size="small"
                value={ui.weekday}
                onChange={(e) => patchUi({ weekday: Number(e.target.value) })}
                sx={{ minWidth: 96 }}
              >
                {WEEKDAYS.map((day) => (
                  <MenuItem key={day.value} value={day.value}>
                    {day.label}
                  </MenuItem>
                ))}
              </TextField>
            )}

            {ui.freq === 'monthly' && (
              <TextField
                size="small"
                type="number"
                value={ui.monthDay}
                onChange={(e) => patchUi({ monthDay: Number(e.target.value) })}
                sx={{ minWidth: 96 }}
                inputProps={{ min: 1, max: 31 }}
              />
            )}

            <TextField
              size="small"
              type="time"
              value={ui.time}
              onChange={(e) => patchUi({ time: e.target.value })}
              InputLabelProps={{ shrink: true }}
            />
          </Box>
        )}

        {ui.mode === 'interval' && (
          <TextField
            size="small"
            type="number"
            label="间隔分钟数"
            value={ui.minutes}
            onChange={(e) => patchUi({ minutes: Number(e.target.value) })}
            sx={{ mb: 1.5 }}
            inputProps={{ min: 1 }}
          />
        )}

        {ui.mode === 'once' && (
          <Box sx={{ display: 'flex', gap: 1, mb: 1.5 }}>
            <TextField
              size="small"
              type="date"
              label="执行日期"
              value={ui.date}
              onChange={(e) => patchUi({ date: e.target.value })}
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              size="small"
              type="time"
              label="执行时间"
              value={ui.time}
              onChange={(e) => patchUi({ time: e.target.value })}
              InputLabelProps={{ shrink: true }}
            />
          </Box>
        )}

        {ui.mode === 'periodic' && (
          <>
            <FieldLabel label="生效日期区间" hint="可选，留空表示始终生效" />
            <Box sx={{ display: 'flex', gap: 1, mb: 1.5 }}>
              <TextField
                size="small"
                type="date"
                label="开始"
                value={ui.validFrom}
                onChange={(e) => patchUi({ validFrom: e.target.value })}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                size="small"
                type="date"
                label="结束"
                value={ui.validTo}
                onChange={(e) => patchUi({ validTo: e.target.value })}
                InputLabelProps={{ shrink: true }}
              />
            </Box>
          </>
        )}

        <WorkdirField
          label={<FieldLabel label="工作目录" hint="可选；留空跟随默认工作空间" />}
          value={form.workdir}
          onChange={(workdir) => setForm((v) => ({ ...v, workdir }))}
        />

        <DeliveryField
          label={
            <FieldLabel
              label="结果推送"
              hint="可选；结果由引擎直接发到渠道，发送失败会按退避自动重试"
            />
          }
          value={form.delivery}
          onChange={(delivery) => setForm((v) => ({ ...v, delivery }))}
        />

        <Button size="small" onClick={() => setAdvancedOpen((v) => !v)} sx={{ mb: 1, mt: 1 }}>
          {advancedOpen ? '收起高级' : '高级（Cron / 时区）'}
        </Button>
        <Collapse in={advancedOpen}>
          <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
            <TextField
              size="small"
              fullWidth
              label="Cron 表达式（覆盖上方设置）"
              placeholder="0 9 * * *"
              value={ui.cronOverride}
              onChange={(e) => patchUi({ cronOverride: e.target.value })}
              helperText="5 段：分 时 日 月 周"
            />
            <TextField
              size="small"
              label="时区"
              placeholder="Asia/Shanghai"
              value={ui.tz}
              onChange={(e) => patchUi({ tz: e.target.value })}
              sx={{ minWidth: 160 }}
            />
          </Box>
        </Collapse>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} color="inherit">
          取消
        </Button>
        <Button variant="contained" onClick={submit}>
          {submitLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** 分区标题；辅助说明用括号跟在后面，避免多占一行 */
function FieldLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.75, mt: 1 }}>
      {label}
      {hint && (
        <Typography component="span" color="text.secondary" sx={{ fontSize: 12, ml: 0.5 }}>
          （{hint}）
        </Typography>
      )}
    </Typography>
  );
}

/** 工具条按钮的统一观感：低对比、hover 才提亮，避免抢走正文注意力 */
const TOOLBAR_BUTTON_SX = {
  textTransform: 'none',
  color: 'text.secondary',
  fontSize: 12,
  px: 0.75,
  minWidth: 0,
  '&:hover': { bgcolor: 'action.hover', color: 'text.primary' },
} as const;

/**
 * 提示词框底部的「执行配置」工具条：模型 / 技能 / 专家 / 权限。
 *
 * 与聊天输入框的会话级控件同义，但作用于**任务**（落到 `TaskConfig.runOptions`，
 * 同步时进 nanobot payload.originMetadata），所以不复用 `ComposerControls`
 * ——那边改的是当前会话，这里改的是任务配置，共用会把两条写入路径搅在一起。
 */
function RunOptionsBar({
  model,
  skillIds,
  agentId,
  fullAccess,
  onModel,
  onSkills,
  onAgent,
  onFullAccess,
}: {
  model: string;
  skillIds: string[];
  agentId: string;
  fullAccess: boolean;
  onModel: (modelId: string) => void;
  onSkills: (skillIds: string[]) => void;
  onAgent: (agentId: string) => void;
  onFullAccess: (fullAccess: boolean) => void;
}) {
  const agents = useAgentsStore((s) => s.agents);
  const allSkills = useSkillsStore((s) => s.skills);
  const models = useModelsStore((s) => s.models);
  const refreshModels = useModelsStore((s) => s.refresh);

  // 只在启用档（含 on / user-invocable-only）里选，避免把已停用技能挂到任务上
  const skills = useMemo(() => allSkills.filter((sk) => sk.enabled), [allSkills]);

  const [modelAnchor, setModelAnchor] = useState<HTMLElement | null>(null);
  const [skillAnchor, setSkillAnchor] = useState<HTMLElement | null>(null);
  const [agentAnchor, setAgentAnchor] = useState<HTMLElement | null>(null);
  const [permAnchor, setPermAnchor] = useState<HTMLElement | null>(null);

  const agentName = agents.find((a) => a.id === agentId)?.name;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        px: 1,
        py: 0.5,
        borderTop: '1px solid',
        borderColor: 'divider',
        flexWrap: 'wrap',
      }}
    >
      <Button
        size="small"
        startIcon={<AutoAwesomeIcon fontSize="small" />}
        endIcon={<ExpandMoreIcon fontSize="small" />}
        onClick={(e) => {
          setModelAnchor(e.currentTarget);
          // 打开下拉时才拉目录：既省一次启动期请求，也顺便拿到最新预设
          void refreshModels();
        }}
        sx={TOOLBAR_BUTTON_SX}
      >
        {describeModelId(models, model)}
      </Button>
      <Menu
        anchorEl={modelAnchor}
        open={!!modelAnchor}
        onClose={() => setModelAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 180 } } }}
      >
        <MenuItem
          selected={model === ''}
          onClick={() => {
            onModel('');
            setModelAnchor(null);
          }}
          sx={{ fontSize: 13 }}
        >
          {describeModelId(models, null)}
        </MenuItem>
        <Divider />
        {models
          .filter((m) => m.id !== 'default')
          .map((m) => (
            <MenuItem
              key={m.id}
              selected={m.id === model}
              onClick={() => {
                onModel(m.id);
                setModelAnchor(null);
              }}
              sx={{ fontSize: 13 }}
            >
              {describeModelId(models, m.id)}
            </MenuItem>
          ))}
      </Menu>

      <Button
        size="small"
        startIcon={<AutoFixHighIcon fontSize="small" />}
        endIcon={<ExpandMoreIcon fontSize="small" />}
        onClick={(e) => setSkillAnchor(e.currentTarget)}
        sx={TOOLBAR_BUTTON_SX}
      >
        {`技能${skillIds.length > 0 ? ` · ${skillIds.length}` : ''}`}
      </Button>
      <Menu
        anchorEl={skillAnchor}
        open={!!skillAnchor}
        onClose={() => setSkillAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 220, maxHeight: 320 } } }}
      >
        {skills.length === 0 && (
          <MenuItem disabled sx={{ fontSize: 13 }}>
            暂无已启用技能
          </MenuItem>
        )}
        {skills.map((skill) => {
          const checked = skillIds.includes(skill.id);
          return (
            <MenuItem
              key={skill.id}
              // 多选菜单刻意不自动关闭：一次勾选多项是常见操作
              onClick={() =>
                onSkills(
                  checked ? skillIds.filter((id) => id !== skill.id) : [...skillIds, skill.id],
                )
              }
              sx={{ fontSize: 13 }}
            >
              <Checkbox size="small" checked={checked} sx={{ p: 0.5, mr: 1 }} />
              <ListItemText primary={skill.name} primaryTypographyProps={{ fontSize: 13 }} />
            </MenuItem>
          );
        })}
      </Menu>

      <Button
        size="small"
        startIcon={<PsychologyIcon fontSize="small" sx={{ color: 'primary.main' }} />}
        endIcon={<ExpandMoreIcon fontSize="small" />}
        onClick={(e) => setAgentAnchor(e.currentTarget)}
        sx={TOOLBAR_BUTTON_SX}
      >
        {agentName ?? '召唤专家'}
      </Button>
      <Menu
        anchorEl={agentAnchor}
        open={!!agentAnchor}
        onClose={() => setAgentAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 180 } } }}
      >
        {agents.map((agent) => (
          <MenuItem
            key={agent.id}
            selected={agent.id === agentId}
            onClick={() => {
              onAgent(agent.id);
              setAgentAnchor(null);
            }}
            sx={{ fontSize: 13 }}
          >
            {agent.name}
          </MenuItem>
        ))}
      </Menu>

      <Button
        size="small"
        startIcon={
          fullAccess ? (
            <GppMaybeIcon fontSize="small" sx={{ color: 'warning.main' }} />
          ) : (
            <VerifiedUserIcon fontSize="small" sx={{ color: 'success.main' }} />
          )
        }
        endIcon={<ExpandMoreIcon fontSize="small" />}
        onClick={(e) => setPermAnchor(e.currentTarget)}
        sx={TOOLBAR_BUTTON_SX}
      >
        {fullAccess ? '完全访问权限' : '默认权限'}
      </Button>
      <Menu
        anchorEl={permAnchor}
        open={!!permAnchor}
        onClose={() => setPermAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 200 } } }}
      >
        <MenuItem
          selected={!fullAccess}
          onClick={() => {
            onFullAccess(false);
            setPermAnchor(null);
          }}
          sx={{ fontSize: 13 }}
        >
          默认权限（敏感操作逐一确认）
        </MenuItem>
        <MenuItem
          selected={fullAccess}
          onClick={() => {
            onFullAccess(true);
            setPermAnchor(null);
          }}
          sx={{ fontSize: 13 }}
        >
          允许完全访问权限（自动批准）
        </MenuItem>
      </Menu>
    </Box>
  );
}
