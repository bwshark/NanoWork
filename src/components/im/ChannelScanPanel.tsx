import { useEffect, useRef, useState } from 'react';
import { Box, Button, CircularProgress, TextField, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RefreshIcon from '@mui/icons-material/Refresh';
import { QRCodeSVG } from 'qrcode.react';
import { getChannelMeta } from '@/lib/channel/channelMeta';
import { useChannelScan } from '@/lib/channel/channelScan';
import type { ChannelKind } from '@/types';

/**
 * IM 渠道扫码接入面板（深色 / 浅色自适应，沿用 MUI theme token）。
 * 布局参考设计稿：居中二维码（白底衬底保证扫码识别度）+ 底部描边「刷新二维码」
 * 按钮 + 「改用手动配置」文字链接。
 *
 * 二维码渲染策略：
 * - 微信的 `qr_url` 是二维码图片直链 → 先试 `<img src>`，onError 降级为
 *   `QRCodeSVG` 编码；
 * - 飞书 / Lark 的 `qr_url` 是待编码授权链接 → 直接 `QRCodeSVG` 编码。
 */

/** 白底衬底容器尺寸与二维码内容尺寸 */
const QR_CARD_SIZE = 216;
const QR_INNER_SIZE = 184;

interface ChannelScanPanelProps {
  kind: ChannelKind;
  /** 扫码成功（状态机进入 succeeded）时回调，父组件编排回读 + 重启时序 */
  onSucceeded: () => void;
  /** 切回手动配置模式 */
  onSwitchToManual: () => void;
  /** 刷新二维码开启新一轮扫码时回调（父组件据此重置成功时序幂等位） */
  onRestart?: () => void;
}

export function ChannelScanPanel({ kind, onSucceeded, onSwitchToManual, onRestart }: ChannelScanPanelProps) {
  const meta = getChannelMeta(kind);
  const { state, qrUrl, message, error, start, restart, submitVerifyCode } = useChannelScan(kind);
  const [verifyCode, setVerifyCode] = useState('');

  // 挂载即发起扫码会话（弹窗关闭 / 切模式导致的卸载由 hook 负责取消）
  useEffect(() => {
    start();
    // start 为控制器稳定引用，仅需挂载时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 成功态通知父组件（仅一次）：父组件负责回读凭证 + 重启网关 + 关闭弹窗
  const notifiedRef = useRef(false);
  useEffect(() => {
    if (state === 'succeeded' && !notifiedRef.current) {
      notifiedRef.current = true;
      onSucceeded();
    }
  }, [state, onSucceeded]);

  const starting = state === 'starting' || state === 'idle';
  const showQr = state === 'pending' || state === 'challenge' || state === 'failed' || state === 'expired';
  const dimmed = state === 'failed' || state === 'expired';

  const handleRefresh = () => {
    // 重置成功通知幂等位：刷新后第二次扫码成功时 onSucceeded 能再次触发；
    // 同时通知父组件重置其成功时序幂等位（否则回读 + 重启永不执行）
    notifiedRef.current = false;
    onRestart?.();
    // 微信失败后重登场景携带 force，普通刷新不传
    restart(kind === 'weixin' && state === 'failed' ? { force: true } : undefined);
    setVerifyCode('');
  };

  const handleSubmitCode = () => {
    if (verifyCode.trim()) submitVerifyCode(verifyCode);
  };

  /** 状态区文案 */
  const statusText = (() => {
    switch (state) {
      case 'idle':
      case 'starting':
        return '加载中…';
      case 'pending':
        return message ?? '等待扫码…';
      case 'challenge':
        return error ?? message ?? '请输入手机上收到的验证码';
      case 'succeeded':
        return '连接成功，正在应用配置…';
      case 'failed':
      case 'expired':
        return error ?? '二维码已失效';
      default:
        return '';
    }
  })();

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        pt: 0.5,
        pb: 1,
      }}
    >
      {/* 引导文案（来自渠道元数据） */}
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mb: 2, textAlign: 'center', lineHeight: 1.7 }}
      >
        {meta.scanConnect?.scanHint ?? '扫描下方二维码完成连接'}
      </Typography>

      {/* 二维码区：白底衬底（深色主题下保证扫码识别度） */}
      <Box
        sx={{
          width: QR_CARD_SIZE,
          height: QR_CARD_SIZE,
          borderRadius: 2,
          bgcolor: '#ffffff',
          display: 'grid',
          placeItems: 'center',
          position: 'relative',
          overflow: 'hidden',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        {starting && <CircularProgress size={28} />}
        {state === 'succeeded' && (
          <CheckCircleIcon sx={{ fontSize: 72, color: 'success.main' }} />
        )}
        {showQr && (
          <Box sx={{ opacity: dimmed ? 0.22 : 1, transition: 'opacity 0.2s' }}>
            <QrView kind={kind} qrUrl={qrUrl} />
          </Box>
        )}
        {dimmed && (
          <Typography
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              color: 'text.primary',
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            {state === 'expired' ? '二维码已过期' : '二维码已失效'}
          </Typography>
        )}
      </Box>

      {/* 状态 / 错误文案 */}
      <Typography
        variant="body2"
        color={state === 'failed' || state === 'expired' || (state === 'challenge' && !!error) ? 'error' : 'text.secondary'}
        sx={{
          mt: 1.5,
          minHeight: 20,
          textAlign: 'center',
          fontSize: 13,
          maxWidth: QR_CARD_SIZE + 48,
          lineHeight: 1.6,
        }}
      >
        {statusText}
      </Typography>

      {/* challenge：验证码输入（微信） */}
      {state === 'challenge' && (
        <Box sx={{ display: 'flex', gap: 1, mt: 1, width: QR_CARD_SIZE + 48 }}>
          <TextField
            size="small"
            fullWidth
            autoFocus
            placeholder="请输入验证码"
            value={verifyCode}
            onChange={(e) => setVerifyCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmitCode();
            }}
          />
          <Button
            variant="contained"
            onClick={handleSubmitCode}
            disabled={!verifyCode.trim()}
            sx={{ flexShrink: 0 }}
          >
            提交
          </Button>
        </Box>
      )}

      {/* 底部：刷新二维码（描边按钮） + 改用手动配置（文字链接） */}
      <Box sx={{ mt: 2.5, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
        <Button
          fullWidth
          variant="outlined"
          color="inherit"
          startIcon={<RefreshIcon fontSize="small" />}
          onClick={handleRefresh}
          disabled={starting}
          sx={{
            borderRadius: 2,
            py: 1,
            borderColor: 'divider',
            color: 'text.primary',
          }}
        >
          刷新二维码
        </Button>
        <Button
          size="small"
          onClick={onSwitchToManual}
          sx={{ color: 'text.secondary', fontSize: 12.5, mt: 0.5 }}
        >
          改用手动配置
        </Button>
      </Box>
    </Box>
  );
}

/**
 * 二维码内容渲染：
 * - weixin：qr_url 是图片直链，先试 <img>，加载失败降级为 QRCodeSVG 编码；
 * - 其余（飞书 / Lark）：qr_url 是授权链接，直接 QRCodeSVG 编码。
 */
function QrView({ kind, qrUrl }: { kind: ChannelKind; qrUrl?: string }) {
  const [imgFailed, setImgFailed] = useState(false);

  // 二维码内容变化（微信自动换码）时重置图片降级标记
  useEffect(() => {
    setImgFailed(false);
  }, [qrUrl]);

  if (!qrUrl) {
    return <Box sx={{ width: QR_INNER_SIZE, height: QR_INNER_SIZE }} />;
  }

  if (kind === 'weixin' && !imgFailed) {
    return (
      <img
        src={qrUrl}
        alt="扫码二维码"
        width={QR_INNER_SIZE}
        height={QR_INNER_SIZE}
        style={{ display: 'block', objectFit: 'contain' }}
        onError={() => setImgFailed(true)}
      />
    );
  }

  return (
    <QRCodeSVG
      value={qrUrl}
      size={QR_INNER_SIZE}
      fgColor="#000000"
      bgColor="#ffffff"
      level="M"
    />
  );
}
