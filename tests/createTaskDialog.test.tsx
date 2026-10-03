/**
 * 聊天入口的任务弹窗（FR-5.5 补）：「消息正文 → 表单预填」这一跳。
 *
 * 为什么这一跳值得单独测：它跨了两个模块（`scheduleFromText` 的推断 / `TaskFormDialog`
 * 的回显），而两边各自看起来都对 —— 推断对了、表单也能回显，但**中间的接线**错了就会
 * 表现成「打开表单什么都没填」。更要紧的是**多日与工作日**这类调度在结构化控件里表达不了：
 * `scheduleToUi` 会把它落到折叠区里的 `cronOverride`，默认收起的话用户看到的是控件的
 * 默认值（每天 09:00），而他真正生效的规则藏在折叠区 —— 所以这里连「高级默认展开」一起钉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateTaskDialog } from '@/components/chat/CreateTaskDialog';
import { useAgentsStore } from '@/stores/agentsStore';
import { useTasksStore } from '@/stores/tasksStore';
import { buttonByText, fieldByLabel, mount, unmount } from './helpers/reactMount';
import type { Message } from '@/types';

function assistantMessage(content: string): Message {
  return { id: 'm1', role: 'assistant', content, createdAt: new Date().toISOString() };
}

/** 弹窗标题（走 Portal，取 document 而不是挂载容器） */
const dialog = () => document.querySelector('[role="dialog"]');
/**
 * 整页文本。
 *
 * ⚠️ 用 `textContent` 而**不能**用 `innerText`：jsdom 没实现 `innerText`，读出来是
 * `undefined`，断言会变成「undefined 与字符串比」这种看不出根因的报错。
 * （真机 Playwright 里反过来 —— 那里 `innerText` 才是对的，它会做可见性过滤。）
 */
const bodyText = () => document.body.textContent ?? '';

/** 折叠区的开关按钮文案会跟着展开状态变，用它判断「高级」是否默认展开 */
const advancedButton = () => buttonByText(document.body, '高级') ?? buttonByText(document.body, '收起高级');
const cronOverrideValue = () =>
  (fieldByLabel('Cron 表达式（覆盖上方设置）') as HTMLInputElement | null)?.value ?? null;

beforeEach(() => {
  useAgentsStore.setState({ agents: [] });
  useTasksStore.setState({ tasks: [], tombstones: {}, runs: [], lastSync: null, syncing: false });
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('CreateTaskDialog：消息里的时间规则被填进表单', () => {
  it('⭐「每周一早上9点」→ 结构化回显（时间控件就有值，不需要展开高级）', () => {
    mount(
      <CreateTaskDialog
        open
        message={assistantMessage('每周一早上9点提醒我开周会')}
        agentId="a1"
        onClose={() => {}}
      />,
    );

    expect(dialog()).toBeTruthy();
    expect(bodyText()).toContain('已从消息里识别执行频率：每周一 09:00');
    // 能结构化表达 ⇒ 不落到 cronOverride ⇒ 高级保持收起
    expect(cronOverrideValue()).toBe('');
    expect(buttonByText(document.body, '收起高级')).toBeNull();
  });

  it('⭐「每天」→ 也走结构化，并明说时刻是默认值', () => {
    mount(
      <CreateTaskDialog
        open
        message={assistantMessage('每天提醒我喝水')}
        agentId="a1"
        onClose={() => {}}
      />,
    );

    expect(bodyText()).toContain('按默认时刻');
    expect(cronOverrideValue()).toBe('');
  });

  it('⭐ 多日（结构化表达不了）→ 原文落进高级，且高级**默认展开**', () => {
    mount(
      <CreateTaskDialog
        open
        message={assistantMessage('每周一、三、五 上午 10:30 站会')}
        agentId="a1"
        onClose={() => {}}
      />,
    );

    expect(bodyText()).toContain('已从消息里识别执行频率：每周一、周三、周五 10:30');
    // 真规则在折叠区里 —— 必须默认展开，否则「配了看不见」
    expect(cronOverrideValue()).toBe('30 10 * * 1,3,5');
    expect(buttonByText(document.body, '收起高级')).toBeTruthy();
  });

  it('每个工作日 也落到高级并默认展开（cron 的区间写法结构化表达不了）', () => {
    mount(
      <CreateTaskDialog
        open
        message={assistantMessage('每个工作日 18:00 提醒我打卡')}
        agentId="a1"
        onClose={() => {}}
      />,
    );

    expect(cronOverrideValue()).toBe('0 18 * * 1-5');
    expect(buttonByText(document.body, '收起高级')).toBeTruthy();
  });

  it('认不出时间规则时不显示提示，也不留残留的调度', () => {
    mount(
      <CreateTaskDialog
        open
        message={assistantMessage('帮我看看这段报错')}
        agentId="a1"
        onClose={() => {}}
      />,
    );

    expect(bodyText()).not.toContain('已从消息里识别执行频率');
    expect(cronOverrideValue()).toBe('');
    // 名称与提示词仍然预填（推断只影响执行频率）
    expect((fieldByLabel('名称') as HTMLInputElement).value).toBe('帮我看看这段报错');
  });
});
