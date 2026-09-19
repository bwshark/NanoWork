import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  IconButton,
  InputAdornment,
  Paper,
  Popover,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlineOutlined';
import SearchIcon from '@mui/icons-material/SearchOutlined';
import { HotkeyInput } from '@/components/HotkeyInput';
import { toast } from '@/components/Toast';
import { useDesktopConfig } from '@/hooks/useDesktopConfig';
import {
  DEFAULT_WAKE_ACCELERATOR,
  SHORTCUTS,
  bindingFromEvent,
  formatBinding,
  resolveBinding,
  type ShortcutDef,
} from '@/lib/shortcuts';
import { platform } from '@/platform';
import { useSettingsStore } from '@/stores/settingsStore';

/** 三列网格：命令自适应、键位定宽（键帽要能对齐成一列）、操作定宽 */
const GRID_TEMPLATE = '1fr 168px 44px';

const HEAD_SX = { fontSize: 12, fontWeight: 600, color: 'text.secondary' } as const;

/**
 * 快捷键设置分区。
 *
 * 列表是「命令 / 按键绑定 / 操作」三列：命令只读，键位点击即改，操作列的 🗑
 * 表示**恢复默认**（而不是「删除这条命令」——命令本身是代码里的能力，删不掉）。
 *
 * 与 WorkBuddy 的两处刻意差异：
 * 1. 不收录「内容缩放」三条——本项目暂无该能力，收进来就是假菜单项；
 * 2. 「唤起/隐藏主窗口」的键位**不在 `settings.shortcuts` 里**，它在
 *    `desktop.hotkey`（Electron accelerator）。因为这条是主进程
 *    `globalShortcut` 注册的系统级热键，主进程冷启动时就要读它，
 *    不可能等渲染层把覆盖表合并完再注册。界面上它仍是一行，
 *    但录入器换成 `HotkeyInput`（只读输入框 + 按键捕获），因为它要产出的是
 *    accelerator 语法、且注册失败需要回退——那是完全另一套语义。
 */
export function ShortcutsSection() {
  const settings = useSettingsStore((s) => s.settings);
  const setShortcut = useSettingsStore((s) => s.setShortcut);
  const resetShortcuts = useSettingsStore((s) => s.resetShortcuts);
  const { desktop, apply, hotkeyError } = useDesktopConfig();

  const [query, setQuery] = useState('');
  /** 正在改键的那一行；anchor 是该行键帽，Popover 据此定位 */
  const [recording, setRecording] = useState<{
    def: ShortcutDef;
    anchor: HTMLElement;
  } | null>(null);

  const overrides = settings.shortcuts;
  const desktopReady = platform.env === 'electron';

  /** 某条命令当前生效的键位。全局唤起快捷键走 desktop.hotkey，其余走覆盖表 + 默认值 */
  const bindingOf = (def: ShortcutDef): string =>
    def.id === 'app.wake'
      ? desktop.hotkey || ''
      : resolveBinding(def.id, overrides);

  const rows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return SHORTCUTS;
    return SHORTCUTS.filter((def) => {
      const binding =
        def.id === 'app.wake' ? desktop.hotkey : resolveBinding(def.id, overrides);
      return (
        def.label.toLowerCase().includes(keyword) ||
        formatBinding(binding).toLowerCase().includes(keyword)
      );
    });
  }, [query, overrides, desktop.hotkey]);

  const wakeChanged = desktop.hotkey !== DEFAULT_WAKE_ACCELERATOR;
  const hasCustomizations =
    Object.keys(overrides ?? {}).length > 0 || (desktopReady && wakeChanged);

  const canEdit = (def: ShortcutDef) =>
    def.group === 'custom' && (!def.desktopOnly || desktopReady);

  /**
   * 落定一条键位。
   * - `null` = 恢复默认（删表项）
   * - `''`   = 显式禁用（留空表项）
   */
  const commitBinding = async (def: ShortcutDef, binding: string | null) => {
    setRecording(null);

    if (def.id === 'app.wake') {
      if (!desktopReady || !window.electronAPI) return;
      // apply 内部已处理「被系统占用 → 提示并回退」，这里只补成功反馈
      const ok = await apply({
        hotkey: binding ?? DEFAULT_WAKE_ACCELERATOR,
      });
      if (ok) toast.success(`「${def.label}」已更新`);
      return;
    }

    if (binding) {
      // 冲突检查：同一个组合键绑给两条命令，会变成「按下后只有先匹配到的那条生效」，
      // 另一条则永远沉默——这种问题在界面上看不出来，只能在录入时挡掉。
      const conflict = SHORTCUTS.find(
        (other) =>
          other.id !== def.id &&
          other.group === 'custom' &&
          resolveBinding(other.id, overrides) === binding,
      );
      if (conflict) {
        toast.error(`该组合已被「${conflict.label}」占用`);
        return;
      }
    }

    setShortcut(def.id, binding);
    if (binding === null) toast.success(`「${def.label}」已恢复默认`);
    else if (binding === '') toast.success(`「${def.label}」已禁用`);
    else toast.success(`「${def.label}」已改为 ${formatBinding(binding)}`);
  };

  const handleResetAll = async () => {
    resetShortcuts();
    if (desktopReady && wakeChanged) {
      await apply({ hotkey: DEFAULT_WAKE_ACCELERATOR });
    }
    toast.success('已恢复全部默认快捷键');
  };

  return (
    <Box>
      {/* —— 工具栏 —— */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
        <TextField
          size="small"
          placeholder="搜索快捷键"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ flex: 1, maxWidth: 420 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
              </InputAdornment>
            ),
          }}
        />
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          variant="outlined"
          onClick={() => void handleResetAll()}
          disabled={!hasCustomizations}
        >
          全部恢复默认
        </Button>
      </Box>

      {/* —— 列表 —— */}
      <Paper
        variant="outlined"
        sx={{ bgcolor: 'background.paper', overflow: 'hidden' }}
      >
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: GRID_TEMPLATE,
            alignItems: 'center',
            gap: 1.5,
            px: 2,
            py: 1.25,
            bgcolor: 'action.hover',
            borderBottom: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Typography sx={HEAD_SX}>命令</Typography>
          <Typography sx={HEAD_SX}>按键绑定</Typography>
          <Typography sx={HEAD_SX}>操作</Typography>
        </Box>

        {rows.length === 0 ? (
          <Box sx={{ px: 2, py: 4, textAlign: 'center' }}>
            <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
              没有匹配的快捷键
            </Typography>
          </Box>
        ) : (
          <Box
            sx={{
              '& > * + *': { borderTop: '1px solid', borderColor: 'divider' },
            }}
          >
            {rows.map((def) => {
              const editable = canEdit(def);
              const binding = bindingOf(def);
              return (
                <Box
                  key={def.id}
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: GRID_TEMPLATE,
                    alignItems: 'center',
                    gap: 1.5,
                    px: 2,
                    py: 0.75,
                    minHeight: 40,
                  }}
                >
                  <Typography
                    sx={{
                      fontSize: 13,
                      color: editable ? 'text.primary' : 'text.secondary',
                    }}
                  >
                    {def.label}
                  </Typography>

                  {/* 键帽：点击进入改键。不可改的两条渲染成灰底静态块（对齐参考图） */}
                  <Box
                    component="button"
                    type="button"
                    disabled={!editable}
                    aria-label={`修改「${def.label}」的按键绑定`}
                    onClick={(e) =>
                      setRecording({ def, anchor: e.currentTarget })
                    }
                    sx={{
                      justifySelf: 'start',
                      display: 'inline-flex',
                      alignItems: 'center',
                      height: 24,
                      minWidth: 36,
                      px: 1,
                      borderRadius: 1,
                      fontFamily:
                        'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: 12,
                      lineHeight: 1,
                      whiteSpace: 'nowrap',
                      border: '1px solid',
                      borderColor: editable ? 'divider' : 'transparent',
                      bgcolor: editable ? 'background.default' : 'action.hover',
                      color: editable ? 'text.primary' : 'text.disabled',
                      boxShadow: editable
                        ? '0 1px 0 rgba(15, 23, 42, 0.05)'
                        : 'none',
                      cursor: editable ? 'pointer' : 'default',
                      '&:hover': editable
                        ? { borderColor: 'text.disabled' }
                        : undefined,
                    }}
                  >
                    {formatBinding(binding) || '未设置'}
                  </Box>

                  {editable ? (
                    <Tooltip title="恢复默认">
                      <IconButton
                        size="small"
                        aria-label={`恢复「${def.label}」的默认按键`}
                        onClick={() => void commitBinding(def, null)}
                      >
                        <DeleteOutlineIcon sx={{ fontSize: 17 }} />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Typography
                      sx={{
                        fontSize: 12,
                        color: 'text.disabled',
                        justifySelf: 'center',
                      }}
                    >
                      —
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Box>
        )}
      </Paper>

      <Typography
        sx={{ fontSize: 11.5, color: 'text.secondary', mt: 1, lineHeight: 1.7 }}
      >
        点击键位即可改键；Backspace 清空即禁用该快捷键，Esc 取消。
        {desktopReady
          ? ''
          : '「唤起/隐藏主窗口」是桌面端系统级热键，Web 端不可配置。'}
      </Typography>

      {/* —— 改键录入器 —— */}
      <Popover
        open={recording !== null}
        anchorEl={recording?.anchor ?? null}
        onClose={() => setRecording(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        PaperProps={{ sx: { p: 1.5, width: 320 } }}
      >
        {recording && (
          <Box>
            <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 1 }}>
              {recording.def.label}
            </Typography>
            {recording.def.id === 'app.wake' ? (
              <HotkeyInput
                value={desktop.hotkey}
                onChange={(accelerator) =>
                  void commitBinding(recording.def, accelerator)
                }
                error={hotkeyError}
              />
            ) : (
              <BindingRecorder
                current={bindingOf(recording.def)}
                onPick={(binding) => void commitBinding(recording.def, binding)}
                onCancel={() => setRecording(null)}
              />
            )}
          </Box>
        )}
      </Popover>
    </Box>
  );
}

/**
 * 应用内快捷键的录入器。
 *
 * 用「聚焦一个容器 + keydown 捕获」而不是自由文本：手输的键位串几乎必然与
 * KeyboardEvent 的取值对不上（`esc` / `Esc` / `Escape` 三种写法都像对的），
 * 捕获则天然只有一种结果。
 *
 * 为什么不用 `HotkeyInput` 复用：那个组件产出的是 Electron accelerator
 * （要求必须带修饰键、且 `Enter` 要写成 `Return`），它服务的是系统级热键；
 * 应用内快捷键允许裸键（`Enter` / `Esc` / `F11`），两套取值规则不同。
 */
function BindingRecorder({
  current,
  onPick,
  onCancel,
}: {
  current: string;
  /** 传 `''` 表示禁用 */
  onPick: (binding: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Popover 不做自动聚焦（它把焦点留给了触发按钮），主动抢一次
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Tab 留给键盘无障碍导航，不吞掉
    if (e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      onCancel();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      onPick('');
      return;
    }

    const binding = bindingFromEvent(e.nativeEvent);
    // 只按住修饰键时不落定，等用户按下主键
    if (!binding) return;
    onPick(binding);
  };

  return (
    <Box>
      <Box
        ref={ref}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        // 可聚焦的录制区，需要名字：屏幕阅读器只念「请按下组合键…」是读不出用途的
        aria-label="按键录制区"
        sx={{
          border: '1px solid',
          borderColor: 'primary.main',
          borderRadius: 1,
          py: 2,
          textAlign: 'center',
          cursor: 'text',
          outline: 'none',
        }}
      >
        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
          请按下组合键…
        </Typography>
        <Typography
          sx={{
            fontSize: 12,
            color: 'text.secondary',
            mt: 0.5,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        >
          当前：{formatBinding(current) || '未设置'}
        </Typography>
      </Box>
      <Typography
        sx={{ fontSize: 11.5, color: 'text.secondary', mt: 1, lineHeight: 1.7 }}
      >
        Backspace 清空即禁用，Esc 取消。
      </Typography>
    </Box>
  );
}
