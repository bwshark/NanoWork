import { useEffect, useState } from 'react';
import { Box, Button, TextField } from '@mui/material';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { toast } from '@/components/Toast';
import { connectionManager } from '@/ai/connectionManager';
import { useModelsStore } from '@/stores/modelsStore';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * 连接：网关（OpenAI 兼容）凭据。
 *
 * 这个分区只管**本机网关**。语音（STT / TTS）已整体搬到「功能 → 语音」：
 * 那是直连第三方服务商的另一套凭据，和「改网关地址」放在一起时两者互相挤版面，
 * 且合成配置根本没地方放（见 `VoiceSection` 的文件头）。
 *
 * 网关的改动是**先落本地草稿、点保存才写回 store**。不是为省几次 localStorage
 * 写入——网关地址每改一个字符都会触发连接探测，草稿态是这里唯一的正确形态。
 */
export function ConnectionSection() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);

  const [endpoint, setEndpoint] = useState(settings.gatewayEndpoint);
  const [token, setToken] = useState(settings.apiToken);

  useEffect(() => {
    setEndpoint(settings.gatewayEndpoint);
    setToken(settings.apiToken);
  }, [settings.gatewayEndpoint, settings.apiToken]);

  const saveGateway = async () => {
    setSettings({ gatewayEndpoint: endpoint, apiToken: token });
    toast.success('连接配置已保存');
    await connectionManager.probe().catch(() => undefined);
    // 网关变更后强制重拉模型目录
    void useModelsStore.getState().refresh(true);
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
        <Box sx={{ py: 1.75 }}>
          <Button variant="contained" onClick={() => void saveGateway()}>
            保存连接配置
          </Button>
        </Box>
      </SettingsCard>
    </Box>
  );
}
