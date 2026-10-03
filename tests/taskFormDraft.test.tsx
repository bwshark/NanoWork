/**
 * 任务表单的**草稿组装**契约（FR-5.4 生效区间 + FR-5.6 结果推送）。
 *
 * 这个文件锁的是两条**浅合并陷阱**与一处**编码错位**——它们都不会编译报错，
 * 但会让用户「填了看不见、删了删不掉」：
 *
 * 1. `updateTask` 是浅合并（`{...t, ...patch}`）→ 草稿里**省略**一个键 = 旧值被原样留下。
 *    所以「删掉最后一个推送目标」「清空生效区间」这两种清空动作，都必须**显式写 `undefined`**。
 * 2. 生效区间**不能编进 cron**：`每天 09:00` + 开始日期曾经被写成 `0 9 15 10 *`
 *    （每年 10 月 15 日才跑一次）。cron 没有「从哪天起生效」，这件事只能由
 *    `validFrom` / `validUntil` 承载。
 *
 * 时间一律用**本地时间**构造（`dayStartIso` / `dayEndIso` 都是本地日边界），
 * 用 UTC 字面量写期望值会在非 +08:00 机器上假红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { TaskFormDialog } from '@/components/tasks/TaskFormDialog';
import { useChannelSessionsStore } from '@/stores/channelSessionsStore';
import { useAgentsStore } from '@/stores/agentsStore';
import {
  buttonByText,
  byAria,
  fieldByLabel,
  mount,
  setInputValue,
  unmount,
} from './helpers/reactMount';
import type { NanobotChannelSessionSummary } from '@/platform/types';
import type { TaskConfig } from '@/types';
import type { TaskDraft } from '@/lib/taskDraft';

/** 本地时间 → ISO（与表单里 `dayStartIso` / `dayEndIso` 同口径） */
const iso = (y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0): string =>
  new Date(y, m - 1, d, h, mi, s, ms).toISOString();

const SUMMARY: NanobotChannelSessionSummary = {
  key: 'wecom:chat-1',
  channel: 'wecom',
  title: '研发群',
  preview: '',
  messageCount: 3,
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
};

let onSubmit: ReturnType<typeof vi.fn<(data: TaskDraft) => void>>;

function renderForm(initial?: Partial<TaskConfig>): void {
  onSubmit = vi.fn<(data: TaskDraft) => void>();
  mount(
    <TaskFormDialog
      open
      initial={initial}
      onSubmit={onSubmit}
      onClose={() => {
        /* 关闭由父级负责；本文件只关心草稿 */
      }}
    />,
  );
}

/** 提交并取出草稿 */
async function submitAndDraft(): Promise<TaskDraft> {
  const save = buttonByText(document.body, '保存');
  expect(save, '弹窗里应有「保存」').toBeTruthy();
  await act(async () => {
    save!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(onSubmit, '表单应已提交（校验通过）').toHaveBeenCalledTimes(1);
  return onSubmit.mock.calls[0][0] as TaskDraft;
}

function setDay(label: string, value: string): void {
  setInputValue(fieldByLabel(label) as HTMLInputElement, value);
}

beforeEach(() => {
  useChannelSessionsStore.setState({ summaries: [SUMMARY], loading: false });
  vi.spyOn(useChannelSessionsStore.getState(), 'refresh').mockResolvedValue(undefined);
  useAgentsStore.setState({ agents: [] });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
  useChannelSessionsStore.setState({ summaries: [], loading: false });
});

describe('TaskFormDialog：生效区间（FR-5.4）', () => {
  it('⭐ 每天 + 生效区间 → cron 仍是「每天」，区间走 validFrom / validUntil', async () => {
    renderForm({ name: '早报' });
    setDay('开始', '2026-10-15');
    setDay('结束', '2026-11-20');

    const draft = await submitAndDraft();

    // 曾经这里是 `0 9 15 10 *`（每年 10 月 15 日）——把「每天」静默改成了一年一次
    expect(draft.schedule).toEqual({ kind: 'cron', expr: '0 9 * * *' });
    expect(draft.validFrom).toBe(iso(2026, 10, 15));
    // 上界是**含**当天的，所以取当日末刻而不是零点
    expect(draft.validUntil).toBe(iso(2026, 11, 20, 23, 59, 59, 999));
  });

  it('没填区间时两个键仍然在场，只是值为 undefined', async () => {
    renderForm({ name: '早报' });

    const draft = await submitAndDraft();

    // ⭐ 必须**在场**：`updateTask` 是浅合并，键不在 = 旧区间被留下，「清空」变成删不掉
    expect('validFrom' in draft).toBe(true);
    expect('validUntil' in draft).toBe(true);
    expect(draft.validFrom).toBeUndefined();
    expect(draft.validUntil).toBeUndefined();
  });

  it('编辑既有任务时区间被回填（否则一保存就把区间清了）', () => {
    renderForm({
      name: '早报',
      validFrom: iso(2026, 10, 15),
      validUntil: iso(2026, 11, 20),
    });

    expect((fieldByLabel('开始') as HTMLInputElement).value).toBe('2026-10-15');
    expect((fieldByLabel('结束') as HTMLInputElement).value).toBe('2026-11-20');
  });

  it('清空已有区间 → 草稿里是 undefined（能真的清掉）', async () => {
    renderForm({ name: '早报', validFrom: iso(2026, 10, 15) });
    setDay('开始', '');

    const draft = await submitAndDraft();
    // 同 delivery：键必须**在场**才叫清掉，否则浅合并会把旧区间留下
    expect('validFrom' in draft).toBe(true);
    expect(draft.validFrom).toBeUndefined();
  });
});

describe('TaskFormDialog：结果推送（FR-5.6）', () => {
  it('未配置推送 → 草稿里 delivery 是在场的 undefined（浅合并下才能真的清掉）', async () => {
    renderForm({ name: '早报' });

    const draft = await submitAndDraft();
    expect('delivery' in draft).toBe(true);
    expect(draft.delivery).toBeUndefined();
  });

  it('⭐ 删掉最后一个推送目标后保存 → delivery 变回 undefined，而不是被旧值留下', async () => {
    renderForm({
      name: '早报',
      delivery: { targets: [{ channel: 'wecom', chatId: 'chat-1' }], on: 'complete' },
    });

    const chipDelete = document.querySelector(
      '.MuiDialog-paper .MuiChip-deleteIcon',
    ) as Element | null;
    expect(chipDelete, '应渲染出已选目标的 Chip（带删除按钮）').toBeTruthy();
    await act(async () => {
      chipDelete!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const draft = await submitAndDraft();
    // ⭐ 必须**在场**才算真清掉。只断言 `draft.delivery === undefined` 是**假判据**：
    // 键缺失时它也成立，而那正是「旧配置被浅合并留下」的场景（已用变异验证过）。
    expect('delivery' in draft).toBe(true);
    expect(draft.delivery).toBeUndefined();
  });

  it('配置了推送 → 原样进草稿（渠道与会话 id 都在）', async () => {
    renderForm({
      name: '早报',
      delivery: { targets: [{ channel: 'feishu.feishu', chatId: 'ou_1' }], on: 'error' },
    });

    const draft = await submitAndDraft();
    expect(draft.delivery).toEqual({
      targets: [{ channel: 'feishu.feishu', chatId: 'ou_1' }],
      on: 'error',
    });
  });
});

describe('TaskFormDialog：工作目录（FR-5.8）', () => {
  const setWorkdir = (v: string) => setInputValue(byAria('工作目录') as HTMLInputElement, v);

  it('填了绝对路径 → 进草稿', async () => {
    renderForm({ name: '早报' });
    setWorkdir('/home/me/proj');

    const draft = await submitAndDraft();
    expect(draft.workdir).toBe('/home/me/proj');
  });

  it('未填 → 键在场但值为 undefined（浅合并下才能清掉旧绑定）', async () => {
    renderForm({ name: '早报' });

    const draft = await submitAndDraft();
    expect('workdir' in draft).toBe(true);
    expect(draft.workdir).toBeUndefined();
  });

  it('清空已有目录 → undefined（能真的清掉）', async () => {
    renderForm({ name: '早报', workdir: '/home/me/proj' });
    setWorkdir('');

    const draft = await submitAndDraft();
    expect('workdir' in draft).toBe(true);
    expect(draft.workdir).toBeUndefined();
  });

  it('⭐ 相对路径当场被拦（引擎对相对路径是**静默回落默认目录**，录入侧是唯一便宜的时机）', async () => {
    renderForm({ name: '早报' });
    setWorkdir('proj/alpha');

    const save = buttonByText(document.body, '保存');
    await act(async () => {
      save!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('编辑既有任务时目录被回填（否则一保存就把绑定清了）', () => {
    renderForm({ name: '早报', workdir: '/home/me/proj' });
    expect((byAria('工作目录') as HTMLInputElement).value).toBe('/home/me/proj');
  });
});
