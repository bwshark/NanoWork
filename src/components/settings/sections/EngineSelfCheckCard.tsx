import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Chip, CircularProgress, Typography } from '@mui/material';
import { SettingsCard } from '@/components/settings/SettingsPrimitives';
import { toast } from '@/components/Toast';
import { platform } from '@/platform';
import type {
  EngineSelfCheckFinding,
  EngineSelfCheckReport,
  EngineSelfCheckStatus,
} from '@/types/engine';

/**
 * 引擎自检卡片（FR-13.6）。
 *
 * ## 这个界面要解决的是什么
 *
 * 引擎起不来时，用户此前只能看到「网关离线」。这一屏把原因拆成**三项**并逐项给出
 * 「是什么问题 / 怎么修 / 复制即用的命令」—— 注意是**三项分别显示**，不是一句
 * 「引擎启动失败」：三项的修法完全不同（建 venv / 装依赖 / 改配置），糊成一句
 * 等于把黑盒换了个地方摆。
 *
 * ## 三条约束
 *
 * 1. **不阻塞**：报告来自主进程缓存（窗口显示后异步跑），这里只是取一次；打开设置
 *    立刻有内容，不会因为自检要起子进程而转圈几秒。首次可能恰好在跑 → 显示一行
 *    「正在检查」，此时按钮禁用。
 * 2. **Web 端显示「不适用」**：`platform.engineSelfCheck()` 在 Web 返回 `null`
 *    （那是「没有本地引擎这回事」，不是「检查失败」）。把它显示成三条红会让 Web
 *    用户以为坏了。
 * 3. **报错原文照抄**：`detail` 直接进等宽块，不做翻译、不截成一句话。用户拿着它
 *    去搜 / 贴给别人时，被「美化」过的报错是最没用的东西。
 */
const STATUS_META: Record<EngineSelfCheckStatus, { label: string; color: 'success' | 'error' | 'default' }> = {
  ok: { label: '通过', color: 'success' },
  failed: { label: '需处理', color: 'error' },
  skipped: { label: '未判定', color: 'default' },
};

/** 等宽块：命令与报错原文都用它（可横向滚，不折行改语义） */
const MONO_SX = {
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: 12,
  p: 1,
  borderRadius: 1,
  bgcolor: 'action.hover',
  overflowX: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
} as const;

function FindingBlock({ finding }: { finding: EngineSelfCheckFinding }) {
  const meta = STATUS_META[finding.status];
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制${what}`);
    } catch {
      toast.error('复制失败，请手动选择文本');
    }
  };

  return (
    <Box sx={{ mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 500 }}>{finding.title}</Typography>
        <Chip size="small" label={meta.label} color={meta.color} variant="outlined" />
      </Box>
      <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{finding.summary}</Typography>

      {finding.detail ? (
        <Typography component="pre" sx={{ ...MONO_SX, mt: 1 }}>
          {finding.detail}
        </Typography>
      ) : null}

      {finding.remedy ? (
        <Box sx={{ mt: 1 }}>
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 0.5 }}>怎么修</Typography>
          {/* 有序列表：步骤有先后（先建 venv 再装依赖），用圆点会丢掉这个信息 */}
          <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
            {finding.remedy.steps.map((step) => (
              <Box component="li" key={step} sx={{ fontSize: 12, color: 'text.secondary' }}>
                {step}
              </Box>
            ))}
          </Box>
          {finding.remedy.commands.map((command) => (
            <Box key={command} sx={{ mt: 0.5 }}>
              <Typography component="pre" sx={MONO_SX}>
                {command}
              </Typography>
              <Button size="small" onClick={() => void copy(command, '命令')}>
                复制命令
              </Button>
            </Box>
          ))}
          {finding.remedy.docPath ? (
            <Box sx={{ mt: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                文档：{finding.remedy.docPath}
              </Typography>
              <Button size="small" onClick={() => void copy(finding.remedy?.docPath ?? '', '文档路径')}>
                复制路径
              </Button>
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

export function EngineSelfCheckCard() {
  const [report, setReport] = useState<EngineSelfCheckReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applies, setApplies] = useState(true);

  const run = useCallback((refresh: boolean) => {
    setLoading(true);
    setError(null);
    void platform
      .engineSelfCheck(refresh)
      .then((next) => {
        setReport(next);
        setApplies(next !== null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    run(false);
  }, [run]);

  const action = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      {loading ? <CircularProgress size={14} /> : null}
      {/* 首次取缓存时可能在跑，此时禁用：连点只会排队等同一份结果 */}
      <Button size="small" disabled={loading} onClick={() => run(true)}>
        重新自检
      </Button>
    </Box>
  );

  return (
    <SettingsCard
      title="引擎自检"
      description="三项各查一件事：解释器能不能跑、引擎包能不能导入、配置文件过不过引擎的校验。三项的修法不同，所以分开列。"
      action={action}
    >
      {error ? (
        <Typography sx={{ fontSize: 12, color: 'error.main' }}>自检失败：{error}</Typography>
      ) : !applies ? (
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          Web 端不适用：没有本地引擎，模型经由你配置的网关访问。
        </Typography>
      ) : report === null ? (
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>正在检查…</Typography>
      ) : (
        <>
          {report.findings.map((finding) => (
            <FindingBlock key={finding.id} finding={finding} />
          ))}
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
            {report.ok ? '三项均无问题。' : '有项目需要处理，按上面的步骤操作后点「重新自检」。'}
            {' 检查时间：'}
            {report.checkedAt.slice(0, 19).replace('T', ' ')}
            {` · 解释器：${report.target.bin}`}
          </Typography>
        </>
      )}
    </SettingsCard>
  );
}
