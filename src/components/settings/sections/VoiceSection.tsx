import { useEffect, useRef, useState } from 'react';
import { Box, Button, MenuItem, Switch, TextField, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { toast } from '@/components/Toast';
import { canUseRealtime } from '@/hooks/useVoiceInput';
import { DEFAULT_TRANSCRIPTION, useSettingsStore } from '@/stores/settingsStore';
import {
  TRANSCRIPTION_PROVIDERS,
  findTranscriptionProvider,
} from '@/lib/voice/providers';
import { createSpeaker, systemSpeechAvailable, type Speaker } from '@/lib/voice/speaker';
import {
  DEFAULT_TTS,
  resolveTtsConfig,
  resolveTtsEndpoint,
} from '@/lib/voice/tts';
import type { TtsConfig } from '@/types';

/**
 * 语音：**听进去**（STT，说话转文字）与**念出来**（TTS，文字转语音）的配置。
 *
 * ## 为什么独立成一个分区
 * 之前「语音输入」塞在「连接」里，而合成（TTS）**根本没有界面**——`settings.tts`
 * 这个字段存在、`resolveTtsConfig` 也在读它，但用户只能在配置文件里手写，
 * 结果就是语音讨论一直播报系统语音，还以为是功能没做。
 *
 * 两者合在一处还有个实际理由：它们共用同一个服务商凭据（同一个百炼工作区的 key
 * 两边通用），拆在两个分区最难自证「现在到底在用哪个 key」。
 *
 * ## 为什么全部先落草稿、点保存才写回
 * 语音配置边打字边生效会让下一轮转写/合成用上半截配置（endpoint 改了、key 还没改，
 * 直接 401）。草稿态是这里唯一的正确形态。
 */
export function VoiceSection() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);

  const [transcription, setTranscription] = useState(
    settings.transcription ?? DEFAULT_TRANSCRIPTION,
  );
  /**
   * 合成的初始值要**把「继承」算进来**。
   *
   * `resolveTtsConfig` 在 `tts` 整段缺失时会跟随语音输入（转录开着就意味着
   * 这台机器上有可用的工作区与凭据）。若这里直接拿 `DEFAULT_TTS`（`enabled: false`）
   * 当草稿，用户只是点了一下「保存」就会把继承来的开启态固化成关闭——
   * 语音讨论突然变哑巴，而他什么都没改。
   */
  const initialTts = (): TtsConfig =>
    settings.tts ?? { ...DEFAULT_TTS, enabled: settings.transcription?.enabled === true };

  const [tts, setTts] = useState<TtsConfig>(initialTts);
  const [previewing, setPreviewing] = useState(false);
  const speakerRef = useRef<Speaker | null>(null);

  useEffect(() => {
    setTranscription(settings.transcription ?? DEFAULT_TRANSCRIPTION);
  }, [settings.transcription]);

  useEffect(() => {
    setTts(settings.tts ?? { ...DEFAULT_TTS, enabled: settings.transcription?.enabled === true });
  }, [settings.tts, settings.transcription?.enabled]);

  // 面板卸载时停掉试听：不然切走分区还在念
  useEffect(
    () => () => {
      speakerRef.current?.stop();
      speakerRef.current = null;
    },
    [],
  );

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

  const saveTts = () => {
    if (tts.enabled) {
      if (tts.model.trim() === '') {
        toast.error('请先填写合成模型');
        return;
      }
      // 「留空沿用语音输入的 Key」是真实回退路径（见 resolveTtsConfig），
      // 所以校验要看解析后的结果，而不是只看 tts.apiToken
      const resolved = resolveTtsConfig({ tts, transcription });
      if (resolved.apiToken === '') {
        toast.error('合成需要 API Key：可以单独填，也可以启用上面的语音输入来沿用它的 Key');
        return;
      }
    }
    setSettings({ tts });
    toast.success('语音合成设置已保存');
  };

  /**
   * 试听：用**草稿配置**（不必先保存）。
   *
   * 这条链路和语音讨论里完全一致（`createSpeaker` 会自己处理云端失败降级），
   * 所以试听听得见，讨论里就一定念得出来——这是本页最有用的一次性验证。
   */
  const preview = async () => {
    if (previewing) {
      speakerRef.current?.stop();
      setPreviewing(false);
      return;
    }
    const cfg = resolveTtsConfig({ tts, transcription });
    if (!cfg.ready && !systemSpeechAvailable()) {
      toast.error(
        cfg.enabled
          ? '合成服务未就绪：检查 Endpoint 与 API Key'
          : '未启用云端合成，且当前环境没有系统语音可用',
      );
      return;
    }
    setPreviewing(true);
    const speaker = createSpeaker(cfg);
    speakerRef.current = speaker;
    await speaker.speak('你好，这是语音合成的试听。', {
      onNotice: (message) => toast.warning(`云端合成失败，已改用系统语音：${message}`),
    });
    // 被 stop() 打断时 speak 也会 resolve，这里统一复位（避免按钮卡在「停止」）
    if (speakerRef.current === speaker) {
      speakerRef.current = null;
      setPreviewing(false);
    }
  };

  const spec =
    findTranscriptionProvider(transcription.provider) ??
    TRANSCRIPTION_PROVIDERS[TRANSCRIPTION_PROVIDERS.length - 1];

  /**
   * 模型与服务商的兼容性提示（**保存前**给出，不等失败）。
   *
   * 两条都来自实测：
   * - 百炼的 `qwen-audio-*` 系列在 chat 形态下只接受公网 URL，传 base64 会回
   *   `400 url error, please check url` —— 该文案完全指不出真因；
   * - 名字带 `-streaming` / `-realtime` 的是实时流式模型，需要 WebSocket 会话，
   *   不能用于「录一段再识别」。
   */
  const modelWarning = (() => {
    const model = transcription.model.trim();
    if (!model) return '';
    if (spec.protocol === 'dashscope-chat') {
      if (model.startsWith('qwen-audio') || /-(streaming|realtime)/.test(model)) {
        return `「${model}」不能用于语音输入：它要么只接受公网音频 URL，要么是实时流式模型（需 WebSocket 会话）。请改用 qwen3-asr-flash。`;
      }
      return '';
    }
    if (/(streaming|realtime)/.test(model) && spec.protocol === 'openai-multipart') {
      return `「${model}」看起来是实时流式模型，OpenAI 兼容的 /audio/transcriptions 用不了它。请换成非流式模型（如 whisper-1 / whisper-large-v3）。`;
    }
    return '';
  })();

  /**
   * 语音讨论（实时对话）的门槛比点按录音高一层：必须是 `dashscope` 服务商 +
   * 名字带 `realtime` 的模型（见 `canUseRealtime`）。配错了不会有报错，
   * 只是讨论按钮永远是灰的——所以在设置页直接说清楚。
   */
  const realtimeOk =
    transcription.enabled && canUseRealtime(transcription.provider, transcription.model);

  const ttsUrl = resolveTtsEndpoint(tts.endpoint);

  return (
    <Box>
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
              : '该服务商无默认地址，必须填写（如 http://127.0.0.1:8000/v1）'
          }
        >
          <TextField
            fullWidth
            size="small"
            placeholder={spec.apiBase || 'http://127.0.0.1:8000/v1'}
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
              ? '该服务商在公网，必须填写自己的 Key'
              : '自建网关若未启用鉴权可留空'
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

        {/* 模型兼容性提示：**保存前就告诉他这个组合不行**。
            实测踩过：按百炼文档填了 qwen-audio-3.1-asr-flash-streaming，
            结果录音正常、一停就失败，报错是 400「url error」——
            那句文案完全指不出「该模型只吃公网 URL」。
            在设置页拦住比让用户录一段再失败便宜得多。 */}
        {modelWarning && (
          <Box sx={{ px: 0, pb: 1 }}>
            <Typography sx={{ fontSize: 12, color: 'warning.main', lineHeight: 1.6 }}>
              {modelWarning}
            </Typography>
          </Box>
        )}
        {!realtimeOk && (
          <Box sx={{ pb: 1 }}>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.7 }}>
              语音讨论（实时对话，麦克风全程开、边说边出字）另需一个实时模型：
              服务商选「阿里云百炼」且模型名带 realtime，如
              qwen-audio-3.1-realtime-flash。其余模型只支持点按录音。
            </Typography>
          </Box>
        )}

        <Box sx={{ py: 1.75 }}>
          <Button variant="contained" onClick={saveTranscription}>
            保存语音输入
          </Button>
        </Box>
      </SettingsCard>

      <SettingsCard
        title="语音合成"
        description="把助手的回复念出来（语音讨论的播报）。同样是客户端直连服务商，不走网关。关闭后讨论只显示字幕；开启后云端失败会自动退回系统语音（若下面允许）。"
      >
        <SettingsRow
          label="启用云端合成"
          hint="关闭则直接用系统语音；系统语音没有经过降噪与音色调校，机械感明显"
          control={
            <Switch
              checked={tts.enabled}
              onChange={(e) => setTts({ ...tts, enabled: e.target.checked })}
            />
          }
        />
        <SettingsRow
          layout="stack"
          label="合成服务 Endpoint"
          hint={
            tts.endpoint.trim() === ''
              ? `留空沿用语音输入的地址与 Key。实际请求：${ttsUrl}`
              : `实际请求：${ttsUrl}（只取域名，路径固定为合成路由）`
          }
        >
          <TextField
            fullWidth
            size="small"
            placeholder="留空 = 沿用语音输入（推荐）"
            value={tts.endpoint}
            onChange={(e) => setTts({ ...tts, endpoint: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow layout="stack" label="合成模型" hint="百炼非流式合成模型，如 qwen3-tts-flash">
          <TextField
            fullWidth
            size="small"
            value={tts.model}
            onChange={(e) => setTts({ ...tts, model: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow
          layout="stack"
          label="音色"
          hint="如 Cherry（女声）、Ethan（男声）；完整清单见服务商控制台"
        >
          <TextField
            fullWidth
            size="small"
            value={tts.voice}
            onChange={(e) => setTts({ ...tts, voice: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow
          layout="stack"
          label="合成服务 API Key"
          hint="留空沿用语音输入的 Key（同一个工作区的 Key 两边通用）"
        >
          <TextField
            fullWidth
            size="small"
            type="password"
            value={tts.apiToken}
            onChange={(e) => setTts({ ...tts, apiToken: e.target.value })}
          />
        </SettingsRow>
        <SettingsRow
          label="失败时退回系统语音"
          hint="关闭后云端合成失败就是纯文字（不静默、不卡住）"
          control={
            <Switch
              checked={tts.fallbackToSystem !== false}
              onChange={(e) => setTts({ ...tts, fallbackToSystem: e.target.checked })}
            />
          }
        />

        <Box sx={{ py: 1.75, display: 'flex', gap: 1.5, alignItems: 'center' }}>
          <Button variant="contained" onClick={saveTts}>
            保存语音合成
          </Button>
          {/* 试听走的就是讨论里那条链路（含云端失败自动降级），
              所以这里听得见，讨论里就一定念得出来 */}
          <Button
            variant="outlined"
            onClick={() => void preview()}
            startIcon={previewing ? <StopIcon /> : <PlayArrowIcon />}
          >
            {previewing ? '停止试听' : '试听（用当前草稿）'}
          </Button>
        </Box>
      </SettingsCard>
    </Box>
  );
}
