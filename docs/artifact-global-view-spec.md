# 产物全局视图增强（FR-7.4 接入全局检索）—— 规格

> **上游**：`docs/fr-7-2-artifact-index-spec.md`（全局检索 + 去重折叠，已落）、
> `docs/fr-7-4-artifact-version-spec.md`（版本链，已落）、`docs/artifact-sync-spec.md`（内容寻址同步，已落）。
> **本批定位**：FR-7.4 的版本链已写入 `ArtifactIndexEntry`（`version` / `versions[]`），但
> **只暴露在 `ArtifactPanel` 的「版本历史」弹窗里**，全局产物库（跨会话检索 + 去重折叠）**没有
> 任何版本信息**。本规格补齐这一缺口：让用户在全局视图里一眼看出「哪些产物被改过 / 回退过」并快速过滤。

---

## 0. 现状（开工前实测，2026-09-29）

| 能力 | 现状 | 状态 |
|---|---|---|
| 关键词检索（标题/内容/语言） | `ArtifactsPage` + `filterItems` | ✅ 已落 |
| 类型筛选 | `ToggleButtonGroup` | ✅ 已落 |
| 时间/会话视图 + 排序 | `ViewMode` / `Order` | ✅ 已落 |
| 同 `contentHash` 折叠 +「N 处出现」展开 | `groupByHash` | ✅ 已落 |
| 版本徽章 / 仅编辑过筛选 | **无** | ❌ 本批新增 |

`ArtifactItem.entry` 已带 `version` / `versions[]`（`buildIndexEntry` 默认 `version:1` +
`versions:[{v1}]`；`bumpVersion` 推进），所以缺口只是**展示层没消费它**。

---

## 1. 决策表

| # | 决策点 | 裁决 | 理由 |
|---|---|---|---|
| D1 | 过滤放哪一层 | **纯函数层 `filterItems` 加 `editedOnly` 选项**（`hasVersionHistory` 判定），页面只传开关 | 检索是纯计算，单测覆盖而不必拉起 React；与既有 `keyword`/`types` 同层 |
| D2 | 「有版本历史」的判定 | `Array.isArray(entry.versions) && entry.versions.length > 1` | `version:1` 是基线（同源首版），只有被编辑/回退过才会 `> 1`；用 `versions` 长度而非 `version` 数值，避免「v3 但中间回退过」的歧义（长度才是真实编辑次数） |
| D3 | 徽章显示条件 | 仅 `entry.version > 1` 时显示 `vN` Chip（secondary） | 单版产物标 v1 是噪音；标题 `title` 注明「共 N 个版本，可在产物面板查看历史」 |
| D4 | UI 控件 | 工具栏加独立 `ToggleButton`「仅编辑过」（`selected` 受 `editedOnly` 控制），与排序/视图正交 | 它不是「排序维度」也不是「类型」，强行塞进现有 exclusive group 会语义错乱 |
| D5 | 不引入新存储 / 不同步字段 | 只读 `entry` 上既有的 `version`/`versions` | 同步链路已带这些字段，纯展示增强，零协议变更 |

---

## 2. 落点

| 文件 | 改动 |
|---|---|
| `src/lib/artifact/artifactIndex.ts` | `FilterOptions` 加 `editedOnly?`；新增 `hasVersionHistory(entry)`；`filterItems` 在 `editedOnly` 时只留 `hasVersionHistory` 为真的项 |
| `src/pages/artifacts/ArtifactsPage.tsx` | 加 `editedOnly` state + 「仅编辑过」`ToggleButton`；`filterItems` 传入 `editedOnly`；`renderEntryBar` 在 `version>1` 时加 `vN` Chip |
| `tests/lib/artifact/artifactIndex.test.ts` | `hasVersionHistory` 两例 + `editedOnly` 过滤一例 |
| `tests/pages/artifactsPage.test.tsx` | 版本徽章显示/不显示两例 + 「仅编辑过」过滤一例 |

---

## 3. 判据（可证伪）

| # | 判据 |
|---|---|
| J-1 | `hasVersionHistory` 对无 `versions` / 单元素数组返回 false，长度 >1 返回 true |
| J-2 | `filterItems(items, {editedOnly:true})` 只留 `versions.length>1` 的项；`editedOnly:false` 原样返回 |
| J-3 | 多版本产物在全局视图渲染出 `vN` Chip（N = `entry.version`） |
| J-4 | 单版本产物**不**渲染 `v1` Chip |
| J-5 | 点「仅编辑过」→ 单版本产物从列表消失，多版本保留且徽章仍在 |

---

## 4. 已知偏差

1. **折叠态不展开版本列表**：「N 处出现」折叠只按 `contentHash` 聚合，不区分组内各出现各自的版本；版本详情仍在 `ArtifactPanel` 查看。全局视图只做「有没有被改过」的粗粒度提示。
2. **`editedOnly` 与「N 处出现」可叠加**：同一内容在两会话出现且其一被改过 → 折叠组 `versions` 取最近一条；当前以「组内任一有版本历史」为显示依据（见 §2 的实现：折叠只渲染最近一条，徽章随该条）。如需「组内任意一条有版本即标」，属后续增强。
