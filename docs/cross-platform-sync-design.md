# 跨端 Agent 同步 · 详细设计文档（整合版）

> 本文档整合 `user-sync-login.md` 与 `cloud-sync-design.md`，给出在 nanobot 现有「本地优先（local-first）」架构上，
> 增加**云端身份服务**与**双向同步引擎**，实现 **Web 端 + Electron 桌面端（及未来移动端）同一账户数据同步**的完整设计。
> 本文档为设计文档，不含实现代码（仅含示意）。

---

## 1. 背景与目标

### 1.1 现状（根因）
`agentsStore` 等使用 zustand `persist`，底层走 `platform.storage`：

- **Electron**：`ElectronStorageAdapter` → `window.electronAPI` IPC → 主进程写 `userData/nanowork-store.json`
- **Web**：`WebStorageAdapter` → 浏览器 `localStorage`

两端是**相互隔离的存储后端**，没有共享数据源，因此在 Electron 新建的 Agent 不会出现在 Web。

### 1.2 目标
1. 同一账户在任意端登录后，数据双向一致。
2. 离线可用：无网络时本地照常工作，联网后自动合并。
3. 冲突可控：多人/多端并发编辑有明确、可预测的解决规则。
4. 最小侵入：复用现有 `platform.storage` 作为本地缓存，不推翻渲染层。

### 1.3 非目标
- 不做实时协同编辑（同一实体的多人同时打字）。
- 不引入 CRDT（MVP 用 LWW，后续可升级）。
- 云端服务采用**自托管 Python(FastAPI) 服务**：复用现有 Python 工具链（nanobot 已是 Python），**不引入 Node**，**暂不依赖 nanowork 既有后端**（当前不存在）。

---

## 2. 设计原则

| 原则 | 说明 |
|---|---|
| Local-first | 本地存储是事实源之一，所有读操作本地完成；同步是后台尽力而为 |
| Account-scoped | 云端按账户隔离命名空间，数据与 token 不跨账户 |
| LWW MVP | 每实体以 `updatedAt` 最后写入获胜；tombstone 处理删除 |
| Append-only 同步日志 | 以 cursor/水印拉增量，避免全量比对 |
| 三层解耦 | 认证解耦、存储解耦、运行时解耦（详见第 14 节） |
| 最小侵入 | `SyncEngine` 包裹现有 store，store 动作只多调一次 `markDirty` |

---

## 3. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         云端服务层                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  认证服务    │  │  同步 API   │  │  nanobot Web 实例        │  │
│  │ (邮箱+密码/JWT)│ │  (REST/WS)  │  │ (Docker/容器，按账户隔离) │  │
│  └─────────────┘  └──────┬──────┘  └───────────┬─────────────┘  │
│                          │                     │                │
│              ┌───────────┴─────────────────────┘                │
│              │         PostgreSQL + S3/OSS                      │
│              └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              ↑ HTTPS/WSS
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
   │  浏览器  │          │ Electron │          │  移动端  │
   │ (WebUI) │          │ 桌面端   │          │ (未来)  │
   └────┬────┘          └────┬────┘          └────┬────┘
        │                    │                     │
        │   共享 React 渲染层（src/）+ SyncEngine   │
        └────────────────────┘                     │
             直接访问云端 API                        │
                                                   │
   ┌───────────────────────────────────────────────┘
   │  Electron 本地层（离线优先）
   │  ┌─────────────┐    ┌─────────────┐
   │  │ nanobot核心 │←──→│ 本地 SQLite │
   │  │ (Python)    │    │ + 文件系统   │
   │  └─────────────┘    └──────┬──────┘
   │                            │
   │                     同步引擎(后台线程)
   └───────────────────────────────────────────────┘
```

> **云端服务运行栈（已定）**：云端服务层为单一 **Python(FastAPI + uvicorn)** 进程，承载认证（`/api/auth/*`）与同步（`/api/sync/push`、`/api/sync/pull`），后端用 PostgreSQL（生产）/ SQLite（本地开发）。**不引入 Node，不依赖 nanowork 既有后端**。Electron 与 Web 均通过 HTTPS 直连该服务；本地开发时由 `uvicorn` 拉起，生产以容器/常驻进程部署。

### 两种部署形态
- **(a) SPA + SyncEngine 直连 Sync API（当前架构）**：Web 与 Electron 共用同一份 React 渲染层（`src/`），两者都内置 `SyncEngine`，登录后通过 Sync API 与云端对齐。
- **(b) 托管多租户 nanobot-gateway（未来）**：云端部署 nanobot 实例，Web 端「纯云端模式」直接落库、天然一致；Electron 仍走本地优先 + 后台同步引擎。二者可并存，Sync API 是统一契约。

---

## 4. 数据模型

### 4.1 实体映射（本地 → 抽象实体 → 云端 → 同步粒度）
| 本地文件 | 抽象实体 | 云端存储 | 同步粒度 |
|---------|---------|---------|---------|
| `config.json`（用户级） | `UserConfig` | PostgreSQL JSONB | 整份覆盖 |
| `MEMORY.md` | `AgentMemory` | PostgreSQL TEXT | 块级增量（按段落） |
| `SOUL.md` | `AgentPersona` | PostgreSQL TEXT | 整份覆盖 |
| `USER.md` | `UserProfile` | PostgreSQL TEXT | 整份覆盖 |
| `sessions/<id>/history.jsonl` | `Session` + `Message[]` | PostgreSQL + S3（大文件） | 追加同步 |
| `workspace/` 文件 | `WorkspaceFile` | S3/OSS | 文件级 |

> 对当前 React 渲染层的 store，可同步集合为：`agents`、`sessions`、`settings`、`memory`、`artifacts`（见 4.4）。

### 4.2 通用同步元数据（所有可同步实体共有）
```ts
interface SyncMeta {
  id: string;          // 全局唯一（uuid），创建端生成
  rev: number;         // 该实体版本号，每次本地修改 +1
  updatedAt: string;   // ISO8601，合并裁决依据（LWW）
  deletedAt: string | null; // 软删 tombstone；非 null 表示已删除
  updatedBy: string;   // 账户 id，便于审计/排查
}
```

### 4.3 本地 SQLite 同步表（本地统一缓存层）
nanobot 已支持 SQLite 后端，引入同步元数据表与变更日志：
```sql
-- 本地同步元数据
CREATE TABLE sync_metadata (
    entity_type TEXT,      -- 'session', 'memory', 'config', 'agent'...
    entity_id TEXT,
    local_version INTEGER,
    server_version INTEGER,
    local_modified_at TIMESTAMP,
    server_modified_at TIMESTAMP,
    sync_status TEXT,      -- 'synced', 'pending_push', 'conflict'
    checksum TEXT
);

-- 变更日志（Change Log）
CREATE TABLE sync_changelog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT,
    entity_id TEXT,
    operation TEXT,        -- 'create', 'update', 'delete'
    payload BLOB,          -- 变更内容（JSON）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    pushed_at TIMESTAMP    -- 空表示未推送
);
```

### 4.4 同步集合（collections，对应 React store）
| 集合 | 实体 | 关键字段（示例） |
|---|---|---|
| `agents` | Agent | `name, systemPrompt, model, tools[], avatar?` |
| `sessions` | Session | `title, agentId, messages[], createdAt` |
| `settings` | Settings | `gatewayEndpoint, mode, theme, memoryEnabled`（单例，固定 `id=local`） |
| `memory` | MemoryEntry | `workspaceKey, content, tags[]` |
| `artifacts` | Artifact | `sessionId, type, payload` |

---

## 5. 云端身份服务

### 5.1 认证方案
nanobot 目前无用户系统，需引入 **JWT 认证**。**MVP 先用邮箱+密码登录**，OAuth2 第三方登录作为后续可扩展项（非本期范围）：

| 组件 | 实现 |
|------|------|
| **Web 端** | 登录页 → 认证服务 → 返回 `access_token` + `refresh_token`，存 `httpOnly cookie` 和 `localStorage` 备份 |
| **Electron** | 内置登录窗口（邮箱+密码表单）→ 登录后 Token 存入系统 **Keychain**（macOS）/ **Credential Vault**（Windows）/ **Secret Service**（Linux） |
| **Token 刷新** | 双端统一使用 `refresh_token` 轮换机制，避免频繁登录 |
| **API 鉴权** | 所有同步请求携带 `Authorization: Bearer <token>` |

### 5.2 端点
```
POST /api/auth/register   { email, password }                -> { userId, accessToken, refreshToken }
POST /api/auth/login      { email, password }                -> { userId, accessToken, refreshToken }
POST /api/auth/refresh    { refreshToken }                   -> { accessToken }
POST /api/auth/logout     { refreshToken }                   -> { ok }
GET  /api/auth/me         (Authorization: Bearer <access>)   -> { userId, email }
```

### 5.3 Token 安全存储
**Electron（系统钥匙串）：**
```javascript
// 使用 keytar 库存储 Token
const keytar = require('keytar');
await keytar.setPassword('nanobot', 'auth_token', jwtToken);
const token = await keytar.getPassword('nanobot', 'auth_token');
```
（亦可用 Electron `safeStorage` 加密后落盘。）

**Web：** `accessToken` 放内存；`refreshToken` 放 httpOnly + Secure + SameSite Cookie，防 XSS 窃取。

### 5.4 登录态在各端
- 未登录：`SyncEngine` 关闭，纯本地（local-first 兜底）。
- 已登录：`SyncEngine` 启用 push/pull；UI 显示同步状态。

---

## 6. 同步 API

### 6.1 Pull（拉增量）
```
GET /api/sync/pull?since=<cursor>
Authorization: Bearer <access>

响应 200:
{
  "cursor": "1692...Z",          // 服务端当前水位，下次 pull 作为 since
  "changes": [
    { "collection": "agents", "entity": { ...SyncMeta, "name": "..." } },
    { "collection": "agents", "entity": { ...SyncMeta, "deletedAt": "1692..." } }
  ]
}
```
- `cursor` 由服务端基于 `updatedAt` 单调递增生成（如版本号或时间戳+序号）。
- 仅返回 `updatedAt > since` 的实体（含 tombstone）。

### 6.2 Push（推批量）
```
POST /api/sync/push
Authorization: Bearer <access>
Content-Type: application/json

{
  "changes": [
    { "collection": "agents", "entity": { ...SyncMeta, "name": "牧场助手" } }
  ]
}

响应 200:
{
  "accepted": [ "id-1" ],
  "conflicts": [
    { "id": "id-2", "server": { ... }, "client": { ... }, "resolution": "server" }
  ]
}
```
- 服务端逐实体校验：若 `client.rev <= server.rev` 且 `client.updatedAt < server.updatedAt` → 视为冲突，按 LWW 取服务端版本（返回 conflict 供客户端提示）。
- 否则以客户端版本覆盖，bump 服务端 `rev`、回写 `updatedAt`。

### 6.3 cursor / 水印
- pull 用 `since=cursor` 增量获取；push 不携带 cursor，由服务端按 `rev/updatedAt` 裁决。
- 冲突时服务端以「接收时间」归一 `updatedAt`，规避多端时钟漂移。

---

## 7. 冲突解决策略

### 7.1 通用 LWW 规则（MVP）
对同一个 `id`：
1. 比较 `updatedAt`（ISO8601 可直接比较）：**较大者获胜**。
2. 若相等，比较 `rev`：较大者获胜。
3. 仍相等，比较 `id` 字典序（确定性 tie-break）。

### 7.2 分类型策略
| 数据类型 | 策略 | 说明 |
|---------|------|------|
| **会话历史** | Append-only 合并 | 消息天然按时间序，冲突时取并集排序 |
| **MEMORY.md** | 段落级 LWW | 按段落（`##` 分隔）比较 `modified_at` |
| **配置项** | Last-Write-Wins | 简单覆盖，提示用户 |
| **工作区文件** | 自动重命名 | 保留两份：`file.conflict.<device>.md` |
| **Agent / 通用实体** | 实体级 LWW | 按 7.1 规则整条覆盖 |

### 7.3 删除与 tombstone
- 删除 = 写 `deletedAt` 并 bump `rev/updatedAt`（软删，非物理删除）。
- 合并时：若一方 `deletedAt` 非空且 `updatedAt` 更大 → 最终为删除。
- tombstone 保留 **30 天**（已定）后由服务端 GC，防止复活。

### 7.4 未来升级
- 字段级合并（如同时改 `name` 与 `systemPrompt`）可升级为 CRDT / 字段级 LWW。

---

## 8. 客户端同步引擎（SyncEngine）

### 8.1 模块划分
```
src/sync/
  SyncClient.ts        // HTTP 封装：鉴权、pull、push、refresh
  SyncEngine.ts        // 单集合引擎：outbox、merge、调度
  syncRegistry.ts     // 注册各 store 的 getter/setter，供引擎读写
  useSyncStatus.ts     // 同步状态（local/syncing/synced/conflict）供 Banner 订阅
```

### 8.2 状态机
```
local ──login──▶ syncing ──ok──▶ synced
  ▲                │  │            │
  │              err│  └─conflict─▶ conflict（toast）
  │                ▼               │
  └─────logout──── offline ◀───────┘
```
- `syncing`：有 outbox 或正在 pull。
- `synced`：最近一次 push/pull 成功且无 pending。
- `conflict`：最近一次出现 LWW 冲突，提示用户。

### 8.3 离线优先同步流程
```
用户操作（发消息、改配置）
    ↓
写入本地 SQLite + 追加 sync_changelog
    ↓
触发同步（定时/网络恢复/手动）
    ↓
┌──────────────────────────────────────┐
│ 1. PUSH：读取 sync_changelog 中未推送记录 │
│    POST /api/sync/push               │
└──────────────────────────────────────┘
    ↓
┌──────────────────────────────────────┐
│ 2. PULL：GET /api/sync/pull?since=xxx │
│    返回服务器端变更列表                │
└──────────────────────────────────────┘
    ↓
┌──────────────────────────────────────┐
│ 3. 合并与冲突解决（见第 7 节）          │
└──────────────────────────────────────┘
    ↓
更新本地 sync_metadata，标记已同步
```

### 8.4 push / pull 触发时机
- store 动作后调用 `engine.markDirty(collection, id)` → 写入内存 outbox。
- 防抖（如 500ms）后批量 `POST /api/sync/push`；定时（如 30s）兜底。
- 登录后立即 pull 一次；定时器 + 浏览器 `online`/`focus` 事件触发即时 pull。
- Electron 可监听 `electron.net` 的 `online` 事件立即同步。

### 8.5 合并流程（客户端收到 pull changes）
```
for each change:
  local = store.get(collection, change.id)
  if local == null:                       -> 直接采用 change
  else if change.deletedAt && LWW(change, local)==change: -> 本地删除
  else if LWW(change, local) == change:   -> 本地覆盖（bump rev）
  else:                                   -> 丢弃（本地较新，等下次 push）
  更新 cursor
```

### 8.6 Electron 端实现
| 层级 | 职责 |
|------|------|
| **Electron 主进程** | 管理 nanobot Python 子进程、同步引擎、系统托盘、Keychain |
| **nanobot 核心（Python）** | 照常运行，操作本地 SQLite/文件，**不感知云端** |
| **同步引擎（Electron 主进程 / TypeScript）** | 桌面端后台引擎，监听变更、调用云端同步 API（与云端 FastAPI 服务无关） |
| **渲染进程** | 加载本地 WebUI（或远程），通过 IPC 与主进程通信 |

**主进程同步模块示意：**
```javascript
// src/sync-engine.js
class SyncEngine {
  constructor(apiClient, localDb) {
    this.api = apiClient;
    this.db = localDb;
    this.syncInterval = 30000; // 30秒
  }
  async start() {
    require('electron').net.on('online', () => this.sync());
    setInterval(() => this.sync(), this.syncInterval);
  }
  async sync() {
    const token = await keytar.getPassword('nanobot', 'auth_token');
    if (!token) return; // 未登录，跳过
    const pending = await this.db.getPendingChanges();
    if (pending.length > 0) {
      await this.api.post('/sync/push', pending, { headers: { Authorization: `Bearer ${token}` } });
      await this.db.markAsPushed(pending.map(p => p.id));
    }
    const lastSync = await this.db.getLastSyncTime();
    const remoteChanges = await this.api.get('/sync/pull', { params: { since: lastSync }, headers: { Authorization: `Bearer ${token}` } });
    for (const change of remoteChanges) await this.applyChange(change);
    await this.db.updateLastSyncTime(new Date().toISOString());
  }
}
```

**登录状态桥接（preload）：**
```javascript
// preload.js
contextBridge.exposeInMainWorld('syncAPI', {
  getLoginStatus: () => ipcRenderer.invoke('sync:get-login-status'),
  login: () => ipcRenderer.invoke('sync:login'),
  logout: () => ipcRenderer.invoke('sync:logout'),
  forceSync: () => ipcRenderer.invoke('sync:force-sync'),
  onSyncStatus: (cb) => ipcRenderer.on('sync:status', cb)
});
```

### 8.7 Web 端实现
- **共享 SPA 形态（当前）**：Web 与 Electron 共用 `src/`，同样内置 `SyncEngine`，登录后通过 Sync API 与云端对齐，离线可用、在线合并。
- **托管多租户 gateway 形态（未来）**：云端部署 nanobot 实例，Web 直连云端 PostgreSQL（按 `user_id` 隔离），天然一致、无需客户端同步引擎。多租户要点：
  - nanobot 核心注入 `user_id` 上下文；所有数据表增加 `user_id` 字段；
  - Session 隔离：用户只能访问自己的 `sessions/`；
  - 文件存储路径：`s3://bucket/{user_id}/workspace/`。

---

## 9. 实时同步增强（可选）
对于「Web 端和 Electron 端同时在线」的场景，可加入 **WebSocket 实时推送**：
```
云端 PostgreSQL → WAL/Trigger → 消息队列 (Redis/RabbitMQ)
                                    ↓
                           WebSocket Gateway
                                    ↓
                    ┌───────────────┼───────────────┐
                   Web           Electron         其他端
```
- 一端产生变更 → 云端广播 → 其他端立即拉取增量。
- Electron 端收到 WS 推送 → 调用 `syncEngine.sync()` → UI 实时刷新。

---

## 10. 数据安全与隐私
| 措施 | 实现 |
|------|------|
| **传输加密** | 全站 HTTPS/WSS，TLS 1.3（本地开发 `http://127.0.0.1` 例外） |
| **敏感配置加密** | API Key 等字段本地 AES-256 加密后再上传；**不进同步集合**（仅留本地） |
| **端到端加密（可选）** | 用户可开启：数据在客户端加密，云端只存密文 |
| **设备授权** | 新设备登录需邮件/二次确认，支持撤销设备 |
| **数据主权** | 提供「导出全部数据」和「彻底删除账户」功能 |
| **多租户隔离** | 所有同步查询强制带 `userId` 过滤，防越权 |
| **审计** | 实体带 `updatedBy`，便于排查异常覆盖 |

---

## 11. 迁移方案
- **首次登录**：本地存量一次性 `POST /api/sync/push`（作为 changes），云端 LWW 合并。
- **字段补齐**：旧本地数据缺 `rev/updatedAt` 时，引擎在 `markDirty` 补默认值（`rev=1`，`updatedAt=now`）。
- **回退**：登出后本地数据保留，可继续离线使用；重新登录再次合并。

---

## 12. 实施路线图
| 阶段 | 任务 | 预估工作量 |
|------|------|-----------|
| **Phase 1** | 搭建 Python(FastAPI) 云端认证服务（JWT，邮箱+密码起步），数据按 `user_id` 隔离 | 2-3 周 |
| **Phase 2** | 设计同步协议（实体抽象、版本号、changelog），实现云端 Sync API（pull/push） | 2 周 |
| **Phase 3** | Electron 端集成：本地 SQLite 改造 + 同步引擎 + Keychain 存储 | 2 周 |
| **Phase 4** | Web 端部署：共享 SPA 接入 SyncEngine / 多租户 nanobot-gateway + 云端 PostgreSQL | 1-2 周 |
| **Phase 5** | 冲突解决 UI、离线提示、实时 WS 推送、数据加密 | 2 周 |

---

## 13. 代码结构预览
```
nanowork-cloud/
├── auth/                  # 邮箱+密码 + JWT 服务（OAuth2 后续可选）
├── sync/
│   ├── api.py             # /sync/push, /sync/pull
│   ├── merger.py          # 冲突解决算法
│   └── models.py          # 同步实体定义
└── web/
    └── gateway.py         # 多租户 gateway 入口

nanowork-desktop/
├── src/
│   ├── main.ts            # Electron 主进程
│   ├── sync-engine.ts     # 同步引擎
│   ├── auth-manager.ts    # Token 管理 + Keychain
│   └── preload.ts
└── python/
    └── nanobot-core/      # 内嵌的 nanobot（SQLite 模式）

nanowork-web/    # 与 desktop 共用 src/ 渲染层
└── src/
    ├── api/client.ts      # 云端 API 客户端
    └── stores/sync.ts     # 同步状态管理
```

---

## 14. 三层解耦（核心思想）
1. **认证解耦**：JWT + 系统级安全存储，Web 用 Cookie、Electron 用 Keychain。
2. **存储解耦**：本地 SQLite（缓存/离线）+ 云端 PostgreSQL（权威/多设备），通过 `sync_changelog` 桥接。
3. **运行时解耦**：Web 端直连云端，Electron 端本地运行 nanobot + 后台同步引擎。

nanobot 现有的 SQLite/PostgreSQL 双后端支持与文件化记忆设计为这套方案提供了良好基础——只需在之上增加版本号、变更日志和同步协议即可。

---

## 15. 风险与后续
| 风险 | 缓解 |
|---|---|
| LWW 误覆盖他人编辑 | 冲突 toast + 保留 `client` 快照，可手动还原 |
| 大集合拉取慢 | cursor 增量 + 集合分片 + 服务端分页 |
| 云端不可用 | local-first 兜底，状态显示 offline |
| 多端时钟不同步 | `updatedAt` 以服务端接收时间为准做归一（push 时服务端重算） |

后续可演进：WebSocket 实时、字段级 CRDT、团队空间（多账户共享 Agent）。

---

## 16. 决策记录（开放问题已全部确认）
1. ~~云端服务是自托管最小 Node 服务，还是复用 nanowork 既有后端？~~ **已定**：自托管 **Python(FastAPI)** 服务，复用现有 Python 工具链，**不引入 Node**，**不依赖 nanowork 既有后端**（当前不存在）。
2. ~~`settings` 是否纳入同步（含内网 `gatewayEndpoint`，需脱敏）？~~ **已定**：**settings 纳入同步**；但 `gatewayEndpoint`、本地路径等**机器专属字段排除在同步负载之外**（本地专属，不下发云端、不跨设备覆盖），仅同步用户偏好类字段；接收端对未知/本地专属字段保留本地值。
3. ~~是否需要「团队/共享 Agent」能力（多账户可见）？~~ **已定**：本期**仅做个人账户**，不做「团队/共享 Agent」（多账户可见）能力；云端的「多租户」仅指按 `user_id` 隔离不同个人用户的数据，不含团队空间。
4. ~~tombstone GC 保留时长（建议 30 天）。~~ **已定**：tombstone GC 保留时长 = **30 天**（软删记录保留 30 天后由后端定时清理）。
5. ~~采用 OAuth2 第三方登录，还是先只做邮箱+密码（JWT）？~~ **已定**：MVP 先用**邮箱+密码 + JWT** 登录；OAuth2 第三方登录作为后续扩展（非本期范围）。
6. ~~云端服务部署形态：独立容器/常驻进程由谁托管？~~ **已定**：本地开发先用 `uvicorn` 单机跑通（`uvicorn app.main:app --reload --port 8910`）；生产部署形态（容器/常驻进程托管方）留待后续确定，不在本期范围。

### 已记录决策（尚未实现）
- **本期暂不写代码，仅保留本设计文档。**
- 云端服务对象：**Python(FastAPI)**，不引入 Node、不依赖 nanowork（见第 1.3 节、架构图后说明、路线图 Phase 1）。
- Phase 1 同步 API 深度：**做真实可跑通的 `push`/`pull`（基于 `sync_items` 表 + LWW 合并），不做 stub**；身份服务**已定先用邮箱+密码 + JWT**（OAuth2 第三方登录作为后续扩展，非本期）。
- **本期仅做个人账户**：不做「团队/共享 Agent」（多账户可见）能力；云端「多租户」仅指按 `user_id` 隔离不同个人用户的数据，不含团队空间（团队空间列为后续演进，见第 15 节）。
- 落地顺序仍建议 **Phase 0（数据版本化 `SyncMeta`）+ Phase 1（FastAPI 认证骨架 + 真实 push/pull）**，开工时参照第 12 节路线图。
- **本地开发部署形态已定**：先用 `uvicorn app.main:app --reload --port 8910` 单机跑通；生产部署（容器/常驻进程托管方）留待后续，不在本期范围。
- **settings 纳入同步**：仅同步用户偏好类字段；`gatewayEndpoint`、本地路径等机器专属字段排除在同步负载之外，接收端对本地专属字段保留本地值（解决内网配置脱敏顾虑）。
- **tombstone GC 保留时长 = 30 天**：软删记录保留 30 天后由后端定时清理。
- **至此第 16 节 6 条开放问题已全部确认为已定决策**，设计文档进入可实施状态（本期仍仅保留文档、暂不写代码）。
