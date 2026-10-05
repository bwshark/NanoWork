import { useEffect, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  MenuItem,
  Select,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { AgentModelPicker } from '@/components/models/AgentModelPicker';
import { PromptProfileFields } from '@/components/prompts/PromptProfileFields';
import { AGENT_TOOL_CATALOG, AGENT_TOOL_LABELS } from '@/lib/constants';
import { PLATFORM_LABEL } from '@/lib/imPlatform';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSkillsStore } from '@/stores/skillsStore';
import type { Agent, IMPlatform } from '@/types';

/**
 * 新建专家时的草稿初值。
 *
 * `imBinding: null` 是「未绑定」，与「绑定了一个空账号」不同；`toolAllow` / `toolDeny`
 * 刻意**不出现**在这里（省略 = 不限制），因为空数组是「一个工具都不许」——把「还没设置」
 * 落成空数组会直接把这个专家锁死。
 */
const EMPTY_AGENT: Partial<Agent> = {
  name: '',
  systemPrompt: '',
  skillIds: [],
  imBinding: null,
  enabled: true,
};

export interface AgentFormDialogProps {
  open: boolean;
  /** 正在编辑的专家；空 = 新建 */
  editing?: Agent | null;
  onClose: () => void;
  /**
   * 保存草稿。**由调用方决定** `createAgent` 还是 `updateAgent` ——
   * 组件不碰 store 的写路径，也就不承担「按 id 更新还是新建」这个分支。
   */
  onSave: (form: Partial<Agent>) => void;
}

/**
 * 专家创建 / 编辑表单（FR-2.3）。
 *
 * ⚠️ 抽出来的直接原因是一个**真实缺陷**：`AgentsPage`（专家管理）与 `MyAgentsPage`
 * （我的专家）各自实现了一份专家表单，而两边的**字段集不一致** —— `AgentsPage` 那份
 * 少了整个「工具权限」区，于是「同一个专家，在两个页面能改的东西不同」：
 * 从专家管理进去看不到白/黑名单，从我的专家进去才有。合并后这里取**超集**，
 * 两个入口形状一致。
 *
 * 依赖全部自取（技能目录、全局提示词档案、模型目录都由子组件自己订阅），
 * 调用方只需要 open / editing / onClose / onSave —— 少一个 prop 就少一处可以传错的地方。
 */
export function AgentFormDialog({
  open,
  editing,
  onClose,
  onSave,
}: AgentFormDialogProps) {
  const skills = useSkillsStore((s) => s.skills);
  /** 全局提示词档案：Agent 级覆盖未设置时展示「跟随全局」的继承结果 */
  const settings = useSettingsStore((s) => s.settings);

  const [form, setForm] = useState<Partial<Agent>>(EMPTY_AGENT);

  /**
   * 每次**打开**都从 `editing` 重新起稿。
   *
   * ⚠️ 这里用 effect 而不是 `key={editing?.id}` 卸载重挂：重挂会让 Dialog 跳过退出
   * 动画（点「取消」时框直接消失）。本组件的状态来源只有 props，effect 里 setState
   * 是安全的——注意别把它写成「渲染期用 ref 哨兵判断后 setState」，那才是禁止的
   * （见开发笔记 §7.25.2 的 StrictMode 说明）。
   */
  useEffect(() => {
    if (!open) return;
    setForm(editing ? { ...editing } : EMPTY_AGENT);
  }, [open, editing]);

  const toggleImBinding = () => {
    if (form.imBinding) {
      setForm({ ...form, imBinding: null });
      return;
    }
    setForm({
      ...form,
      // 与两份原实现一致：先落一个「已在线」的本地记录（真实状态由 IM 网关回填，
      // 见下方 caption 的说明）。改这里要同步改卡片上的徽标判定。
      imBinding: {
        platform: 'feishu',
        account: '',
        status: 'online',
        lastSyncAt: new Date().toISOString(),
      },
    });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{editing ? '编辑专家' : '新建专家'}</DialogTitle>
      <DialogContent>
        <TextField
          fullWidth
          margin="dense"
          label="名称"
          value={form.name ?? ''}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <TextField
          fullWidth
          margin="dense"
          multiline
          minRows={3}
          label="系统身份提示"
          value={form.systemPrompt ?? ''}
          onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
        />
        <Typography sx={{ fontSize: 13, mt: 1, mb: 0.5 }}>绑定技能</Typography>
        <Select
          fullWidth
          multiple
          value={form.skillIds ?? []}
          onChange={(e) => setForm({ ...form, skillIds: e.target.value as string[] })}
          renderValue={(sel) =>
            (sel as string[])
              .map((id) => skills.find((s) => s.id === id)?.name ?? id)
              .join('、')
          }
        >
          {skills.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.name}
            </MenuItem>
          ))}
        </Select>

        {/* 领域 / 风格覆盖（design §13.1）：留空 = 跟随全局设置。
            刻意不预填全局值——把「跟随」落成具体值后，改全局就再也影响不到
            这个 Agent，而用户根本没做过这个决定。 */}
        <PromptProfileFields
          domain={form.promptDomain}
          style={form.promptStyle}
          allowInherit
          globalDomain={settings.promptDomain}
          globalStyle={settings.promptStyle}
          label="领域 / 风格覆盖（可选）"
          onDomainChange={(v) => setForm({ ...form, promptDomain: v })}
          onStyleChange={(v) => setForm({ ...form, promptStyle: v })}
        />

        {/* 工具权限（FR-2.2）：在引擎的工具网关强制，不依赖系统提示词。
            关掉开关 = 不声明限制（undefined）；打开 = 声明白名单。
            两者必须保持可区分——把「没设置」落成空数组会把这个 Agent 直接锁死。
            ⚠️ 这个区此前只在「我的专家」页存在，是两份表单字段不一致的根源。 */}
        <Divider sx={{ my: 1.5 }} />
        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
          工具权限（FR-2.2）
        </Typography>
        <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
          白名单在引擎侧强制：不在名单里的工具连调用都会被拒，改提示词也绕不过。
        </Typography>
        <FormControlLabel
          // `gap` 是必需的：MUI 给 FormControlLabel 的 root 塞了 `marginLeft: -11px`
          // （为了让开关轨道的**视觉**左缘与上面的输入框对齐），代价是轨道右侧与文字
          // 之间**零间距**——真机上看着像开关压住了「仅允许指定工具」几个字，
          // 而几何上只是紧贴（实测 轨道右缘 393.0 == 文字左缘 393.0）。
          sx={{ mt: 0.5, gap: 1 }}
          control={
            <Switch
              size="small"
              checked={form.toolAllow !== undefined}
              onChange={(e) =>
                setForm({
                  ...form,
                  // 打开时默认全选（等于「先不收紧，再逐个取消」），关掉时回到
                  // undefined（不限制）而不是空数组（一个都不许）。
                  toolAllow: e.target.checked ? [...AGENT_TOOL_CATALOG] : undefined,
                })
              }
            />
          }
          label={
            <Typography sx={{ fontSize: 13 }}>
              仅允许指定工具（最小权限）
            </Typography>
          }
        />
        {form.toolAllow !== undefined && (
          <Autocomplete
            multiple
            freeSolo
            size="small"
            sx={{ mt: 1 }}
            options={[...AGENT_TOOL_CATALOG]}
            getOptionLabel={(o) => String(o)}
            value={form.toolAllow}
            onChange={(_e, value) =>
              setForm({ ...form, toolAllow: value.map((v) => String(v)) })
            }
            renderOption={(props, option) => (
              <li {...props} key={option}>
                <Box>
                  <Typography sx={{ fontSize: 13 }}>{option}</Typography>
                  {AGENT_TOOL_LABELS[option] && (
                    <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                      {AGENT_TOOL_LABELS[option]}
                    </Typography>
                  )}
                </Box>
              </li>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="允许的工具"
                placeholder="留空 = 一个工具都不许"
                helperText="可输入 MCP 工具名（如 mcp__github__create_issue）"
              />
            )}
          />
        )}
        <Autocomplete
          multiple
          freeSolo
          size="small"
          sx={{ mt: 1 }}
          options={[...AGENT_TOOL_CATALOG]}
          getOptionLabel={(o) => String(o)}
          value={form.toolDeny ?? []}
          onChange={(_e, value) => {
            const next = value.map((v) => String(v));
            setForm({ ...form, toolDeny: next.length ? next : undefined });
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="禁止的工具（可选）"
              placeholder="优先级高于上面的白名单"
              helperText="用于在宽白名单上精确挖掉个别危险工具"
            />
          )}
        />

        {/* 模型绑定（FR-2.3）：专家自带模型，省得每次召唤再选一遍 */}
        <AgentModelPicker
          value={form.model}
          onChange={(v) => setForm({ ...form, model: v })}
        />

        <Divider sx={{ my: 1.5 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
            IM 远程控制（FR-010）
          </Typography>
          {form.imBinding && (
            <Chip
              size="small"
              color={form.imBinding.status === 'online' ? 'secondary' : 'default'}
              label={PLATFORM_LABEL[form.imBinding.platform]}
            />
          )}
        </Box>
        {form.imBinding ? (
          <Box sx={{ mt: 1 }}>
            <Select
              fullWidth
              value={form.imBinding.platform}
              onChange={(e) =>
                setForm({
                  ...form,
                  imBinding: {
                    ...form.imBinding!,
                    platform: e.target.value as IMPlatform,
                  },
                })
              }
            >
              {(Object.keys(PLATFORM_LABEL) as IMPlatform[]).map((p) => (
                <MenuItem key={p} value={p}>
                  {PLATFORM_LABEL[p]}
                </MenuItem>
              ))}
            </Select>
            <TextField
              fullWidth
              margin="dense"
              label="账号 / 机器人标识"
              value={form.imBinding.account}
              onChange={(e) =>
                setForm({
                  ...form,
                  imBinding: { ...form.imBinding!, account: e.target.value },
                })
              }
            />
            <Button
              size="small"
              color="warning"
              sx={{ mt: 1 }}
              onClick={toggleImBinding}
            >
              解绑
            </Button>
          </Box>
        ) : (
          <Button
            size="small"
            variant="outlined"
            sx={{ mt: 1 }}
            onClick={toggleImBinding}
          >
            绑定 IM
          </Button>
        )}
        <Typography variant="caption" color="text.secondary">
          真实绑定推送依赖 nanobot 运行时（IM 网关）；此处先记录本地配置。
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="contained"
          onClick={() => onSave(form)}
          disabled={!form.name?.trim()}
        >
          保存
        </Button>
      </DialogActions>
    </Dialog>
  );
}
