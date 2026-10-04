/**
 * 结果推送目标选择器（FR-5.6）。
 *
 * 可选目标**只能来自引擎侧真实存在过的渠道会话**：投递需要 `(channel, chatId)`
 * 两个值，而用户无从知道某个群 / 某个联系人的 chat id —— 所以这个控件本质是
 * 「从已有对话里挑一个」，数据源就是 IM 频道会话列表（`channelSessionsStore`，
 * 由 App 启动时开启的 4s 轮询维护）。
 *
 * 刻意不做的事：
 * - **不自己拼 chatId**（拼出来一定推不出去，且失败是静默的）；
 * - **不在没有目标时渲染「推送时机」**（那个控件此时不会有任何效果）。
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Button, Chip, Menu, MenuItem, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useChannelSessionsStore } from '@/stores/channelSessionsStore';
import { channelLabel } from '@/lib/channelLabel';
import {
  deliveryOptionLabel,
  deliveryTargetFromSession,
  deliveryTargetKey,
  hasDeliveryTarget,
} from '@/lib/taskDelivery';
import type { TaskDelivery, TaskDeliveryTarget } from '@/types';

/**
 * 空目标的稳定引用。
 *
 * 用模块级常量而不是 `?? []`：后者每次渲染都产生新数组，会把下面 `useMemo` 的
 * 依赖每帧都判定为「变了」，缓存形同虚设。
 */
const NO_TARGETS: readonly TaskDeliveryTarget[] = Object.freeze([]);

export interface DeliveryFieldProps {
  value: TaskDelivery | undefined;
  onChange: (next: TaskDelivery | undefined) => void;
  /** 上方字段标签；由调用方给（沿用表单里 `FieldLabel` 的统一观感） */
  label?: ReactNode;
}

export function DeliveryField({ value, onChange, label }: DeliveryFieldProps) {
  const summaries = useChannelSessionsStore((s) => s.summaries);
  const targets = value?.targets ?? NO_TARGETS;
  const when = value?.on ?? 'complete';
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  /*
   * 打开表单时补拉一次频道会话。轮询周期是 4s，用户完全可能正好落在这个空窗里
   * 打开对话框，那样会看到「还没有可推送的会话」——而其实早就有了。
   * `refresh()` 自带 loading 互斥，重复调用无副作用。
   */
  useEffect(() => {
    void useChannelSessionsStore.getState().refresh();
  }, []);

  /** 可选目标 = 有路由身份的渠道会话，且**尚未**被加入 */
  const candidates = useMemo(
    () =>
      summaries
        .map((summary) => ({ summary, target: deliveryTargetFromSession(summary) }))
        .filter((item): item is { summary: typeof summaries[number]; target: TaskDeliveryTarget } => {
          return item.target !== null && !hasDeliveryTarget(targets, item.target);
        })
        .map((item) => ({
          key: item.summary.key,
          label: deliveryOptionLabel(item.summary),
          target: item.target,
        })),
    [summaries, targets],
  );

  /** 已选目标的友好名：会话可能已被清掉，因此要有退路（渠道 + 会话 id） */
  const labelForTarget = (target: TaskDeliveryTarget): string => {
    const hit = summaries.find((s) => {
      const t = deliveryTargetFromSession(s);
      return t !== null && deliveryTargetKey(t) === deliveryTargetKey(target);
    });
    return hit
      ? deliveryOptionLabel(hit)
      : `${channelLabel(target.channel)} · ${target.chatId}`;
  };

  /** 目标清空时收敛成 `undefined`：「有 delivery 却没有 targets」是个说不通的中间态 */
  const commit = (next: TaskDeliveryTarget[], nextWhen: TaskDelivery['on'] = when) => {
    onChange(next.length === 0 ? undefined : { targets: next, on: nextWhen });
  };

  const removeTarget = (target: TaskDeliveryTarget) => {
    const key = deliveryTargetKey(target);
    commit(targets.filter((t) => deliveryTargetKey(t) !== key));
  };

  return (
    <>
      {label}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: targets.length > 0 ? 0.75 : 0 }}>
        {targets.map((target) => (
          <Chip
            key={deliveryTargetKey(target)}
            size="small"
            label={labelForTarget(target)}
            onDelete={() => removeTarget(target)}
          />
        ))}
      </Box>

      <Button
        size="small"
        startIcon={<AddIcon />}
        disabled={candidates.length === 0}
        onClick={(e) => setMenuAnchor(e.currentTarget)}
        sx={{ textTransform: 'none', fontSize: '13px', px: 0.75, minWidth: 0 }}
      >
        添加推送目标
      </Button>
      <Menu
        anchorEl={menuAnchor}
        open={menuAnchor !== null}
        onClose={() => setMenuAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        {candidates.map((c) => (
          <MenuItem
            key={c.key}
            onClick={() => {
              commit([...targets, c.target]);
              setMenuAnchor(null);
            }}
          >
            {c.label}
          </MenuItem>
        ))}
      </Menu>

      {summaries.length === 0 && (
        <Typography sx={{ fontSize: '12px', color: 'text.secondary', mt: 0.5 }}>
          还没有可推送的会话：先在 设置 → 助理设置 里接入一个渠道，并在该渠道里跟机器人说一句话
          —— 只有真实存在过的对话才能作为推送目标。
        </Typography>
      )}

      {targets.length > 0 && (
        <ToggleButtonGroup
          exclusive
          size="small"
          value={when}
          onChange={(_e, next: TaskDelivery['on'] | null) => {
            // 点已选中的档位会给出 null；忽略它而不是把时机清成空
            if (next) commit([...targets], next);
          }}
          sx={{ mt: 0.5, display: 'flex' }}
        >
          <ToggleButton value="complete" sx={{ textTransform: 'none', fontSize: '12px' }}>
            每次执行后
          </ToggleButton>
          <ToggleButton value="error" sx={{ textTransform: 'none', fontSize: '12px' }}>
            仅失败时
          </ToggleButton>
        </ToggleButtonGroup>
      )}
    </>
  );
}
