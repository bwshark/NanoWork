import { useEffect, useState } from 'react';
import { Box, Button, Switch, TextField } from '@mui/material';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { toast } from '@/components/Toast';
import { connectionManager } from '@/ai/connectionManager';
import { useModelsStore } from '@/stores/modelsStore';
import { DEFAULT_TRANSCRIPTION, useSettingsStore } from '@/stores/settingsStore';

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
    // 关闭时不必校验模型；开启时模型为空会让每次转写都失败，提前兜底
    if (transcription.enabled && transcription.model.trim() === '') {
      toast.error('请先填写转录模型');
      return;
    }
    setSettings({ transcription });
    toast.success('语音输入设置已保存');
  };

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
        description="走 OpenAI 兼容的 /audio/transcriptions 接口。Endpoint 与 API Key 留空时复用上方网关配置；未启用时输入框的语音按钮保持禁用，不会申请麦克风权限。"
      >
        <SettingsRow
          label="启用语音输入"
          hint="关闭后输入框的麦克风按钮不可点，也不会申请麦克风权限"
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
          label="转录服务 Endpoint"
          hint={`留空则复用网关地址（${settings.gatewayEndpoint}）`}
        >
          <TextField
            fullWidth
            size="small"
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
            placeholder="whisper-1"
            value={transcription.model}
            onChange={(e) =>
              setTranscription({ ...transcription, model: e.target.value })
            }
          />
        </SettingsRow>
        <SettingsRow layout="stack" label="转录服务 API Key" hint="留空则复用网关 API Key">
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
