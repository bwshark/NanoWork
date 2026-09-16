import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  FormControlLabel,
  Paper,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { ROUTES } from '@/lib/constants';
import { HotkeyInput } from '@/components/HotkeyInput';
import { PromptProfileFields } from '@/components/prompts/PromptProfileFields';
import {
  DEFAULT_PROMPT_DOMAIN,
  DEFAULT_PROMPT_STYLE,
} from '@/lib/promptCatalog';
import type { DesktopConfig, Settings } from '@/types';
import {
  DEFAULT_DESKTOP,
  DEFAULT_TRANSCRIPTION,
  normalizeTheme,
  useSettingsStore,
} from '@/stores/settingsStore';
import { useModelsStore } from '@/stores/modelsStore';
import { connectionManager } from '@/ai/connectionManager';
import { platform } from '@/platform';
import { toast } from '@/components/Toast';

/**
 * 桌面端专有设置：系统托盘 / 全局快捷键 / 开机自启。
 * 仅在 Electron 环境渲染（Web 端无托盘与全局快捷键能力，整块隐藏）。
 *
 * 状态同步要点：渲染层 store 保存的是"用户期望值"，主进程保存的是"实际生效值"。
 * 两者可能不一致（例如快捷键被系统占用注册失败），因此挂载时以主进程回读为准，
 * 每次修改后也用主进程返回值覆盖本地，避免出现"UI 显示已生效、实际没生效"的假象。
 */
function DesktopSection() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const isMac = window.electronAPI?.getPlatform() === 'darwin';

  const [desktop, setDesktop] = useState<DesktopConfig>(
    settings.desktop ?? DEFAULT_DESKTOP,
  );
  const [hotkeyError, setHotkeyError] = useState('');

  /** 本地状态与 store 同步写入，保证刷新后仍是同一份配置 */
  const commit = useCallback(
    (next: DesktopConfig) => {
      setDesktop(next);
      setSettings({ desktop: next });
    },
    [setSettings],
  );

  // 挂载时以主进程实际状态为准：开机自启可能被用户在系统设置里改过，
  // 快捷键也可能因被占用而没注册上
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    let alive = true;
    void api
      .appGetDesktopConfig()
      .then((cfg) => {
        if (alive) commit(cfg);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [commit]);

  // 托盘菜单里改了开关 → 同步回 UI。
  // 只更新视图与持久化，绝不回写主进程，否则形成"主进程→渲染层→主进程"回环
  useEffect(() => {
    if (!window.electronAPI) return;
    return window.electronAPI.onDesktopConfigChange(commit);
  }, [commit]);

  /** 应用补丁：本地先更新保证即时反馈，再让主进程生效并回读实际值 */
  const apply = async (patch: Partial<DesktopConfig>) => {
    commit({ ...desktop, ...patch });

    const res = await window.electronAPI
      ?.appSetDesktopConfig(patch)
      .catch(() => undefined);
    if (!res) return;
    if (res.ok) {
      setHotkeyError('');
      return;
    }
    // 快捷键注册失败（被系统或其它应用占用）：提示并回退到主进程实际生效值
    setHotkeyError(res.error ?? '快捷键设置失败');
    toast.error(res.error ?? '快捷键设置失败');
    commit(res.config);
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'background.paper' }}>
      <Typography fontWeight={600} gutterBottom>
        桌面端
      </Typography>
      <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 1 }}>
        关闭窗口后应用会常驻系统托盘，像微信/钉钉一样在后台运行；需要结束时请从托盘图标右键菜单选择「退出」。
      </Typography>

      <FormControlLabel
        control={
          <Switch
            checked={desktop.closeToTray}
            onChange={(e) => void apply({ closeToTray: e.target.checked })}
          />
        }
        label="关闭窗口时最小化到托盘（不退出）"
      />
      <FormControlLabel
        control={
          <Switch
            checked={desktop.openAtLogin}
            onChange={(e) => void apply({ openAtLogin: e.target.checked })}
          />
        }
        label="开机自动启动"
      />
      {isMac && (
        <FormControlLabel
          control={
            <Switch
              checked={desktop.showInDock}
              onChange={(e) => void apply({ showInDock: e.target.checked })}
            />
          }
          label="在 Dock 中显示图标"
        />
      )}

      <Box sx={{ mt: 1.5 }}>
        <HotkeyInput
          value={desktop.hotkey}
          onChange={(accelerator) => void apply({ hotkey: accelerator })}
          error={hotkeyError}
        />
      </Box>
    </Paper>
  );
}

/** 设置页（FR-006）：网关配置 + 连接模式 + 数据管理 */
export function SettingsPage() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);

  const [endpoint, setEndpoint] = useState(settings.gatewayEndpoint);
  const [token, setToken] = useState(settings.apiToken);

  /** 语音转录配置的本地草稿（点保存才写回 store，避免一边打字一边持久化） */
  const [transcription, setTranscription] = useState(
    settings.transcription ?? DEFAULT_TRANSCRIPTION,
  );

  /**
   * 提示词档案的本地草稿（工作领域 / 语气风格 / 用户自定义指令）。
   *
   * 与转录配置同一套路：**改动先落本地草稿，点保存才写回 store**。
   * 理由不只是「少写几次 localStorage」——`userCustomPrompt` 是每轮都要注入
   * 上下文的正文，边打字边持久化会让半句话在下一轮就生效。
   */
  const [promptProfile, setPromptProfile] = useState({
    domain: settings.promptDomain ?? DEFAULT_PROMPT_DOMAIN,
    style: settings.promptStyle ?? DEFAULT_PROMPT_STYLE,
    userCustomPrompt: settings.userCustomPrompt ?? '',
  });

  useEffect(() => {
    setEndpoint(settings.gatewayEndpoint);
    setToken(settings.apiToken);
  }, [settings.gatewayEndpoint, settings.apiToken]);

  useEffect(() => {
    setTranscription(settings.transcription ?? DEFAULT_TRANSCRIPTION);
  }, [settings.transcription]);

  useEffect(() => {
    setPromptProfile({
      domain: settings.promptDomain ?? DEFAULT_PROMPT_DOMAIN,
      style: settings.promptStyle ?? DEFAULT_PROMPT_STYLE,
      userCustomPrompt: settings.userCustomPrompt ?? '',
    });
  }, [settings.promptDomain, settings.promptStyle, settings.userCustomPrompt]);

  const save = async () => {
    setSettings({ gatewayEndpoint: endpoint, apiToken: token });
    toast.success('设置已保存');
    await connectionManager.probe().catch(() => undefined);
    // 网关变更后强制重拉模型目录
    void useModelsStore.getState().refresh(true);
  };

  const clearData = async () => {
    await platform.storage.clear();
    toast.success('本地数据已清空，即将刷新');
    setTimeout(() => window.location.reload(), 600);
  };

  return (
    <Box sx={{ p: 3, maxWidth: 760, margin: '0 auto' }}>
      <Typography variant="h5" fontWeight={700} gutterBottom>
        设置
      </Typography>

      <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'background.paper' }}>
        <Typography fontWeight={600} gutterBottom>
          网关配置
        </Typography>
        <TextField
          fullWidth
          margin="dense"
          label="网关 Endpoint（OpenAI 兼容）"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
        />
        <TextField
          fullWidth
          margin="dense"
          label="API Token / Key"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Box sx={{ mt: 1 }}>
          <Button variant="contained" onClick={save}>
            保存连接配置
          </Button>
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'background.paper' }}>
        <Typography fontWeight={600} gutterBottom>
          外观
        </Typography>
        <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 1 }}>
          选择界面配色模式，「跟随系统」会随操作系统外观自动切换。
        </Typography>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={normalizeTheme(settings.theme)}
          onChange={(_e, value: Settings['theme'] | null) => {
            if (value) setSettings({ theme: value });
          }}
          aria-label="外观主题"
        >
          <ToggleButton value="light">浅色</ToggleButton>
          <ToggleButton value="dark">深色</ToggleButton>
          <ToggleButton value="system">跟随系统</ToggleButton>
        </ToggleButtonGroup>
      </Paper>

      {/* 桌面端专有：托盘 / 全局快捷键 / 开机自启；Web 端整块隐藏 */}
      {platform.env === 'electron' && <DesktopSection />}

      <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'background.paper' }}>
        <Typography fontWeight={600} gutterBottom>
          记忆
        </Typography>
        <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 1 }}>
          长期记忆分两层：工作区级（按工作目录隔离，会话的决策与待办落这里）与用户级
          （跨项目生效，你的称呼 / 职业 / 稳定偏好落这里）。开启注入后，会话创建时读取一次并在
          system 提示末尾以标签块注入。
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={settings.memoryEnabled}
              onChange={(e) => setSettings({ memoryEnabled: e.target.checked })}
            />
          }
          label="注入记忆到会话（推荐开启）"
        />
        <FormControlLabel
          control={
            <Switch
              checked={settings.autoSummarize}
              onChange={(e) => setSettings({ autoSummarize: e.target.checked })}
            />
          }
          label="会话结束自动沉淀摘要（关闭则新会话不会记得你是谁）"
        />
        <Box sx={{ mt: 1 }}>
          <Button component={RouterLink} to={ROUTES.memory} variant="outlined">
            打开记忆页
          </Button>
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'background.paper' }}>
        <Typography fontWeight={600} gutterBottom>
          提示词档案
        </Typography>
        <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 1 }}>
          这里选的是「全局默认」；单个专家可在其编辑弹窗里单独覆盖。执行模式
          （问答 / 规划 / 执行）由会话当前模式决定，不在此设置。
        </Typography>

        <PromptProfileFields
          domain={promptProfile.domain}
          style={promptProfile.style}
          allowInherit={false}
          onDomainChange={(v) =>
            setPromptProfile((p) => ({ ...p, domain: v ?? DEFAULT_PROMPT_DOMAIN }))
          }
          onStyleChange={(v) =>
            setPromptProfile((p) => ({ ...p, style: v ?? DEFAULT_PROMPT_STYLE }))
          }
        />

        <TextField
          fullWidth
          margin="dense"
          multiline
          minRows={3}
          maxRows={10}
          label="用户自定义指令（可选）"
          placeholder="写给 Agent 的额外要求，例如「引用文件时给出路径与行号」。每轮注入，保持简短。"
          value={promptProfile.userCustomPrompt}
          onChange={(e) =>
            setPromptProfile((p) => ({ ...p, userCustomPrompt: e.target.value }))
          }
          sx={{ mt: 1.5 }}
        />
        <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
          这段正文会以标签块追加在身份文件之后、记忆之前，不覆盖 Agent 自身的系统提示词。
          留空即关闭。
        </Typography>

        <Box sx={{ mt: 1.5, display: 'flex', gap: 1 }}>
          <Button
            variant="contained"
            onClick={() => {
              setSettings({
                promptDomain: promptProfile.domain,
                promptStyle: promptProfile.style,
                userCustomPrompt: promptProfile.userCustomPrompt,
              });
              toast.success('提示词档案已保存');
            }}
          >
            保存提示词档案
          </Button>
          <Button component={RouterLink} to={ROUTES.persona} variant="outlined">
            打开人格页（编辑模板正文）
          </Button>
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'background.paper' }}>
        <Typography fontWeight={600} gutterBottom>
          语音输入
        </Typography>
        <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 1 }}>
          走 OpenAI 兼容的 <code>/audio/transcriptions</code> 接口。
          Endpoint 与 API Key 留空时复用上方网关配置。未启用时输入框的语音按钮保持禁用，
          不会申请麦克风权限。
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={transcription.enabled}
              onChange={(e) =>
                setTranscription({ ...transcription, enabled: e.target.checked })
              }
            />
          }
          label="启用语音输入"
        />
        <TextField
          fullWidth
          margin="dense"
          label="转录服务 Endpoint（可留空）"
          placeholder={settings.gatewayEndpoint}
          value={transcription.endpoint}
          onChange={(e) =>
            setTranscription({ ...transcription, endpoint: e.target.value })
          }
        />
        <TextField
          fullWidth
          margin="dense"
          label="转录模型"
          placeholder="whisper-1"
          value={transcription.model}
          onChange={(e) =>
            setTranscription({ ...transcription, model: e.target.value })
          }
        />
        <TextField
          fullWidth
          margin="dense"
          label="转录服务 API Key（可留空）"
          type="password"
          value={transcription.apiToken}
          onChange={(e) =>
            setTranscription({ ...transcription, apiToken: e.target.value })
          }
        />
        <TextField
          fullWidth
          margin="dense"
          label="语言提示（如 zh；留空自动检测）"
          value={transcription.language}
          onChange={(e) =>
            setTranscription({ ...transcription, language: e.target.value })
          }
        />
        <Box sx={{ mt: 1 }}>
          <Button
            variant="contained"
            onClick={() => {
              // 关闭时不必校验模型；开启时模型为空会让每次转写都失败，提前兜底
              if (transcription.enabled && transcription.model.trim() === '') {
                toast.error('请先填写转录模型');
                return;
              }
              setSettings({ transcription });
              toast.success('语音输入设置已保存');
            }}
          >
            保存语音设置
          </Button>
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2, bgcolor: 'background.paper' }}>
        <Typography fontWeight={600} gutterBottom>
          数据管理
        </Typography>
        <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 1 }}>
          清空所有本地持久化数据（会话、Agent、技能、MCP、任务、产物）。
        </Typography>
        <Button color="error" variant="outlined" onClick={clearData}>
          清空本地数据
        </Button>
      </Paper>
    </Box>
  );
}
