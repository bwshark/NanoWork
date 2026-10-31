# 项目长期记忆 — nanowork

React18+TS+Vite 渲染层 + Electron 主进程 + nanobot 引擎(Python)。
FR 权威：`docs/nanowork-prd-design-v2.md` 第 3 章；逐日细节 `YYYY-MM-DD.md`；长尾 `MEMORY-archive.md`。只记**看代码推不出来**的事。

## 硬规则（违反即假绿/假红）
- ⛔ 模型不执行 git 写操作；`nanobot/` 独立 .git，只读。
- 渲染层只 `src/platform/**` 碰 `window.electronAPI`；引擎 wire 键名只在 `src/ai/runtime/nanobotHttp/**`。
- 核心/测试单引号，UI 双引号；注释写「为什么」。
- ⛔ `vitest@3.2.7` 锁根 `vite@5.4.21`（升 vitest4 必须同升 vite≥6，否则全仓 `failed to find the runner`）。
- 判超时只看 `err.name==='AbortError'`（跨 realm `instanceof` 恒 false）。
- 门禁：三套 tsc（`typecheck` / `:electron` / `:tests`）+ `vitest --maxWorkers=3 --silent` + `CODEBUDDY_SAFE_DELETE_ENABLED=0 vite build --emptyOutDir false`。**永远看退出码**。
- 改 `electron/**.ts` 必须重建 `main.cjs`+`preload.cjs`；`tests/`、`tasks/` 被整目录忽略 → `git add -f`。
- 新 storage key 登记 `STORAGE_KEYS` + `electron/storageRoutes.ts::RUNTIME_FILES`。
- 换行多为 CRLF（个别新文件 LF）→ 批量 Edit 前先探。
- `src/` 不 import `electron/`；Electron 直接 import 的 8 个 lib 文件，依赖链里**不能有 `@/` 别名**。

## 引擎事实
- `spawn(wait=false)` 丢结果 → `/v1` 链路必须 `run_inline`。
- logger 占位符：`loop.py` loguru `{}` / `expert_group.py` `%s`，写反不报错。
- `agent/context.py` 只能在函数内 import `agent.plugins`（否则环闭）。
- `serve` 才有 `/v1/*`；`gateway` 只有 channel + `/health` + `/v1/turn(/progress)` + `/v1/send` + `/v1/cron/reload` + `/v1/approvals(/resolve)`。
- 思考在 assistant 记录的 `reasoning_content`。
- `hook_manifest` 唯一执行方 `agent/hooks/plugin_lifecycle.py`，**刻意不跑外部命令**。
- 改引擎代码不用同步副本（venv 的 `nanobot.__file__` 就是仓库内那份）。
- 三条**预存**红（Windows symlink）：`test_plugin_state_symlink_cannot_escape_config_root` / `test_package_skill_rejects_symlink` / `test_workspace_policy::...symlink_escape`。
- 审计两通道：`tool-gateway.ndjson` + `app-operations.ndjson`（camelCase）。

## 客户端/渲染
- ⛔ 消息渲染不分会话类型；⛔ 副作用别挂可选 UI 组件；`nextGatewayEndpoint` **只看 port**。
- ⛔ 云端 access token TTL 30 分钟 → 「`getToken` 实时取票 + 401 换票重放一次」，**绝不把 token 拷进配置快照**；装配处唯一 `src/sync/kbGateway.ts`；refresh 单飞只在 `syncAccount.refresh()`。
- ⛔ Agent 新字段改三处：`types/agent.ts` + `agentsStore.buildAgent` + `mergeAgents`。
- vitest 全量必带 `--maxWorkers=3 --silent`（不加会刷 13 万行 act 告警 → `ERR_IPC_CHANNEL_CLOSED`、拿不到汇总行）；`EPERM node-brokered-fs-shim` 重跑即绿。
- `npm run build` 偶发 vite panic → 单跑 `npx vite build` 重定向日志更稳。

## 语音输入（STT）
- ⛔ 引擎 `serve` **没有** `/audio/transcriptions`（STT 只在 channel + gateway WS 事件里）→ 客户端必须**直连服务商**。
- ⛔ 阿里云百炼 `compatible-mode/v1` 也**没有**该路由（实测 404）：走 `POST /chat/completions`，音频 base64 放 `messages[0].content[0].input_audio.data`，语言走**顶层** `asr_options.language`，结果在 `choices[0].message.content`，须显式 `stream:false`。
- ⛔ 百炼 `qwen-audio-*` **只吃公网 URL**（传 base64 回 `400 url error`）；能内联 base64 的只有 `qwen3-asr-flash`。带 `-streaming`/`-realtime` 的是实时模型，不能「录一段再识别」。实测同音频：qwen3→200 / qwen-audio-3.0、fun-asr→403 额度 / streaming→400。
- 探模型是否存在：`POST /chat/completions` 传 `{"model":X,"messages":[{"role":"user","content":"hi"}]}`（回 `url error`=形态错，回 `model not found`=名字错）；`GET /models` 列真实清单。
- ⛔ 上传前转 **16kHz 单声道 WAV**（Chrome/Electron 只吐 webm/opus，硅基流动等只认 wav/mp3）；WAV 头**必须小端**，量化用 32767 不用 32768。
- ⛔ 录音态配色按主题分两套：参考图 `#dff7f2`+`#7cdfcb` 在浅色背景对比度 <2:1 → 浅色改 `#0f766e` 实底 + `#d7fbf1` 条。
- 扩散环 `@keyframes` **起点 opacity 必须 0**（给 0.55 会留硬描边，像边框不像扩散）；走 transform/opacity 上合成层，别用 box-shadow。
- 波形取**前 1/4 频段 + 对数分桶**（512 bin 全等分会后 4 根恒 0）+ 噪声地板。
- ⛔ 点麦克风会让输入区**失焦** → 转写回来时 `editableCaretOffset` 读不到选区会返回文本长度（永远追加末尾）→ 开录时记 `voiceAnchorRef`。
- ⛔ Electron 默认**拒绝所有 media 权限**（抛 `NotAllowedError`，症状同「用户拒绝」）；`setPermissionRequestHandler` + `setPermissionCheckHandler` **两个都要设**；mac 打包要 `NSMicrophoneUsageDescription`。
- 错误分类：**`NotReadableError`（设备被占用）才是 Windows 最常见**，文案要指向「关掉会议软件」；用 `err.name` 不用 `instanceof`。
- ⚠️ 从文档复制 endpoint 常带尾部逗号 → `normalizeSttEndpoint` 清 `,;，；`（否则 `/v1,/chat/completions` 必 404）。
- **实时流式**（边说边出字）：WS `{WorkspaceId}.xxx.maas.aliyuncs.com/api-ws/v1/realtime?model=...`
  - ⛔ 鉴权**只能** `?api_key=`：浏览器 WebSocket 不能设 header，子协议也不合法
    （`Bearer sk-x` 含空格 → `SyntaxError: invalid subprotocol`）。代价是 key 进 URL → 只允许 wss。
  - ⛔ 中间结果事件是 **`transcription.delta`**（文档只写 `.text`），字段 `text`(定稿)+`stash`(尾巴)；
    最终在 `.completed` 的 `transcript`。两种事件名都要认（不同模型可能不同）。
  - ⛔ **commit 后不发 `session.finished`**（实测只发 completed）→ 用「completed 后静默 600ms」
    收尾，别干等超时（否则转圈十几秒）。另必须等 `session.updated` 再灌音频，早了开头几片被吞。
  - 模型额度（实测）：`qwen-audio-3.1-realtime-flash` 可用；
    `qwen3-asr-flash-realtime` / `qwen-audio-3.0-asr-flash` / `fun-asr-flash` 均
    `AllocationQuota.FreeTierOnly`（免费额度耗尽，不是代码问题）。
  - PCM 用 **AudioWorklet** 降采样（块平均，避免混叠），不用 ScriptProcessor（跑主线程会卡打字）；
    与电平分析复用同一个 AudioContext（开第二个会让麦克风被接两次，部分驱动直接静音）。
  - 中间结果回填必须**整体替换**（记草稿区长度），直接 append 会变成「你好你好你好」。
  - 边框流动光晕：`conic-gradient + mask` 只留 1px 环，动 `--voice-angle`（合成层不重排）；
    ⛔ 容器 `overflow` 必须 `visible`，否则 `inset:-1` 的光晕被裁一圈。
- ⚠️ 本机 `~/.nanowork/settings.json` 的 `transcription` 需 `provider=dashscope` +
  `model=qwen-audio-3.1-realtime-flash`（实时）或 `qwen3-asr-flash`（非实时）；
  `custom` 分支默认走 multipart，配百炼会失败。
- ⚠️ 参考视频/录屏若音轨 -91dB（全静音，录屏没开麦）→ 用官方公网样例
  `dashscope.oss-cn-beijing.aliyuncs.com/audios/welcome.mp3` 验证识别。

## 知识库（M7）
- 绑定：渲染层每轮预取。⛔ `kbIds: []` = 组织可见**全部**库（与 `toolAllow: []` 方向相反）；provider 靠 `setKnowledgeSearchProvider` 注入（否则成环）；检索不到不注入任何段。
- ⛔ 正文以 Markdown 为唯一存储格式，解析产 GFM 管道表格；检索投影不落库、按 `\n\n` 逐段算，词法与 embedding 共用同一函数。
- ⛔ `src/lib/kb/richText.ts` 必须有 `table`/`img` 分支（否则**静默吞掉**）；单元格包 `<div>`；对齐用 `data-align`；别给 `th` 设默认 `text-align`。
- ⛔ `<img src>` 不带 Authorization → 带票取字节换 `blob:`；react-markdown `urlTransform` 会清 `blob:` → 放行留在 `MarkdownRenderer` 内部（不外提，772KB）。
- ⚠️ `sx` 里 `borderRadius: 4` 实测变 40px → 写像素用字符串。
- 可见性唯一实现 `kb/visibility.py::allows()`；个人库 = `Organization.kind=personal` + 其下一本普通库（⛔ 不给 `knowledge_bases` 加 `owner_user_id` 分叉）；⛔ 个人库不在 `kbsByOrg` → 「选中库不在列表就清空」会把它踢掉（用 `personalKbRef` 排）。
- 加列迁移走 `migrations.py::ADDED_COLUMNS`（DDL 带 DEFAULT，只加不改不删）；判据必须在**自建 engine** 上跑。图表只做静态图 + 数值抽取。

## 内置模型（云端下发）
- `builtin_models` 全局表 + `GET /api/models/builtin`（登录可读）；⛔ 种子只插缺失 id；⛔ 写接口没配 admin token 时回 **404 而非 403**。
- 客户端 `App.tsx` 注入 fetcher（modelsStore 不能 import `sync/runtime`）；播种判据「预设名不在 managed 里」，不比对值。

## 本机环境坑
- ⚠️ 云端跑在容器 `nanowork-cloud`(8910)：改 `cloud/app/**` **必须重建镜像**（`docker restart` 与无 `--build` 的 up 都是旧代码）。
  症状是「某个页面全部 Not Found，但 `/health` 200、别的页面正常」→ 一条命令分清：`cd cloud && python docker/verify.py --routes-only`（拉 openapi 查必需路由，缺了 exit 1）。
  ⛔ 重建时 `BASE_IMAGE` **必须与旧镜像同一版本**（现为 `python:3.13-slim`；用 3.12 会让 apt 层缓存全失效、卡在 56MB 中文字体包下载僵死）。查法 `docker run --rm <img> python -V`。
  ⛔ **apt 源与 pip 源独立**：apt 走通 aliyun ≠ pip 通，官方 PyPI 在这里直接 `HTTPSConnectionPool` 失败。三条一起给：`BASE_IMAGE=<swr python:3.13-slim> APT_MIRROR=mirrors.aliyun.com PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/`。
  ⚠️ 构建日志全是 NUL 字节（先 `tr -d '\000'`）；判断僵死看**日志字节数是否增长**，别看时长。`docker cp` 只能临时止血（容器重建即丢）。
- Docker CLI 不在 PATH：`%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe`。
- ⚠️ `HTTP_PROXY` 会让 urllib 把 127.0.0.1 交给代理 → 502（脚本用 `ProxyHandler({})`）。
- ⚠️ 重启 8910 前确认 PID 已换新（旧进程占着时新进程 `WinError 10048` 退出，`/health` 仍 200）。
- ⚠️ 云端 pytest **别加 `-q`**（Windows 不打汇总行）。
- 变异验证：绝对路径 + 无条件备份还原 + `cmp`；绿了先查「同一规则是否写了两遍」；收尾 `git diff`。
- 默认拒绝写入（FR-8.4）：引擎 `default_deny_write=True` 与客户端 `DEFAULT_DENY_WRITE=true` 逐字一致；`_FsTool` 参数默认 **False**（用例钉住两层必须相反）。
- ⛔ IM 发言不能走 `/v1/chat`（会落 `api:<id>` 新会话、零报错），必须 gateway `POST /v1/turn`。
- 产物登记：任务会话 `handleProcessTool`→`deriveFileArtifacts`；导入会话只有 `sessionsStore.openExternal`；按轮聚合，重放不幂等 → `hasContentHashInHistory`。
- 专家包 `nanowork.expert/v1`：缺技能不阻塞 / 缺预设丢弃 / `toolAllow: []` 原样保留。
- 默认模型 `agnes-3.0-flash` 免费档限流 → 验收脚本先 `wait_for_quota()`。
- ⛔ 从 WorkBuddy 宿主起引擎必须 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。
- `tool_deny` 按工具名不按能力（deny `write_file` 后子代理会用 `apply_patch`/`exec`）。
- ⚠️ 验 FR-8.3 回收站**别用 `%TEMP%` 下的路径**：临时目录内的删除是**直删**（返回 `Deleted (temp directory, not recycled)`），`defaultDenyWrite` 仍会拦，但「是否进回收站」验不出来。
- Dream 输入只有 `memory/history.jsonl`；`/dream` 是后台任务，候选轮询 `GET /v1/dream/review`。
- ⚠️ 写入工具会把形似凭据的字面串换成 `***` → 测试口令拆写并 `repr` 复核。
- ⚠️ 内置浏览器（IAB）对本应用截图超 10MiB、`dom_cua_get_visible_dom` 返回空 → 走 Playwright（`npx --no-install playwright`；包在 `~/AppData/Local/npm-cache/_npx/<hash>/node_modules/playwright`，**必须传 `executablePath`** 指向 `ms-playwright/chromium-<rev>/chrome-win64/chrome.exe`，否则版本不符直接报「Executable doesn't exist」）。`vite --strictHost` 是错 flag（`--strictPort`）。
- ⚠️ 新增 worktree 需建 node_modules 目录联接（PowerShell `New-Item -ItemType Junction`；cmd 的 `mklink /J` 在 Git Bash 里会被路径空格打断）。
- venv 只有 `nanobot/nanobot/.venv`；引擎测试 `cd nanobot && ./nanobot/.venv/Scripts/python.exe -m pytest tests/`。

## 打包交付
- 入口唯一 `node scripts/build-installer.mjs [--platform win|mac|linux] [--arch x64|arm64]`；⛔ 架构与 `build/rt` 必须成对，不一致直接 fail。
- ⛔ `uv python install` 的符号链接是绝对路径 → `build-engine.mjs::relativizeSymlinks()` **不能删**（否则 `bin/python3` 悬空且 electron-builder `EEXIST symlink`，构建机自检仍绿 = 假绿）。
- mac / linux 打包、安装包判据、Electron 验证命令见 archive 同名小节；改依赖后跑 `npm ci --dry-run`。
