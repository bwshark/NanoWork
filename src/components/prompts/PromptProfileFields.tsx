import { Box, MenuItem, Select, Typography } from '@mui/material';
import { findSlot, slotsOfKind } from '@/lib/promptCatalog';

/**
 * 「工作领域 / 语气风格」选择器（design §13.1 的模式 × 领域 × 风格矩阵）。
 *
 * 三个调用点共用同一份实现：设置页（全局默认）与两个 Agent 编辑弹窗（Agent 级覆盖）。
 * 抽出来不是为了省几行 JSX，而是为了让「跟随全局」这个状态只有一种表达方式——
 * 若两个弹窗各写一份，很容易出现「一边把未设置填成 general、另一边留空」，
 * 而空与 general 在装配时是**两种不同语义**（跟随全局 vs 显式指定通用）。
 *
 * ## `allowInherit` 与空串哨兵
 *
 * Agent 级字段是 `promptDomain?: string`：**省略 = 跟随全局**。MUI `Select` 不接受
 * `undefined` 作受控值，所以这里用空串当哨兵，回传时再还原成 `undefined`。
 * 设置页是全局层，没有「跟随」可言，传 `allowInherit={false}` 即不渲染该选项。
 */
export interface PromptProfileFieldsProps {
  /** 当前领域值（undefined = 跟随全局） */
  domain?: string;
  /** 当前风格值（undefined = 跟随全局） */
  style?: string;
  /** 是否渲染「跟随全局」选项（设置页为 false） */
  allowInherit?: boolean;
  /** 「跟随全局」时展示的全局值，用于把继承结果写清楚 */
  globalDomain?: string;
  globalStyle?: string;
  onDomainChange: (value: string | undefined) => void;
  onStyleChange: (value: string | undefined) => void;
  /** 分组小标题 */
  label?: string;
}

/** 槽位 → 下拉选项（label / description 直接来自内置目录，不另存一份文案） */
function optionsOf(kind: 'domain' | 'style') {
  return slotsOfKind(kind).map((slot) => ({
    key: slot.key,
    label: slot.label,
    description: slot.description,
  }));
}

/** 单选下拉：值语义为「空串 = 跟随全局」，未知 key 原样展示（不静默替换成默认） */
function ProfileSelect({
  kind,
  value,
  onChange,
  allowInherit,
  globalValue,
  globalFallbackLabel,
}: {
  kind: 'domain' | 'style';
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  allowInherit: boolean;
  globalValue?: string;
  globalFallbackLabel: string;
}) {
  const options = optionsOf(kind);
  const globalLabel =
    findSlot(kind, globalValue ?? '')?.label ?? globalValue ?? globalFallbackLabel;

  return (
    <Select
      fullWidth
      size="small"
      displayEmpty
      value={value ?? ''}
      onChange={(e) => {
        const next = e.target.value;
        onChange(next === '' ? undefined : next);
      }}
      renderValue={(v) =>
        v === '' ? (
          <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
            {allowInherit ? `跟随全局（${globalLabel}）` : '未选择'}
          </Typography>
        ) : (
          <Typography sx={{ fontSize: 13 }}>
            {findSlot(kind, String(v))?.label ?? String(v)}
          </Typography>
        )
      }
    >
      {allowInherit && (
        <MenuItem value="">
          <Typography sx={{ fontSize: 13 }}>跟随全局（{globalLabel}）</Typography>
        </MenuItem>
      )}
      {options.map((o) => (
        <MenuItem key={o.key} value={o.key}>
          <Box>
            <Typography sx={{ fontSize: 13 }}>{o.label}</Typography>
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
              {o.description}
            </Typography>
          </Box>
        </MenuItem>
      ))}
    </Select>
  );
}

export function PromptProfileFields({
  domain,
  style,
  allowInherit = false,
  globalDomain,
  globalStyle,
  onDomainChange,
  onStyleChange,
  label = '工作领域 / 语气风格',
}: PromptProfileFieldsProps) {
  /** 未知值（存储里留着已被移除的槽位 id）原样展示，不静默替换成默认 */
  const domainSlot = domain ? findSlot('domain', domain) : undefined;
  const styleSlot = style ? findSlot('style', style) : undefined;

  return (
    <Box sx={{ mt: 1 }}>
      <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.5 }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 1 }}>
        模式（问答 / 规划 / 执行）由会话当前模式决定，不在这里选。
      </Typography>

      <Box
        sx={{
          display: 'flex',
          gap: 1,
          flexDirection: { xs: 'column', sm: 'row' },
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <ProfileSelect
            kind="domain"
            value={domain}
            onChange={onDomainChange}
            allowInherit={allowInherit}
            globalValue={globalDomain}
            globalFallbackLabel="通用"
          />
          <Typography
            sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5, minHeight: 16 }}
          >
            {domainSlot?.description ?? ''}
          </Typography>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <ProfileSelect
            kind="style"
            value={style}
            onChange={onStyleChange}
            allowInherit={allowInherit}
            globalValue={globalStyle}
            globalFallbackLabel="专业"
          />
          <Typography
            sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5, minHeight: 16 }}
          >
            {styleSlot?.description ?? ''}
          </Typography>
        </Box>
      </Box>

      {/* 风格模板的正文可被外置覆盖（含内容质量护栏）。护栏被删掉才是真风险：
          风格可以变，事实与准确性不能跟着变——「人格」页在保存时会就此提示。 */}
      <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.5 }}>
        风格正文可在「人格」页外置修改；改动只影响表达方式，不影响事实与准确性。
      </Typography>
    </Box>
  );
}
