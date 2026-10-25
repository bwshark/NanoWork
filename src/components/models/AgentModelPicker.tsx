import { MenuItem, TextField } from '@mui/material';
import { describeModelId, useModelsStore } from '@/stores/modelsStore';

interface AgentModelPickerProps {
  /** 当前绑定（**预设名**）；`''` 或 undefined = 不绑定，跟随会话 / 网关默认 */
  value?: string;
  onChange: (model: string) => void;
}

/**
 * 专家级模型绑定选择器（FR-2.3）。
 *
 * 为什么抽成组件而不是在两个专家表单里各写一段：`AgentsPage` 与 `MyAgentsPage` 的
 * 专家编辑 Dialog **本就是两份重复实现**（字段集还不一致），再各加一段只会让那个
 * 既有缺陷再长一截。这里保证「一处实现、两处引用」。
 *
 * 取值与 `Session.model` 同域（都是**预设名**）—— 同域才能比较、才能回落；
 * 若一边存预设名一边存裸模型名，看起来都对，实现里永远对不上。
 *
 * **失效项显式画出来并标注**：预设被删 / 改名后，存下来的字符串就不在目录里了。
 * 若只是让它「选不中」，Select 会渲染成空 —— 用户会以为「本来就没绑」，
 * 而实际是「绑了一个已经不存在的东西，本轮会回落到默认模型」
 * （拦截规则见 `lib/agent/agentBinding.ts` 的 `resolveTurnModel`）。
 */
export function AgentModelPicker({ value, onChange }: AgentModelPickerProps) {
  const models = useModelsStore((s) => s.models);
  const refresh = useModelsStore((s) => s.refresh);
  const selected = value ?? '';

  // 目录已加载（非空）却找不到这个 id → 失效。目录为空时**不判失效**：
  // 那只是「还没拉 / 网关离线」，此时标红会让每次冷启动都吓用户一跳。
  const stale =
    selected !== '' && models.length > 0 && !models.some((m) => m.id === selected);

  return (
    <TextField
      select
      fullWidth
      margin="dense"
      label="模型（可选）"
      value={selected}
      onChange={(e) => onChange(e.target.value)}
      SelectProps={{
        // 打开时才拉目录：省一次启动期请求，顺便拿到最新预设（与任务表单同一做法）
        onOpen: () => void refresh(),
        // ⚠️ `displayEmpty` 必需：本控件的「未绑定」用的是**空串**，而 MUI Select
        // 默认把空串当成「没有值」，渲染一个零宽占位符 + 不显示任何文本 ——
        // 于是留空时框里是空白的，用户根本看不出「跟随会话」这个状态存在。
        // 开了它才会去 children 里找 value='' 的那一项（即 Auto 项）并渲染其文案。
        displayEmpty: true,
      }}
      // ⚠️ label 必须**常浮起**，不能交给 MUI 按「值是否为空」自动判断：
      // 本控件框内**始终**有一行文案（`Auto · 默认模型` 或 `预设名 · 模型名`），
      // 而 MUI 在值为空时会把 label 留在框内当占位 —— 两者位置相同，真机上就是
      // 「模型（可选）」与值文本叠成一团（用户截图报的就是这个）。
      // 判据与回归保护见 `tasks/verify-agent-model-binding.mjs` 的几何断言。
      InputLabelProps={{ shrink: true }}
      helperText={
        stale
          ? '该预设已不在模型目录里：本轮会回落到默认模型，建议重新选一个或清空'
          : '留空 = 跟随会话选择；会话也没选则用网关默认模型'
      }
    >
      <MenuItem value="" sx={{ fontSize: 13 }}>
        {describeModelId(models, null)}
      </MenuItem>
      {models
        .filter((m) => m.id !== 'default')
        .map((m) => (
          <MenuItem key={m.id} value={m.id} sx={{ fontSize: 13 }}>
            {describeModelId(models, m.id)}
          </MenuItem>
        ))}
      {/* 失效项：只有它不在上面那批选项里，单独补一项，否则 Select 会显示成空白 */}
      {stale && (
        <MenuItem value={selected} sx={{ fontSize: 13 }}>
          {selected}（已失效）
        </MenuItem>
      )}
    </TextField>
  );
}
