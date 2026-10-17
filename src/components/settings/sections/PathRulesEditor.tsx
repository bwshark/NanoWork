import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { toast } from '@/components/Toast';
import { useToolsPolicyStore } from '@/stores/toolsPolicyStore';
import type { NanobotPathRule } from '@/platform/types';

/**
 * 路径规则编辑器（FR-8.13）。
 *
 * ## 为什么是「读 / 写 / 删」三个独立开关
 *
 * 真实诉求几乎全是「这个目录**别让改**、但要能读」——源码目录、配置模板、
 * vendor 目录都是这一类。一个笼统的 allow/deny 会让模型连读都做不到，而它随后
 * 会绕道（`shell` + `cat`）—— 那正是把权限边界做成筛子的方式。
 *
 * ## 为什么整表编辑 + 草稿保存
 *
 * 每一次写入都会**重启网关**（`commitNanobotConfig`），所以这里照写入策略那一套：
 * 改动先攒在本地草稿里，点「保存」才落盘。规则表用整表而不是「增删改一条」的
 * 增量接口：价值在于一眼看完谁被限制成什么样，而增量接口最常见的「删掉某条」
 * 会退化成「读全表 → 改一条 → 写回」，读与写之间的并发改动被静默覆盖。
 *
 * ## 三条边界
 *
 * 1. **凭据目录不受这里影响**：`~/.ssh` 那一组是引擎里的无条件守卫，规则
 *    `allow` 也覆盖不了它（验收④）。界面上必须说清这件事，否则用户会以为
 *    加一条 `read=allow` 就能让助手读私钥。
 * 2. **规则不能放宽工作区边界**：它只在边界**之内**做减法。
 * 3. **未声明的动作是「不表态」**，不是「允许」——所以下拉的默认项是「不表态」，
 *    而「允许」必须显式选。反过来的默认值会让「加了一条只想管写的规则」
 *    意外把读和删都放开。
 */

type Verdict = 'allow' | 'deny' | '';

const ACTION_LABELS: Array<{ kind: 'read' | 'write' | 'delete'; label: string }> = [
  { kind: 'read', label: '读' },
  { kind: 'write', label: '写' },
  { kind: 'delete', label: '删' },
];

/** 三个动作都没表态的规则对引擎毫无意义（引擎会连规则一起丢掉） */
function isEffective(rule: NanobotPathRule): boolean {
  return ACTION_LABELS.some(({ kind }) => rule.action[kind] !== undefined);
}

function sameRules(a: NanobotPathRule[], b: NanobotPathRule[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function verdictChip(verdict: 'allow' | 'deny' | undefined) {
  if (verdict === undefined) {
    return (
      <Chip size="small" variant="outlined" label="不表态" sx={{ fontSize: 11 }} />
    );
  }
  return (
    <Chip
      size="small"
      variant="outlined"
      color={verdict === 'deny' ? 'error' : 'success'}
      label={verdict === 'deny' ? '拒绝' : '允许'}
      sx={{ fontSize: 11 }}
    />
  );
}

export function PathRulesEditor() {
  const policy = useToolsPolicyStore((s) => s.policy);
  const policyAvailable = useToolsPolicyStore((s) => s.policyAvailable);
  const setPathRules = useToolsPolicyStore((s) => s.setPathRules);

  const [draft, setDraft] = useState<NanobotPathRule[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState('');
  const [verdicts, setVerdicts] = useState<Record<'read' | 'write' | 'delete', Verdict>>({
    read: '',
    write: '',
    delete: '',
  });

  const saved = useMemo(() => policy?.pathRules ?? [], [policy?.pathRules]);
  const rules = draft ?? saved;
  const dirty = draft !== null && !sameRules(draft, saved);

  const setVerdict = (kind: 'read' | 'write' | 'delete', value: Verdict): void => {
    setVerdicts((prev) => ({ ...prev, [kind]: value }));
  };

  const addRule = (): void => {
    const trimmed = path.trim();
    if (!trimmed) {
      toast.error('先填路径');
      return;
    }
    const action: NanobotPathRule['action'] = {};
    for (const { kind } of ACTION_LABELS) {
      const verdict = verdicts[kind];
      if (verdict) action[kind] = verdict;
    }
    if (Object.keys(action).length === 0) {
      toast.error('至少给一个动作表态（读 / 写 / 删）');
      return;
    }
    const next = [...rules, { path: trimmed, action }];
    setDraft(next);
    setPath('');
    setVerdicts({ read: '', write: '', delete: '' });
  };

  const removeRule = (index: number): void => {
    setDraft(rules.filter((_, i) => i !== index));
  };

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    try {
      const ok = await setPathRules(rules);
      if (!ok) {
        // 不清草稿：写盘失败时把用户的选择丢掉是最坏的结果
        toast.error('保存失败，请查看网关日志');
        return;
      }
      setDraft(null);
      toast.success('路径规则已保存');
    } finally {
      setBusy(false);
    }
  };

  if (!policyAvailable) {
    return (
      <Alert severity="info" sx={{ fontSize: 12.5 }}>
        当前环境读不到引擎配置（Web 端，或未找到 config.json），无法管理路径规则。
      </Alert>
    );
  }

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ pb: 1.5 }}>
        {dirty && (
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label="有未保存的改动"
            sx={{ fontSize: 11.5 }}
          />
        )}
        {dirty && (
          <Button size="small" disabled={busy} onClick={() => setDraft(null)}>
            放弃修改
          </Button>
        )}
        <Button
          size="small"
          variant="contained"
          data-testid="save-path-rules"
          disabled={!dirty || busy}
          onClick={() => void handleSave()}
        >
          保存
        </Button>
      </Stack>

      {rules.length === 0 ? (
        <Typography sx={{ fontSize: 12, color: 'text.secondary', pb: 1.5 }}>
          还没有规则。此时路径权限完全由「默认拒绝写入」开关与工作区边界决定。
        </Typography>
      ) : (
        <Box sx={{ pb: 1.5 }}>
          {rules.map((rule, index) => (
            <Stack
              key={`${rule.path}-${index}`}
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ py: 0.5, borderBottom: '1px solid', borderColor: 'divider' }}
            >
              <Typography
                sx={{
                  fontSize: 12.5,
                  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={rule.path}
              >
                {rule.path}
              </Typography>
              <Stack direction="row" spacing={0.5}>
                {ACTION_LABELS.map(({ kind, label }) => (
                  <Box key={kind} sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
                    <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{label}</Typography>
                    {verdictChip(rule.action[kind])}
                  </Box>
                ))}
              </Stack>
              <IconButton size="small" aria-label={`删除规则 ${rule.path}`} onClick={() => removeRule(index)}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Stack>
          ))}
        </Box>
      )}

      <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ pt: 0.5 }}>
        <TextField
          size="small"
          label="路径"
          placeholder="/abs/path 或 ~/relative"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          inputProps={{ 'data-testid': 'rule-path' }}
          sx={{ flex: 1, minWidth: 220 }}
        />
        {ACTION_LABELS.map(({ kind, label }) => (
          <TextField
            key={kind}
            size="small"
            select
            label={label}
            value={verdicts[kind]}
            onChange={(e) => setVerdict(kind, e.target.value as Verdict)}
            inputProps={{ 'data-testid': `rule-${kind}` }}
            sx={{ width: 96 }}
          >
            <MenuItem value="">不表态</MenuItem>
            <MenuItem value="allow">允许</MenuItem>
            <MenuItem value="deny">拒绝</MenuItem>
          </TextField>
        ))}
        <Button size="small" variant="outlined" data-testid="add-rule" onClick={addRule}>
          加入列表
        </Button>
      </Stack>

      <Typography sx={{ fontSize: 12, color: 'text.secondary', pt: 1.5 }}>
        规则只在这个作用域之内生效，不能放宽工作区边界；更具体的路径优先
        （给子目录单独写一条，就能覆盖父目录的裁决）。凭据目录（~/.ssh 等）是
        无条件守卫，这里写「允许」也不会让它可读。
      </Typography>
      {rules.some((rule) => !isEffective(rule)) && (
        <Typography sx={{ fontSize: 12, color: 'warning.main', pt: 0.5 }}>
          列表里有三个动作都没表态的规则 —— 它对引擎不生效，保存时会被丢掉。
        </Typography>
      )}
    </Box>
  );
}
