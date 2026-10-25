/**
 * 专家（Agent）与会话的绑定解析（FR-2.3）：**这一轮实际下发哪个模型**。
 *
 * 为什么值得单独一个可单测的函数：模型值有两层语义（谁选的 / 它还有效吗），
 * 而「让它失效」的动作不在这个文件里——用户去设置页删一个预设就失效了。
 * 于是「下发前重新校验一次」必须集中在一处，否则每加一个绑定来源都要再想一遍。
 */

/**
 * 模型目录 → 可用预设 id 集合。
 *
 * ⚠️ **空目录返回 `null`（未知）而不是空集**：`modelsStore.models` 为空数组只表示
 * 「还没加载 / 网关离线」（网关在线时 `/v1/models` 至少含隐式 `default`）。
 * 拿空集当「全都失效」的后果是：启动瞬间发的第一轮消息里，会话级与专家级的模型选择
 * 一起静默失效、回落成网关默认——症状是「我明明选了模型，第一次却没生效」，
 * 而且只有第一次，之后自己就好了。这种「只在时序窗口里错」的 bug 最难查。
 */
export function availablePresetIds(
  models: readonly { id: string }[],
): ReadonlySet<string> | null {
  if (models.length === 0) return null;
  return new Set(models.map((m) => m.id));
}

/**
 * 本轮实际下发的模型（预设名）；`''` = 不下发，由网关用它自己的默认模型。
 *
 * **优先级：会话显式选择 > 专家绑定**。会话赢，因为那是用户此刻的明确动作；
 * 专家绑定是「省得每次再选一遍」的默认值，默认值不该盖过当场的选择。
 *
 * **逐级回落**，而不是只看最终候选：会话选的预设失效时，应退到专家绑的那个
 * （如果它还有效），而不是一步掉到网关默认。
 *
 * ⚠️ **每个候选都要过一遍「是否仍在目录里」**：预设被删或改名后，存下来的字符串
 * 指向了不存在的东西，而引擎收到未知预设会**直接报错**（`The model \`x\` does not exist`）。
 * 不筛的后果是「删掉一个预设」升级成「所有绑过它的专家每一轮都发不出去」——
 * 用户完全没法把这两件事联系起来。筛掉之后表现为「回落到默认模型」，与「本来就没绑」
 * 同义，是可接受的降级。
 *
 * `available === null` 表示目录还没加载（见 `availablePresetIds`）：此时**不筛**。
 */
export function resolveTurnModel(
  sessionModel: string | undefined,
  agentModel: string | undefined,
  available: ReadonlySet<string> | null,
): string {
  for (const candidate of [sessionModel, agentModel]) {
    if (!candidate) continue;
    if (available === null || available.has(candidate)) return candidate;
  }
  return '';
}
