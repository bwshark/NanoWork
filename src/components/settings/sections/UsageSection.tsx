import { useEffect, useMemo } from 'react';
import {
  Box,
  Button,
  Chip,
  LinearProgress,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useTheme,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import {
  aggregateBySource,
  dateAxisLabel,
  formatRate,
  formatTokens,
  formatTtft,
  sliceUsageDays,
  sumDays,
  todayLocalIso,
  USAGE_WINDOWS,
  type UsageWindow,
} from '@/lib/usageReport';
import { useUsageStore } from '@/stores/usageStore';
import { useModelsStore } from '@/stores/modelsStore';
import {
  computeCost,
  formatCost,
  formatUnitPrice,
  resolvePricingFor,
  sumByCurrency,
} from '@/lib/modelPricing';

/**
 * 用量分区（FR-11.1）：本机 LLM 用量报表。
 *
 * ## 数字一律来自引擎
 *
 * 概览里的 30 天合计、峰值日、连续天数、缓存命中率**全部**由引擎的
 * `nanobot.llm_usage` 算好（`/v1/usage`）。这里只做三件**展示层**的事：
 * 切片（按窗口取天）、格式化（万/亿）、按来源合并排序。
 *
 * 为什么不在客户端重算一遍：口径（按**引擎配置的本地日**归日、缓存命中率的分母
 * 只算「渠道真的上报了缓存」的请求）改一次，这边就静默偏一次，而偏的是数字、
 * 不是报错——没人会在第一时间发现。
 *
 * ## 三种「没有数据」必须分开说
 *
 * 1. 还没读（`!loaded`）→ 读条；
 * 2. 读不到（`!available`，网关没起 / 引擎版本旧）→ 报原因，并说明数据在哪；
 * 3. 读到了但确实没用量（`available` + `days: []`）→ 「还没有用量记录」。
 *
 * 混成一句「暂无数据」会让用户分不清「我没用过」和「应用坏了」，
 * 而这两种情况该做的下一步完全不同。
 */

/** 单日柱子的最小可见高度（px）：有用量但极小的那天不该画成 0（看起来像没跑） */
const MIN_BAR_HEIGHT = 2;
const CHART_HEIGHT = 132;

export function UsageSection() {
  const stats = useUsageStore((s) => s.stats);
  const loaded = useUsageStore((s) => s.loaded);
  const refreshing = useUsageStore((s) => s.refreshing);
  const windowDays = useUsageStore((s) => s.windowDays);
  const refresh = useUsageStore((s) => s.refresh);
  const setWindowDays = useUsageStore((s) => s.setWindowDays);

  // 每次进分区都重读：这是一份**实时**报表，用户反复开关设置时拿上次的数字
  // 比多一次本地 HTTP 更难解释（「我刚跑完一批任务，怎么还是零」）。
  // 并发由 store 的 `refreshing` 去重，StrictMode 的双次执行不会打两次。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const windowed = useMemo(
    () => sliceUsageDays(stats.days, windowDays, todayLocalIso()),
    [stats.days, windowDays],
  );
  const totals = useMemo(() => sumDays(windowed), [windowed]);
  const bySource = useMemo(() => aggregateBySource(windowed), [windowed]);

  /**
   * 单价来自模型预设（FR-11.1 的金额口径）。
   *
   * 与「设置 → 模型」共用同一份 `managed`：单价在那里编辑、在这里结算，
   * 分成两份状态就会出现「改了单价，报表还是老数字」。补读的理由同
   * `useActiveModelCapabilities`（用户可能从没打开过模型分区）。
   */
  const managed = useModelsStore((m) => m.managed);
  const loadManaged = useModelsStore((m) => m.loadManaged);
  useEffect(() => {
    if (managed.length === 0) void loadManaged();
  }, [managed.length, loadManaged]);

  /**
   * 逐模型的成本。**只算配了单价的那些**——没配的按 0 计入会让人以为「都算过了」，
   * 而合计里少了几个模型正是最需要被看见的信息。
   *
   * 归因口径见 `src/lib/modelPricing.ts` 的文件头：用量表只有 `(provider, model)`
   * 两列，同一个上游模型被多个预设引用时取第一条（不承诺精确归因，已如实说明）。
   */
  const pricedRows = useMemo(
    () =>
      stats.providers.map((row) => {
        const pricing = resolvePricingFor(managed, row.provider, row.model);
        return { row, pricing, cost: pricing ? computeCost(row, pricing) : null };
      }),
    [stats.providers, managed],
  );

  const costTotals = useMemo(
    () =>
      sumByCurrency(
        pricedRows.flatMap((r) =>
          r.cost !== null && r.pricing ? [{ cost: r.cost, currency: r.pricing.currency }] : [],
        ),
      ),
    [pricedRows],
  );
  const unpricedCount = pricedRows.filter((r) => r.cost === null).length;

  if (!loaded) {
    return (
      <Box sx={{ py: 1 }}>
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>正在读取用量…</Typography>
        <LinearProgress sx={{ mt: 1.5 }} />
      </Box>
    );
  }

  if (!stats.available) {
    return (
      <Box>
        <SettingsCard title="用量">
          <SettingsRow
            label="读不到用量数据"
            hint={
              <>
                {stats.error ?? '未知原因'}
                <br />
                用量由引擎的 <code>/v1/usage</code> 汇总（数据落在本机{' '}
                <code>llm_usage.sqlite3</code>）。网关没启动，或引擎版本还没有这条路由时，
                这里就会是空的。
              </>
            }
            control={
              <Button size="small" startIcon={<RefreshIcon />} onClick={() => void refresh()}>
                重试
              </Button>
            }
          />
        </SettingsCard>
      </Box>
    );
  }

  const { summary } = stats;

  return (
    <Box>
      <SettingsCard
        title="近 30 天概览"
        action={
          <Button
            size="small"
            startIcon={<RefreshIcon />}
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            刷新
          </Button>
        }
      >
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, py: 2 }}>
          <Metric label="总 token" value={formatTokens(summary.tokens30d)} />
          <Metric label="请求数" value={String(summary.requests30d)} />
          {/*
            平均首字延迟（FR-11.7）。分母是「量到过首字的请求数」而不是请求总数，
            一次都没量到显示「—」而不是 0 —— 判据全在 `formatTtft` 一处，
            UI 不自己写除法（否则两处口径必然漂移）。
          */}
          <Metric label="平均首字延迟" value={formatTtft(totals)} />
          <Metric label="缓存命中率" value={formatRate(summary.cacheReadRate30d)} />
          <Metric label="活跃天数" value={`${summary.activeDays30d} 天`} />
          <Metric label="单日峰值" value={formatTokens(summary.peakDayTokens)} />
          <Metric label="连续使用" value={`${summary.currentStreakDays} 天`} />
        </Box>
        <SettingsRow
          label="计量口径"
          hint={
            <>
              其中 {formatTokens(summary.reportedTokens30d)} 由渠道真实上报，
              {formatTokens(summary.estimatedTokens30d)} 为本地估算（渠道未返回用量时按字符数补）。
              统计按引擎配置的本地日归日，与系统时区可能相差一天。
              {stats.updatedAt ? ` 最后更新：${formatUpdatedAt(stats.updatedAt)}` : ''}
            </>
          }
        />
      </SettingsCard>

      <SettingsCard
        title="每日趋势"
        description={`近 ${windowDays} 天 · 合计 ${formatTokens(totals.totalTokens)} token · ${totals.requests} 次请求`}
        action={
          <ToggleButtonGroup
            size="small"
            exclusive
            value={windowDays}
            onChange={(_, next: UsageWindow | null) => {
              // 点当前档位时 MUI 给 `null`（取消选择）；窗口必须有值，故忽略
              if (next !== null) setWindowDays(next);
            }}
          >
            {USAGE_WINDOWS.map((days) => (
              <ToggleButton key={days} value={days} sx={{ px: 1.5, textTransform: 'none' }}>
                {days} 天
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        }
      >
        <Box sx={{ py: 2 }}>
          {windowed.length === 0 ? (
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
              近 {windowDays} 天还没有用量记录。
            </Typography>
          ) : (
            <UsageBars days={windowed} />
          )}
        </Box>
      </SettingsCard>

      <SettingsCard title="用量来源">
        {bySource.length === 0 ? (
          <SettingsRow label="暂无来源数据" hint="当前窗口内没有可拆分的用量记录。" />
        ) : (
          bySource.map((row) => (
            <SettingsRow
              key={row.source}
              label={row.label}
              hint={`${formatTokens(row.counters.totalTokens)} token · ${row.counters.requests} 次请求`}
              control={
                <Chip
                  size="small"
                  variant="outlined"
                  label={shareText(row.counters.totalTokens, totals.totalTokens)}
                />
              }
            />
          ))
        )}
      </SettingsCard>

      <SettingsCard title="模型用量" description="近 30 天，按 token 降序">
        {stats.providers.length === 0 ? (
          <SettingsRow label="暂无模型数据" hint="引擎还没有记录到任何一次模型调用。" />
        ) : (
          pricedRows.map(({ row, pricing, cost }) => (
            <SettingsRow
              key={`${row.provider}/${row.model}`}
              label={`${row.provider} · ${row.model}`}
              hint={
                <>
                  输入 {formatTokens(row.inputTokens)} · 输出 {formatTokens(row.outputTokens)} ·{' '}
                  {row.requests} 次请求
                  <br />
                  {pricing ? (
                    <>
                      单价 {formatUnitPrice(pricing)}（每百万 token）
                      {/* 缓存占输入的比例是判断「金额准不准」的关键：缓存单价没填时
                          按输入价结算，占比越高这个上界越松 */}
                      {' · '}缓存读 {formatTokens(row.cacheReadTokens)}
                    </>
                  ) : (
                    '未配置单价 → 不计入金额合计（在「设置 → 模型」的「计价」里填）'
                  )}
                </>
              }
              control={
                cost === null ? (
                  <Chip size="small" variant="outlined" label={`${formatTokens(row.totalTokens)} token`} />
                ) : (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${formatCost(cost, pricing!.currency)} · ${formatTokens(row.totalTokens)}`}
                  />
                )
              }
            />
          ))
        )}
      </SettingsCard>

      <SettingsCard
        title="成本"
        description="按你在「设置 → 模型」里填的单价结算（每百万 token，不换算汇率）"
      >
        {costTotals.length === 0 ? (
          <SettingsRow
            label="金额暂不统计"
            hint={
              <>
                还没有任何一个模型配过单价。到「设置 → 模型 → 计价」里填上输入 / 输出单价即可——
                {' '}
                <strong>留空就是不计</strong>，不会按 0 计入。
                <br />
                缓存读取那一档可以不填（按输入单价结算，是一个明确的上界）：引擎的输入 token
                本就包含缓存读取，而长会话里它往往占绝大多数，这一档对结果影响最大。
              </>
            }
          />
        ) : (
          <>
            {costTotals.map((t) => (
              <SettingsRow
                key={t.currency}
                label={formatCost(t.amount, t.currency)}
                hint={`近 30 天 · 覆盖 ${t.models} 个模型${
                  unpricedCount > 0 ? ` · 还有 ${unpricedCount} 个模型没配单价（未计入）` : ''
                }`}
              />
            ))}
            <SettingsRow
              label="口径"
              hint={
                <>
                  输入按 <strong>未命中缓存</strong> 的部分计价，命中部分走「缓存读取」单价；
                  输出单独计价。两种以上币种<strong>不会相加</strong>——本项目没有汇率来源。
                  <br />
                  用量表只有 (provider, model) 两列，同一个上游模型被多个预设引用时按第一条结算，
                  因此这是一个<strong>估算</strong>，不承诺与账单逐条对齐。
                </>
              }
            />
          </>
        )}
      </SettingsCard>
    </Box>
  );
}

/** 单个指标：数字为主、标签为辅，避免一行里挤一堆等宽表格 */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ minWidth: 96 }}>
      <Typography sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.3 }}>{value}</Typography>
      <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.25 }}>{label}</Typography>
    </Box>
  );
}

/**
 * 每日柱状图。
 *
 * 用 flex 的 div 而不是图表库：这里只需要「每天一根柱子」这一个形状，
 * 引一个图表依赖（还要处理主题色、容器宽度、tooltip 定位）换来的只是圆角。
 * 高度按**窗口内峰值**归一，而不是全局峰值——否则 7 天窗口里所有柱子都被
 * 30 天前那一天压成一条线。
 */
function UsageBars({ days }: { days: ReadonlyArray<{ date: string; totalTokens: number }> }) {
  const theme = useTheme();
  const peak = days.reduce((max, d) => Math.max(max, d.totalTokens), 0);

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: CHART_HEIGHT }}>
        {days.map((day) => {
          const ratio = peak > 0 ? day.totalTokens / peak : 0;
          const height = day.totalTokens > 0 ? Math.max(MIN_BAR_HEIGHT, ratio * CHART_HEIGHT) : 0;
          return (
            <Box
              key={day.date}
              title={`${day.date} · ${formatTokens(day.totalTokens)} token`}
              sx={{
                flex: 1,
                minWidth: 2,
                height,
                bgcolor: theme.palette.primary.main,
                borderRadius: '2px 2px 0 0',
                opacity: day.totalTokens > 0 ? 0.85 : 0.25,
              }}
            />
          );
        })}
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1 }}>
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          {dateAxisLabel(days[0].date)}
        </Typography>
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          {dateAxisLabel(days[days.length - 1].date)}
        </Typography>
      </Box>
    </Box>
  );
}

/** 占窗口总量的百分比；总量为 0 时给破折号而不是 `0%`（那会被读成「占比为零」） */
function shareText(part: number, total: number): string {
  if (total <= 0) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

/**
 * 更新时间的展示。
 *
 * 只取到分钟：这是「数据新鲜度」而不是审计时间戳。解析失败时原样返回——
 * 宁可显示一个原始字符串，也不要显示 `Invalid Date`。
 */
function formatUpdatedAt(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
