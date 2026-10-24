import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from '@mui/material';
import {
  KB_LOGIN_REQUIRED,
  KB_OFFLINE_HINT,
  createKbGateway,
  type KbApiResult,
  type KbGateway,
  type KbOrg,
  type KbSummary,
} from '@/lib/kbClient';
import { resolveSyncBaseUrl } from '@/sync/baseUrl';
import { getSyncRuntime } from '@/sync/runtime';
import type { AgentKnowledgeBinding } from '@/types';

/**
 * 专家的知识库绑定（FR-2.3 第四条 / FR-4.7）。
 *
 * ## 三种状态必须说清楚，不能都渲染成"空"
 *
 * 1. **未登录**：知识库在云端，没账户就没有"我的组织"。此时说要去登录，
 *    而不是显示一个空的组织列表——空列表会被读成"我的组织里没有库"。
 * 2. **加载失败**（网络断 / 403）：原样报服务端那句，并提供重试。
 * 3. **绑定的组织已不在列表里**（退出组织、换账号、换部署）：明确提示要重选。
 *    只按住 id 显示一行 `org_xxx` 是没用的——用户看不出该做什么。
 *
 * ## 为什么用单选 + 复选，而不是下拉
 *
 * 「范围」这件事有**两档语义**：整个组织（我可见的全部库）/ 只搜某几本。用一个
 * 多选下拉表达不了这个区分（空选择到底是"全部"还是"没有"，界面上看不出来），
 * 而这两者在本项目里方向相反：`toolAllow: []` 是锁死，`kbIds: []` 是不收窄。
 * 摊成"档位 + 勾选"之后，用户看到的和落库的值是一一对应的。
 *
 * ## 网关可注入
 *
 * `gateway` 缺省从同步运行时取（真实登录态）；用例传桩，不必 mock 整个 runtime。
 * `null` 表示"确定没有网关"（未登录），与 `undefined`（自己去找）刻意区分。
 */
export interface AgentKnowledgePickerProps {
  value?: AgentKnowledgeBinding;
  onChange: (next: AgentKnowledgeBinding | undefined) => void;
  gateway?: KbGateway | null;
}

type Scope = 'all' | 'picked';

export function AgentKnowledgePicker({ value, onChange, gateway }: AgentKnowledgePickerProps) {
  const [client, setClient] = useState<KbGateway | null>(gateway ?? null);
  const [needLogin, setNeedLogin] = useState(gateway === null);
  const [orgs, setOrgs] = useState<KbOrg[]>([]);
  const [kbs, setKbs] = useState<KbSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  /** status=0（没连上）与 403/404（业务语义）要分开：后者贴「请启动服务」只会误导 */
  const [offline, setOffline] = useState(false);

  /** 首次进入：有注入网关就用它，否则从同步运行时取（token 只在这一跳里出现）。 */
  useEffect(() => {
    if (gateway !== undefined) {
      setClient(gateway);
      setNeedLogin(gateway === null);
      return;
    }
    const runtime = getSyncRuntime();
    const token = runtime?.account.getAccessToken() ?? null;
    if (!runtime || !token) {
      setNeedLogin(true);
      setClient(null);
      return;
    }
    setClient(createKbGateway({ baseUrl: resolveSyncBaseUrl(), token }));
  }, [gateway]);

  const applyResult = useCallback(<T,>(result: KbApiResult<T>): T | null => {
    if (result.ok) {
      setOffline(false);
      return result.data;
    }
    if (result.unauthorized) setNeedLogin(true);
    setOffline(result.status === 0);
    setError(result.message);
    return null;
  }, []);

  const loadOrgs = useCallback(
    async (target: KbGateway) => {
      setLoading(true);
      setError('');
      const data = applyResult(await target.listOrgs());
      setLoading(false);
      if (data) setOrgs(data);
    },
    [applyResult],
  );

  useEffect(() => {
    if (client) void loadOrgs(client);
  }, [client, loadOrgs]);

  const orgId = value?.orgId ?? '';
  const selectedKbIds = value?.kbIds ?? [];
  const scope: Scope = selectedKbIds.length > 0 ? 'picked' : 'all';

  // 只加载**当前绑定组织**的库：组织没选或未绑定时不需要这份列表
  useEffect(() => {
    if (!client || orgId === '') {
      setKbs([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const data = applyResult(await client.listKbs(orgId));
      // 快速切换组织时丢弃过期响应：否则会显示上一个组织的库
      if (!cancelled && data) setKbs(data);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, orgId, applyResult]);

  const bind = () => {
    // 默认「整个组织」：不替用户收窄范围（收窄要他自己决定）。
    // 没有组织时按钮是禁用的，因此这里不必再兜一次空 orgId。
    onChange({ orgId: orgs[0]?.id ?? '', kbIds: [] });
  };

  const switchScope = (next: Scope) => {
    if (!value) return;
    if (next === 'all') {
      onChange({ orgId: value.orgId, kbIds: [] });
      return;
    }
    // 切到「只搜选中的库」先**全选**，再逐个取消——空集在本语义里等于"全部"，
    // 直接落空数组会让界面回到「整个组织」，用户会以为点击没生效。
    onChange({ orgId: value.orgId, kbIds: kbs.map((kb) => kb.id) });
  };

  const toggleKb = (kbId: string, checked: boolean) => {
    if (!value) return;
    const next = checked
      ? [...selectedKbIds, kbId]
      : selectedKbIds.filter((id) => id !== kbId);
    onChange({ orgId: value.orgId, kbIds: next });
  };

  if (needLogin) {
    return (
      <Box data-testid="knowledge-need-login">
        <Typography sx={{ fontSize: 13, fontWeight: 600, mb: 0.5 }}>
          知识库（FR-2.3）
        </Typography>
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{KB_LOGIN_REQUIRED}</Typography>
      </Box>
    );
  }

  const boundOrgMissing = value !== undefined && orgId !== '' && orgs.length > 0
    && !orgs.some((org) => org.id === orgId);

  return (
    <Box data-testid="knowledge-picker">
      <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
        知识库（FR-2.3）
      </Typography>
      <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5, mb: 1 }}>
        绑定后每轮自动检索一次，命中的段落作为参考资料注入本轮对话（云端已按角色过滤可见范围）。
      </Typography>

      {error !== '' && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Typography data-testid="knowledge-error" sx={{ fontSize: 12, color: 'warning.main' }}>
            {error}
          </Typography>
          <Button size="small" onClick={() => client && void loadOrgs(client)}>
            重试
          </Button>
        </Stack>
      )}
      {error !== '' && offline && (
        <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 1 }}>
          {KB_OFFLINE_HINT}
        </Typography>
      )}

      {loading && orgs.length === 0 ? (
        <CircularProgress size={16} />
      ) : value === undefined ? (
        <>
          <Button
            size="small"
            variant="outlined"
            data-testid="knowledge-bind"
            onClick={bind}
            disabled={orgs.length === 0}
          >
            绑定知识库
          </Button>
          {orgs.length === 0 && !loading && error === '' && (
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1 }}>
              你还没有加入任何组织；知识库挂在组织下，请先在「知识库」页创建或加入组织。
            </Typography>
          )}
        </>
      ) : (
        <Box>
          {boundOrgMissing && (
            <Typography sx={{ fontSize: 12, color: 'warning.main', mb: 1 }}>
              绑定的组织已不在你的组织列表里（可能已退出或被移出），请重新选择。
            </Typography>
          )}
          <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 0.5 }}>组织</Typography>
          <RadioGroup
            row
            value={orgId}
            onChange={(e) => onChange({ orgId: e.target.value, kbIds: [] })}
          >
            {orgs.map((org) => (
              <FormControlLabel
                key={org.id}
                value={org.id}
                data-testid={`knowledge-org-${org.id}`}
                control={<Radio size="small" />}
                label={<Typography sx={{ fontSize: 13 }}>{org.name}</Typography>}
              />
            ))}
          </RadioGroup>

          <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1, mb: 0.5 }}>
            检索范围
          </Typography>
          <RadioGroup row value={scope} onChange={(e) => switchScope(e.target.value as Scope)}>
            <FormControlLabel
              value="all"
              data-testid="knowledge-scope-all"
              control={<Radio size="small" />}
              label={<Typography sx={{ fontSize: 13 }}>整个组织（我可见的全部库）</Typography>}
            />
            <FormControlLabel
              value="picked"
              data-testid="knowledge-scope-picked"
              control={<Radio size="small" />}
              label={<Typography sx={{ fontSize: 13 }}>只搜选中的库</Typography>}
            />
          </RadioGroup>

          {scope === 'picked' && (
            <Box sx={{ pl: 1 }}>
              {kbs.length === 0 ? (
                <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                  该组织下还没有你能看到的知识库。
                </Typography>
              ) : (
                kbs.map((kb) => (
                  <FormControlLabel
                    key={kb.id}
                    data-testid={`knowledge-kb-${kb.id}`}
                    control={
                      <Checkbox
                        size="small"
                        checked={selectedKbIds.includes(kb.id)}
                        onChange={(e) => toggleKb(kb.id, e.target.checked)}
                      />
                    }
                    label={
                      <Typography sx={{ fontSize: 13 }}>
                        {kb.name}
                        <Typography component="span" sx={{ fontSize: 11, color: 'text.secondary', ml: 1 }}>
                          {kb.documentCount} 篇
                        </Typography>
                      </Typography>
                    }
                  />
                ))
              )}
            </Box>
          )}

          <Button
            size="small"
            color="warning"
            sx={{ mt: 1 }}
            data-testid="knowledge-unbind"
            onClick={() => onChange(undefined)}
          >
            解绑
          </Button>
        </Box>
      )}
    </Box>
  );
}
