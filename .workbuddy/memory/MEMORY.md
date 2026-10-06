# 项目长期记忆 — nanowork

WorkBuddy 式智能体客户端：React 18 + TS + Vite 渲染层 + Electron 主进程 + nanobot 引擎（Python）。
详述全在 skill `nanowork-dev-gate`（环境/门禁/重建/引擎契约/同步/产物等）。
**完整 FR 状态索引见 `docs/README.md` §九 看板（以代码为准）**——本文件只留最硬规则与高频踩坑，避免重复。

## 硬规则

- 核心逻辑/测试**单引号**；UI 层混用双引号 → 动文件先看现有风格，别整体格式化。注释写「为什么」。
- ⛔ **模型不得执行任何 git 写操作**（提交/推送由用户决定）；`nanobot/` 独立 .git 且对象库受损 → 只读。
- 渲染层只允许 `src/platform/**` 认识 `window.electronAPI`（CI 检查一）；引擎 wire 键名只允许在 `src/ai/runtime/nanobotHttp/**`（CI 检查二）。两处基线已清空。
- 读持久化值要**解析两次**（`createJSONStorage` + `WebStorageAdapter` 各一次）。
- ⛔ **`vitest` 与根 `vite` 同代**：现锁 `vitest@3.2.7` + 根 `vite@5.4.21`。升 vitest 4 必须同时升根 vite ≥6。
- ⚠️ **判超时只看 `err.name === 'AbortError'`**（abort 抛 DOMException，跨 realm `instanceof Error` 恒 false）。
- 门禁**三套 tsc 一起跑**（`typecheck`/`typecheck:electron`/`typecheck:tests`）；`typecheck:tests` 不在 `build` 内。
- 改 `electron/**.ts` 必须**重建 `main.cjs` + `preload.cjs`**。
- ⚠️ 门禁命令带 **`--maxWorkers=3`**（并行拉满时 `tests/electron/` 互相干扰）。
- ⚠️ **`tests/` 被 `.gitignore` 整目录忽略** → 新测试要 `git add -f`；同坑 `tasks/`（已补前导斜杠）。
- 写 `platform.storage.set` 新 key 必须先登记 `STORAGE_KEYS`；**裸字符串别落 json 路由**（主进程 `JSON.parse` 必崩，写入静默丢）。

## 高频踩坑（保命，细节见 docs/README.md §九 看板）

- ⚠️ **`spawn(wait=false)` 丢结果**：serve 进程无 inbound 消费者（唯一 `consume_inbound()` 在 `AgentLoop.run()`）。与 FR-2.4 **无依赖**——编排用 `run_inline` 直接 await，不走总线。
- ⚠️ **专家团 FR-2.4 现状不可行**：引擎只有匿名子代理，`agent_id` 只用于工具策略非人设路由；UI 已如实说明「只保存配置、不改变执行结果」。
- ⚠️ **专家模型绑定 FR-2.3**：`Agent.model` 存预设名（与 `Session.model` 同域）；下发前必须拦失效预设；目录未加载返回 `null` 非空集。
- ⚠️ **store 两条写路径不对称**（`createAgent`/`updateAgent`/`mergeAgents`）→ 加新字段三处一起改，否则「保存瞬间消失/重启变回」。
- ⚠️ **StrictMode**：换请求清状态用 `key={id}` 卸载重挂，别用渲染期 ref+setState；测试入口 `mountStrict()`。
- ⚠️ **回退链两态**（`preset`|`inline`）不许拍平；失效引用会让网关起不来（配置加载时校验链上每项必须存在）。
- ⚠️ **配置类编辑用草稿+保存**（`syncNanobotModels` 每次写入重启网关）。
- ⚠️ 引擎 `Base` `extra="ignore"`：未声明键静默丢弃 → 新增声明式字段先改 `schema.py` + 加往返用例。别从 grep 推断序列化。
- ⚠️ **「查不到 ≠ 不支持」**：元数据缺失（Web/引擎离线/手填模型）一律宽松。
- ⚠️ **`input_tokens` 已含缓存读取** → 计价三档（未命中/缓存读/输出），缓存单价缺省按输入价。
- ⚠️ **绿灯 ≠ 门禁过**：全绿但 `exit=1` = Unhandled Error（MUI 过渡 `setTimeout` 不归 React 管）→ 该文件 `afterEach` 卸组件 + 等 400ms。**判门禁看退出码**。
- ⚠️ **`.gitignore` 裸目录名匹配任意层级**：`tasks/` 曾误吞 `src/**/tasks/` 源码（已补前导斜杠）。

## 记忆功能现状

- 三层落点真实可用；9 测试文件 195 用例全绿。
- ⚠️ **未修缺陷**：`looksLikeSystemError`（`src/lib/memory.ts`）漏判三类报错文案 → 报错被写进长期记忆（生产已脏 4 条 `2026-09-20|21.md`）。详见 `.workbuddy/memory/2026-10-01.md`。

## 真机验证铁律

1. 布局量几何（`getBoundingClientRect`+`getComputedStyle`），别只看截图。
2. Playwright 必须 `args:['--no-proxy-server']`（本机 `http_proxy` 劫持 `127.0.0.1`）。
3. dev server 与 `vite build` 不要并发；dev 端口以 `vite.config.ts` 为准（2026-10-01 = 5176）。
4. 启动 dev 前先 `mv node_modules/.vite/deps_temp_* /tmp`（改 `@mui/icons-material` 图标重优化依赖会撞安全删除守卫崩 dev）。
5. 真机切场景 = 每场景 `ctx.newPage()`；桩数据落 `localStorage` **且** `Object.assign` 内存对象。
6. 判断上游真伪用 `curl --noproxy '*' -i` + `/openapi.json`。
