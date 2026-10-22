import { useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, Switch, Typography } from '@mui/material';
import { SettingsCard, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { toast } from '@/components/Toast';
import { useToolsPolicyStore } from '@/stores/toolsPolicyStore';
import { PathRulesEditor } from '@/components/settings/sections/PathRulesEditor';
import { DEFAULT_DENY_WRITE } from '@/lib/constants';

/**
 * 引擎侧的两条硬边界（FR-8.4「默认拒绝写入策略」）。
 *
 * ## 为什么这两块要放在一起
 *
 * 它们其实是**同一条边界的两个层次**：「默认拒绝写入」决定「没明说的地方能不能写」，
 * 凭据目录则决定「说了也不让碰的地方」——后者是**无条件**的（连读都禁、`full`
 * 模式也不可越过、allow-list 覆盖不了）。分开摆会让用户以为两处的松紧一样，
 * 于是他去开白名单去打「助手说 ~/.ssh 没权限」，而那个开关在引擎里根本不存在。
 *
 * ## 作用域白名单不在这一屏
 *
 * 引擎里另有一套**按作用域**的可写范围（`WorkspaceScope.allowed_root`，随每个
 * Agent / 会话随请求下发），它不是配置里的一张扁平表。界面上要是渲染成一个文本框，
 * 用户填进去的东西引擎根本不认（`extra="ignore"` 会静默丢掉），比不做还糟。
 * 那一层由「工作区访问模式」控制，不在本分区。
 *
 * ## 但「路径规则」在这一屏（FR-8.13）
 *
 * 路径规则是**配置层**的扁平表（`tools.file.pathRules`），引擎认，粒度是
 * 「路径 + 动作（读/写/删）」。它是「默认拒绝写入」在 `full` 模式下的**唯一
 * 放行出口**——见下面开关的说明。
 *
 * ## 凭据目录为什么只读
 *
 * 它在引擎里是**名单常量**（`security/workspace_policy.py` 的
 * `NO_ACCESS_DIR_NAMES` / `NO_ACCESS_HOME_FILE_NAMES` / `NO_ACCESS_FILE_NAMES`），
 * 不是配置项——给一个可编辑的入口，等于暗示「把 .ssh 加进白名单就能读私钥」，
 * 而提示词注入正是靠这种「用户已经授权过」的错觉得手的。
 */

/** 目录型凭据根（引擎 `NO_ACCESS_DIR_NAMES`，锚定在用户主目录下） */
const NO_ACCESS_DIRS = [
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.azure',
  '~/.kube',
  '~/.docker',
  '~/.password-store',
  '~/.config/gcloud',
  '~/.config/gh',
];

/** 主目录下的凭据文件（引擎 `NO_ACCESS_HOME_FILE_NAMES`） */
const NO_ACCESS_FILES = [
  '~/.netrc',
  '~/.npmrc',
  '~/.pypirc',
  '~/.git-credentials',
  '~/.htpasswd',
  '~/.authinfo',
];

/** 按文件名匹配的私钥（引擎 `NO_ACCESS_FILE_NAMES`，不限目录） */
const NO_ACCESS_KEY_NAMES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

export function SecuritySection() {
  const policy = useToolsPolicyStore((s) => s.policy);
  const policyAvailable = useToolsPolicyStore((s) => s.policyAvailable);
  const policyLoading = useToolsPolicyStore((s) => s.policyLoading);
  const loadPolicy = useToolsPolicyStore((s) => s.loadPolicy);
  const setDefaultDenyWrite = useToolsPolicyStore((s) => s.setDefaultDenyWrite);

  /** 草稿：`null` = 跟随 store（没有任何未保存的改动） */
  const [draft, setDraft] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  // 草稿为 null 时读的就是 store 里的值：分区重进 / 保存后回读都会自动跟上，
  // 不会出现「半截草稿把新读到的配置盖住」
  //
  // ⚠️ 兜底值必须是 `DEFAULT_DENY_WRITE`（= true，引擎 schema 的同名字段）：
  // 读不到策略（引擎配置里压根没有 `tools.file` 段）时，界面显示的默认态必须与
  // 引擎的实际默认一致。兜底写成 `false` 时，界面显示「关闭」而引擎其实在
  // 从严拒绝——分叉且**全程零报错**。
  const saved = policy?.defaultDenyWrite ?? DEFAULT_DENY_WRITE;
  const value = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  const supported = policy?.supported === true;

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    try {
      const ok = await setDefaultDenyWrite(value);
      if (!ok) {
        // 不把草稿清掉：写盘失败时把用户的选择丢掉是最坏的结果
        toast.error('保存失败，请查看网关日志');
        return;
      }
      setDraft(null);
      toast.success('写入策略已保存');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <SettingsCard
        title="写入策略"
        description="控制助手默认能不能往工作区里写文件。改完点「保存」才写入引擎配置——每一次写入都会重启网关，所以开关的改动先在本地攒着。"
        action={
          <Stack direction="row" spacing={1} alignItems="center">
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
              data-testid="save-policy"
              disabled={!dirty || busy || !policyAvailable}
              onClick={() => void handleSave()}
            >
              保存
            </Button>
          </Stack>
        }
      >
        {!policyAvailable && !policyLoading && (
          <Box sx={{ pb: 1.5 }}>
            <Alert severity="info" sx={{ fontSize: 12.5 }}>
              当前环境读不到引擎配置（Web 端，或未找到 config.json），无法管理写入策略。
            </Alert>
          </Box>
        )}

        {policyAvailable && !supported && (
          <Box sx={{ pb: 1.5 }}>
            <Alert severity="info" sx={{ fontSize: 12.5 }}>
              引擎的 config.json 里还没有 <code>tools.file</code> 段 —— 保存时会自动补上这一个键，
              其余配置不受影响。
            </Alert>
          </Box>
        )}

        <SettingsRow
          label="默认拒绝写入"
          hint={
            '默认已开启（不配即从严）。开启后，**没有可写范围**的作用域（引擎里的 ' +
            '“完全访问”模式）一律拒绝写与删，而不是退化成“哪里都能写”。' +
            '影响面：① 只在“完全访问”模式生效——限定了工作区范围的作用域本来就只写工作区，不受影响；' +
            '② 删除操作同样被拦；③ 读取不受影响。' +
            '想让某个目录能写，在下面「路径规则」里给它加一条「写 / 删 = 允许」——那是此处唯一的放行出口。' +
            '凭据目录无论开关如何都不可访问（见下）。'
          }
          control={
            <Switch
              size="small"
              checked={value}
              disabled={!policyAvailable || busy}
              data-testid="policy-switch"
              inputProps={{ 'aria-label': '默认拒绝写入' }}
              onChange={(_e, checked: boolean) => setDraft(checked)}
            />
          }
        />
      </SettingsCard>

      <SettingsCard
        title="路径规则（读 / 写 / 删分别授权）"
        description="给具体路径单独定「能不能读、能不能写、能不能删」。三者各自独立：想让某个目录只读，就只把「写」和「删」设成拒绝，读仍然放行。规则比上面的「默认拒绝写入」更具体，因此优先于它；但凭据目录那一组是无条件守卫，规则覆盖不了。"
      >
        <PathRulesEditor />
      </SettingsCard>

      <SettingsCard
        title="凭据目录（始终拒绝访问）"
        description="下面这些路径对助手始终不可读、也不可写——无论工作区设成哪种访问模式，也无法通过白名单放开。列在这里是为了让你能分辨“助手说没权限”是真边界，而不是它自己绕开了。"
      >
        <SettingsRow
          label="凭据目录"
          hint="锚定在用户主目录下：~/.ssh / ~/.gnupg / ~/.aws / ~/.azure / ~/.kube / ~/.docker / ~/.password-store / ~/.config/gcloud / ~/.config/gh。只按目录名判定，项目里恰好同名的子目录不会被误伤。"
        />
        <SettingsRow
          label="主目录凭据文件"
          hint="~/.netrc / ~/.npmrc / ~/.pypirc / ~/.git-credentials / ~/.htpasswd / ~/.authinfo。只拦主目录下的直接子项：项目里的 .npmrc 通常只是包源配置，不该被拦。"
        />
        <SettingsRow
          label="私钥文件"
          hint={`${NO_ACCESS_KEY_NAMES.join(' / ')} —— 按文件名匹配，不限目录（SSH 私钥没有扩展名，也可能被拷到任何地方）。`}
        />
        <Typography sx={{ fontSize: 12, color: 'text.secondary', px: 0.5, pt: 0.5 }}>
          这一组是引擎里的名单常量而不是配置项，因此这里只展示、不提供修改入口。
        </Typography>
      </SettingsCard>
    </Box>
  );
}
