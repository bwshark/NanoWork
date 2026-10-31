import { useEffect, useState } from 'react';
import { Box, Button, MenuItem, Switch, TextField } from '@mui/material';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { toast } from '@/components/Toast';
import { connectionManager } from '@/ai/connectionManager';
import { useModelsStore } from '@/stores/modelsStore';
import { DEFAULT_TRANSCRIPTION, useSettingsStore } from '@/stores/settingsStore';
import {
  TRANSCRIPTION_PROVIDERS,
  findTranscriptionProvider,
} from '@/lib/voice/providers';

/**
 * 连接：网关（OpenAI 兼容）凭据 + 语音输入（STT）。
 *
 * 原名「连接与模型」——模型那半边已拆成独立分区（设置 → 功能 → 模型），
 * 合在这里会让「改网关地址」和「加模型」两个高频操作互相挤占版面。
 *
 * 两块的改动都是**先落本地草稿、点保存才写回 store**。这不是为了省几次
 * localStorage 写入——网关地址每改一个字符都会触发连接探测，语音配置边打字边生效
 * 则会让下一轮转写用上半截配置。草稿态是这里唯一的正确形态。
 */
export function ConnectionSection() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);

  const [endpoint, setEndpoint] = useState(settings.gatewayEndpoint);
  const [token, setToken] = useState(settings.apiToken);
  const [transcription, setTranscription] = useState(
    settings.transcription ?? DEFAULT_TRANSCRIPTION,
  );

  useEffect(() => {
    setEndpoint(settings.gatewayEndpoint);
    setToken(settings.apiToken);
  }, [settings.gatewayEndpoint, settings.apiToken]);

  useEffect(() => {
    setTranscription(settings.transcription ?? DEFAULT_TRANSCRIPTION);
  }, [settings.transcription]);

  const saveGateway = async () => {
    setSettings({ gatewayEndpoint: endpoint, apiToken: token });
    toast.success('连接配置已保存');
    await connectionManager.probe().catch(() => undefined);
    // 网关变更后强制重拉模型目录
    void useModelsStore.getState().refresh(true);
  };

  const saveTranscription = () => {
    // 关闭时不必校验；开启时缺模型或（公网服务商）缺 Key 都会让每次转写失败，
    // 提前兜底比让用户录一段再看到 401 便宜得多
    if (transcription.enabled) {
      if (transcription.model.trim() === '') {
        toast.error('请先填写转录模型');
        return;
      }
      const spec = findTranscriptionProvider(transcription.provider);
      if (spec?.needsKey && transcription.apiToken.trim() === '') {
        toast.error(`「${spec.label}」需要填写 API Key`);
        return;
      }
      if (!spec?.apiBase && transcription.endpoint.trim() === '') {
        toast.error('该服务商无默认地址，请填写 Endpoint');
        return;
      }
    }
    setSettings({ transcription });
    toast.success('语音输入设置已保存');
  };

  const spec =
    findTranscriptionProvider(transcription.provider) ??
    TRANSCRIPTION_PROVIDERS[TRANSCRIPTION_PROVIDERS.length - 1];

  return (
    <Box>
      <SettingsCard
        title="网关连接"
        description="nanoWork 通过 OpenAI 兼容接口访问 nanobot 网关；地址或令牌变更后会自动重新探测连接并重拉模型目录。"
      >
        <SettingsRow layout="stack" label="网关 Endpoint">
          <TextField
            fullWidth
            size="small"
            placeholder="http://127.0.0.1:8900/v1"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </SettingsRow>
        <SettingsRow layout="stack" label="API Token / Key">
          <TextField
            fullWidth
            size="small"
            type="password"
            placeholder="留空表示网关未启用鉴权"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </SettingsRow>
        <Box sx={{ px: 2, py: 1.75 }}>
          <Button variant="contained" onClick={() => void saveGateway()}>
            保存连接配置
          </Button>
        </Box>
      </SettingsCard>

      <SettingsCard
        title="语音输入"
        description="客户端直连转录服务商（不走 nanobot 网关：引擎的 /v1 没有 /audio/transcriptions 路由，语音转录在引擎侧只服务 channel 消息）。选一个服务商、填上它的 API Key 即可。未启用时麦克风按钮不会申请麦克风权限。"
      >
        <SettingsRow
          label="启用语音输入"
          hint="关闭后麦克风按钮只提示去设置，不申请麦克风权限"
          control={
            <Switch
              checked={transcription.enabled}
              onChange={(e) =>
                setTranscription({ ...transcription, enabled: e.target.checked })
              }
            />
          }
        />
        <SettingsRow
          layout="stack"
          label="转录服务商"
          hint="切换服务商会自动带出它的默认模型；自定义网关请选最后一项"
        >
          <TextField
            select
            fullWidth
            size="small"
            value={transcription.provider}
            onChange={(e) => {
              const next = findTranscriptionProvider(e.target.value);
              setTranscription({
                ...transcription,
                provider: e.target.value,
                // 换 provider 时同步换模型：留着上一家的模型名会让新服务商 400
                model: next?.model ?? transcription.model,
              });
            }}
          >
            {TRANSCRIPTION_PROVIDERS.map((p) => (
              <MenuItem key={p.name} value={p.name} sx={{ fontSize: 13 }}>
                {p.label}
              </MenuItem>
            ))}
          </TextField>
        </SettingsRow>
        <SettingsRow
          layout="stack"
          label="转录服务 Endpoint"
          hint={
            spec.apiBase
              ? `留空使用默认地址：${spec.apiBase}`
              : "该服务商无默认地址，必须填写（如 http://127.0.0.1:8000/v1）"
          }
        >
          <TextField
            fullWidth
            size="small"
            placeholder={spec.apiBase || "http://127.0.0.1:8000/v1"}
            value={transcription.endpoint}
            onChange={(e) =>
              setTranscription({ ...transcription, endpoint: e.target.value })
            }
          />
        </SettingsRow>
        <SettingsRow layout="stack" label="转录模型">
          <TextField
            fullWidth
            size="small"
            placeholder={spec.model}
            value={transcription.model}
            onChange={(e) =>
              setTranscription({ ...transcription, model: e.target.value })
            }
          />
        </SettingsRow>
        <SettingsRow
          layout="stack"
          label="转录服务 API Key"
          hint={
            spec.needsKey
              ? "该服务商在公网，必须填写自己的 Key"
              : "自建网关若未启用鉴权可留空"
          }
        >
          <TextField
            fullWidth
            size="small"
            type="password"
            value={transcription.apiToken}
            onChange={(e) =>
              setTranscription({ ...transcription, apiToken: e.target.value })
            }
          />
        </SettingsRow>
        <SettingsRow
          layout="stack"
          label="语言提示"
          hint="ISO-639-1，如 zh；留空由服务端自动检测"
        >
          <TextField
            fullWidth
            size="small"
            value={transcription.language}
            onChange={(e) =>
              setTranscription({ ...transcription, language: e.target.value })
            }
          />
        </SettingsRow>
        <Box sx={{ px: 2, py: 1.75 }}>
          <Button variant="contained" onClick={saveTranscription}>
            保存语音设置
          </Button>
        </Box>
      </SettingsCard>
    </Box>
  );
}
