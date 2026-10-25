/**
 * 从自然语言推断执行调度（FR-5.5 补）。
 *
 * 这类「聪明的文本解析」真正的风险**不是漏判**（漏了只是没帮你填，用户一眼看得见），
 * 而是**误判**：把「每周例会」当成「每周一」、把「上一次是 3 点」当成每天 3 点 ——
 * 于是用户得到一条自己没设计过的自动化，而自动化是**会自己跑起来**的东西，要等到它
 * 半夜发消息才发现。所以下面否定用例与肯定用例几乎一比一。
 */
import { describe, expect, it } from 'vitest';
import { inferScheduleFromText } from '@/lib/task/scheduleFromText';

/** cron 表达式（非 cron 形态返回 null，便于一眼看出「类型就不对」） */
function expr(text: string): string | null {
  const hint = inferScheduleFromText(text);
  if (!hint || hint.schedule.kind !== 'cron') return null;
  return hint.schedule.expr;
}

/** 间隔分钟数（非 interval 形态返回 null） */
function minutes(text: string): number | null {
  const hint = inferScheduleFromText(text);
  if (!hint || hint.schedule.kind !== 'interval') return null;
  return hint.schedule.minutes;
}

describe('推断出频率与时刻', () => {
  it('⭐ PRD 的原例：「每周一早上 9 点」→ 每周一 09:00', () => {
    expect(expr('每周一早上9点提醒我开周会')).toBe('0 9 * * 1');
  });

  it('多日列举（顿号）', () => {
    expect(expr('每周一、三、五 上午 10:30 站会')).toBe('30 10 * * 1,3,5');
  });

  it('多日列举（连写，无分隔符）', () => {
    expect(expr('每周一三五下午3点')).toBe('0 15 * * 1,3,5');
  });

  it('多日列举（数字形态）', () => {
    expect(expr('每周1,3,5 交周报')).toBe('0 9 * * 1,3,5');
  });

  it('区间写法「每周一到周五」', () => {
    expect(expr('每周一到周五 8点 播报天气')).toBe('0 8 * * 1-5');
  });

  it('跨周界的区间要绕回（周五到周一 = 周五六日一，不是「周五和周一」）', () => {
    expect(expr('每周五到周一 值班')).toBe('0 9 * * 0,1,5,6');
  });

  it('绕回正好七天时归一成「每天」（周一到周日就是每天）', () => {
    expect(expr('每周一到周日 巡检')).toBe('0 9 * * *');
  });

  it('每个工作日', () => {
    expect(expr('每个工作日 18:00 提醒我打卡')).toBe('0 18 * * 1-5');
  });

  it('每月 N 号', () => {
    expect(expr('每月1号上午10点生成月报')).toBe('0 10 1 * *');
  });

  it('每月（中文数字）', () => {
    expect(expr('每月十五号下午3点结算')).toBe('0 15 15 * *');
  });

  it('每天（未指定时刻 → 落表单默认 09:00）', () => {
    expect(expr('每天提醒我喝水')).toBe('0 9 * * *');
  });

  it('「每一天」也算每天（不是「每 1 天」的间隔）', () => {
    expect(expr('每一天 早上 8 点 收邮件')).toBe('0 8 * * *');
  });
});

describe('时刻解析', () => {
  it('24 小时制与冒号形态', () => {
    expect(expr('每天 09:00')).toBe('0 9 * * *');
    expect(expr('每天 21:30')).toBe('30 21 * * *');
  });

  it('「点」形态：阿拉伯数字与中文数字都要认', () => {
    expect(expr('每天十点')).toBe('0 10 * * *');
    expect(expr('每天十一点')).toBe('0 11 * * *');
    expect(expr('每天二十三点')).toBe('0 23 * * *');
  });

  it('半 / 一刻 / 三刻', () => {
    expect(expr('每天早上7点半')).toBe('30 7 * * *');
    expect(expr('每天下午三点半')).toBe('30 15 * * *');
    expect(expr('每天下午3点一刻')).toBe('15 15 * * *');
  });

  it('时段补正：下午/晚上 补 12 小时，但已经是 24 小时制就不重复补', () => {
    expect(expr('每天晚上 8 点')).toBe('0 20 * * *');
    expect(expr('每天下午 15 点')).toBe('0 15 * * *');
  });

  it('中午 12 点 = 12:00；凌晨 1 点 = 01:00', () => {
    expect(expr('每天中午12点')).toBe('0 12 * * *');
    expect(expr('每天凌晨1点')).toBe('0 1 * * *');
  });

  it('晚上 12 点 / 凌晨 12 点都是零点', () => {
    expect(expr('每天晚上12点归档')).toBe('0 0 * * *');
    expect(expr('每天凌晨12点归档')).toBe('0 0 * * *');
  });

  it('只说时段时用锚点（早上 → 09:00）', () => {
    expect(expr('每天早上')).toBe('0 9 * * *');
  });

  it('时段词只影响**它附近**的时刻（不拿句子里别处的「下午」乱补）', () => {
    expect(expr('每天9点跑步，下午开会')).toBe('0 9 * * *');
  });
});

describe('间隔', () => {
  it('每半小时 / 每 N 分钟 / 每 N 小时 / 每小时', () => {
    expect(minutes('每半小时看一眼')).toBe(30);
    expect(minutes('每30分钟检查一次')).toBe(30);
    expect(minutes('每两个小时同步一次')).toBe(120);
    expect(minutes('每小时上报')).toBe(60);
  });

  it('每 N 天 / 每 N 周 用引擎原生间隔，而不是 cron 的 */N（日字段步长跨月会错位）', () => {
    expect(minutes('每2天备份一次')).toBe(2880);
    expect(minutes('每两周汇总一次')).toBe(20160);
  });

  it('超出表单上限（59999 分钟）时**不填**，而不是产出会被静默夹掉的数字', () => {
    expect(minutes('每100天备份')).toBeNull();
    expect(minutes('每60周汇总')).toBeNull();
  });
});

describe('不猜：识别不出就返回 null', () => {
  it('空文本', () => {
    expect(inferScheduleFromText('')).toBeNull();
    expect(inferScheduleFromText('   ')).toBeNull();
  });

  it('普通对话里没有时间规则', () => {
    expect(inferScheduleFromText('帮我看看这段报错')).toBeNull();
    expect(inferScheduleFromText('把这几个文件重命名一下')).toBeNull();
  });

  it('⭐「每周例会」不是「每周一」（例 不是星期字）', () => {
    expect(inferScheduleFromText('每周例会纪要发我一份')).toBeNull();
  });

  it('⭐ 只说了时刻、没说频率 —— 那不是一个调度', () => {
    expect(inferScheduleFromText('上一次是 3 点跑的')).toBeNull();
    expect(inferScheduleFromText('下午三点开会')).toBeNull();
  });

  it('⭐「每周三 10 点」里的 10 不能被当成星期（周日）', () => {
    expect(expr('每周三 10 点开评审会')).toBe('0 10 * * 3');
  });

  it('「每周」后面读不出星期就不填', () => {
    expect(inferScheduleFromText('每周整理一次')).toBeNull();
  });

  it('每月 32 号不存在 → 不产出非法 cron', () => {
    expect(inferScheduleFromText('每月32号跑一次')).toBeNull();
  });

  it('「每三周」是间隔，不是「周三」', () => {
    expect(minutes('每三周复盘一次')).toBe(30240);
  });
});

describe('description 的诚实性（界面直接展示它）', () => {
  it('没有时刻时明说「按默认时刻」，不把默认值伪装成用户写的', () => {
    expect(inferScheduleFromText('每天提醒我喝水')?.description).toContain('按默认时刻');
  });

  it('有时刻时不说「默认」', () => {
    expect(inferScheduleFromText('每天早上9点')?.description).toBe('每天 09:00');
  });

  it('星期与时刻都写进说明', () => {
    expect(inferScheduleFromText('每周一、三、五上午10点站会')?.description).toBe(
      '每周一、周三、周五 10:00',
    );
  });

  it('matched 是「凭什么这么填」的证据（原文片段）', () => {
    expect(inferScheduleFromText('每周一早上9点提醒我')?.matched).toBe('每周一');
  });
});
