> ⚠️ **已取代（历史存档）**：本文为早期同步设计，**内容已被 `cross-platform-sync-design.md` 吸收**。两者的约束不同（本文未限定 FastAPI、未排除 Node 方案），整合版为准。保留本文仅作设计演进痕迹，**除本横幅外不再编辑**（治理约定见 `docs/README.md` 第八节）。

实现「Web 端 + Electron 桌面端 + 同一账户数据同步」需要在 nanobot 现有本地优先架构上，增加**云端身份服务**和**双向同步引擎**。以下是完整的架构设计与实现方案。

---

## 一、总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         云端服务层                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  认证服务    │  │  同步 API   │  │  nanobot Web 实例        │  │
│  │  (OAuth2)   │  │  (REST/WS)  │  │  (Docker/容器)           │  │
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
        └────────────────────┘                     │
             直接访问云端API                        │
                                                   │
   ┌───────────────────────────────────────────────┘
   │  Electron 本地层（离线优先）
   │  ┌─────────────┐    ┌─────────────┐
   │  │ nanobot核心 │←──→│ 本地SQLite  │
   │  │ (Python)    │    │ + 文件系统   │
   │  └─────────────┘    └──────┬──────┘
   │                            │
   │                     同步引擎(后台线程)
   └───────────────────────────────────────────────┘
```

---

## 二、核心改造点

### 1. 认证层：统一身份体系

nanobot 目前无用户系统，需引入 **JWT + OAuth2**：

| 组件 | 实现 |
|------|------|
| **Web 端** | 登录页 → 认证服务 → 返回 `access_token` + `refresh_token`，存 `httpOnly cookie` 和 `localStorage` 备份 |
| **Electron** | 内置登录窗口（或外链浏览器 OAuth）→ 通过 `protocol` 回调捕获 Token → 存入系统 **Keychain**（macOS）/ **Credential Vault**（Windows）/ **Secret Service**（Linux） |
| **Token 刷新** | 双端统一使用 `refresh_token` 轮换机制，避免频繁登录 |
| **API 鉴权** | 所有同步请求携带 `Authorization: Bearer <token>` |

**Electron 安全存储示例：**
```javascript
// 使用 keytar 库存储 Token
const keytar = require('keytar');
await keytar.setPassword('nanobot', 'auth_token', jwtToken);
const token = await keytar.getPassword('nanobot', 'auth_token');
```

---

### 2. 数据层：从本地文件到「同步就绪」存储

nanobot 当前数据全部落在本地文件系统 ，需要抽象为**可版本化的实体**：

#### 数据实体映射

| 本地文件 | 抽象实体 | 云端存储 | 同步粒度 |
|---------|---------|---------|---------|
| `config.json`（用户级） | `UserConfig` | PostgreSQL JSONB | 整份覆盖 |
| `MEMORY.md` | `AgentMemory` | PostgreSQL TEXT | 块级增量（按段落） |
| `SOUL.md` | `AgentPersona` | PostgreSQL TEXT | 整份覆盖 |
| `USER.md` | `UserProfile` | PostgreSQL TEXT | 整份覆盖 |
| `sessions/<id>/history.jsonl` | `Session` + `Message[]` | PostgreSQL + S3（大文件） | 追加同步 |
| `workspace/` 文件 | `WorkspaceFile` | S3/OSS | 文件级 |

#### 本地存储改造

引入 **SQLite** 作为本地统一缓存层（nanobot 已支持 SQLite 后端 ）：

```sql
-- 本地 SQLite 增加同步元数据表
CREATE TABLE sync_metadata (
    entity_type TEXT,      -- 'session', 'memory', 'config'
    entity_id TEXT,
    local_version INTEGER, -- 本地版本号
    server_version INTEGER,-- 云端版本号
    local_modified_at TIMESTAMP,
    server_modified_at TIMESTAMP,
    sync_status TEXT,      -- 'synced', 'pending_push', 'conflict'
    checksum TEXT          -- 内容哈希
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

---

### 3. 同步引擎：离线优先 + 增量同步

这是整个方案的核心。采用 **Offline-First** 策略：所有操作先写本地，后台异步同步。

#### 同步流程

```
用户操作（发消息、改配置）
    ↓
写入本地 SQLite + 追加 sync_changelog
    ↓
触发同步（定时/网络恢复/手动）
    ↓
┌──────────────────────────────────────┐
│ 1. PUSH：读取 sync_changelog 中未推送记录 │
│    POST /api/v1/sync/push            │
│    payload: [{entity, op, data, v}]  │
└──────────────────────────────────────┘
    ↓
┌──────────────────────────────────────┐
│ 2. PULL：获取云端变更                   │
│    GET /api/v1/sync/pull?since=xxx   │
│    返回服务器端变更列表                  │
└──────────────────────────────────────┘
    ↓
┌──────────────────────────────────────┐
│ 3. 合并与冲突解决                        │
│    - 无冲突：直接应用                    │
│    - 有冲突：按策略解决                   │
└──────────────────────────────────────┘
    ↓
更新本地 sync_metadata，标记已同步
```

#### 冲突解决策略

| 数据类型 | 策略 | 说明 |
|---------|------|------|
| **会话历史** | Append-only 合并 | 消息天然按时间序，冲突时取并集排序 |
| **MEMORY.md** | 段落级 LWW | 按段落（`##` 分隔）比较 `modified_at` |
| **配置项** | Last-Write-Wins | 简单覆盖，提示用户 |
| **工作区文件** | 自动重命名 | 保留两份：`file.conflict.<device>.md` |

---

### 4. Web 端实现

Web 端是**纯云端模式**，用户打开浏览器即访问托管在服务器上的 nanobot：

```
用户浏览器
    ↓
CDN / Nginx（静态资源：WebUI）
    ↓
nanobot-gateway（云端实例，多租户改造）
    ↓
PostgreSQL（按 user_id 隔离数据）
```

**多租户改造要点：**
- nanobot 核心需增加 `user_id` 上下文注入 
- 所有数据表增加 `user_id` 字段
- Session 隔离：用户只能访问自己的 `sessions/`
- 文件存储路径：`s3://bucket/{user_id}/workspace/`

**Web 端无需同步引擎**，所有操作直接落库，天然一致。

---

### 5. Electron 端实现

Electron 端是**本地优先 + 云端同步**：

#### 架构分层

| 层级 | 职责 |
|------|------|
| **Electron 主进程** | 管理 nanobot Python 子进程、同步引擎、系统托盘、Keychain |
| **nanobot 核心（Python）** | 照常运行，操作本地 SQLite/文件，**不感知云端** |
| **同步引擎（Node.js/Python）** | 后台线程，监听变更、调用同步 API |
| **渲染进程** | 加载本地 WebUI（或远程），通过 IPC 与主进程通信 |

#### 关键实现

**主进程增加同步模块：**
```javascript
// src/sync-engine.js
class SyncEngine {
  constructor(apiClient, localDb) {
    this.api = apiClient;
    this.db = localDb;
    this.syncInterval = 30000; // 30秒
  }

  async start() {
    // 网络恢复时立即同步
    require('electron').net.on('online', () => this.sync());
    // 定时同步
    setInterval(() => this.sync(), this.syncInterval);
  }

  async sync() {
    const token = await keytar.getPassword('nanobot', 'auth_token');
    if (!token) return; // 未登录，跳过

    // 1. Push 本地变更
    const pending = await this.db.getPendingChanges();
    if (pending.length > 0) {
      await this.api.post('/sync/push', pending, { headers: { Authorization: `Bearer ${token}` } });
      await this.db.markAsPushed(pending.map(p => p.id));
    }

    // 2. Pull 云端变更
    const lastSync = await this.db.getLastSyncTime();
    const remoteChanges = await this.api.get('/sync/pull', { params: { since: lastSync }, headers: { Authorization: `Bearer ${token}` } });
    
    // 3. 应用变更到本地
    for (const change of remoteChanges) {
      await this.applyChange(change);
    }
    
    await this.db.updateLastSyncTime(new Date().toISOString());
  }
}
```

**登录状态桥接：**
```javascript
// preload.js
contextBridge.exposeInMainWorld('syncAPI', {
  getLoginStatus: () => ipcRenderer.invoke('sync:get-login-status'),
  login: () => ipcRenderer.invoke('sync:login'), // 打开 OAuth 窗口
  logout: () => ipcRenderer.invoke('sync:logout'),
  forceSync: () => ipcRenderer.invoke('sync:force-sync'),
  onSyncStatus: (cb) => ipcRenderer.on('sync:status', cb)
});
```

---

### 6. 实时同步增强（可选）

对于「Web 端和 Electron 端同时在线」的场景，可加入 **WebSocket 实时推送**：

```
云端 PostgreSQL → WAL/Trigger → 消息队列 (Redis/RabbitMQ)
                                    ↓
                           WebSocket Gateway
                                    ↓
                    ┌───────────────┼───────────────┐
                   Web           Electron         其他端
```

- 一端产生变更 → 云端广播 → 其他端立即拉取增量
- Electron 端收到 WS 推送 → 调用 `syncEngine.sync()` → UI 实时刷新

---

## 三、数据安全与隐私

| 措施 | 实现 |
|------|------|
| **传输加密** | 全站 HTTPS/WSS，TLS 1.3 |
| **敏感配置加密** | API Key 等字段本地 AES-256 加密后再上传 |
| **端到端加密（可选）** | 用户可开启：数据在客户端加密，云端只存密文 |
| **设备授权** | 新设备登录需邮件/二次确认，支持撤销设备 |
| **数据主权** | 提供「导出全部数据」和「彻底删除账户」功能 |

---

## 四、实施路线图

| 阶段 | 任务 | 预估工作量 |
|------|------|-----------|
| **Phase 1** | 搭建云端认证服务（OAuth2 + JWT），改造 nanobot 核心支持 `user_id` 隔离 | 2-3 周 |
| **Phase 2** | 设计同步协议（实体抽象、版本号、changelog），实现云端 Sync API | 2 周 |
| **Phase 3** | Electron 端集成：本地 SQLite 改造 + 同步引擎 + Keychain 存储 | 2 周 |
| **Phase 4** | Web 端部署：多租户 nanobot-gateway + 云端 PostgreSQL | 1-2 周 |
| **Phase 5** | 冲突解决 UI、离线提示、实时 WS 推送、数据加密 | 2 周 |

---

## 五、关键代码结构预览

```
nanowork-cloud/
├── auth/                  # OAuth2 + JWT 服务
├── sync/
│   ├── api.py             # /sync/push, /sync/pull
│   ├── merger.py          # 冲突解决算法
│   └── models.py          # 同步实体定义
└── web/
    └── gateway.py         # 多租户 gateway 入口

nanowork-desktop/
├── src/
│   ├── main.js            # Electron 主进程
│   ├── sync-engine.js     # 同步引擎
│   ├── auth-manager.js    # Token 管理 + Keychain
│   └── preload.js
└── python/
    └── nanobot-core/      # 内嵌的 nanobot（SQLite 模式）

nanowork-web/
├── src/
│   ├── api/client.ts      # 云端 API 客户端
│   └── stores/sync.ts     # 同步状态管理
```

---

## 总结

实现跨端同步的核心是**三层解耦**：

1. **认证解耦**：JWT + 系统级安全存储，Web 用 Cookie、Electron 用 Keychain
2. **存储解耦**：本地 SQLite（缓存/离线）+ 云端 PostgreSQL（权威/多设备），通过 `sync_changelog` 桥接
3. **运行时解耦**：Web 端直连云端，Electron 端本地运行 nanobot + 后台同步引擎

nanobot 现有的 SQLite/PostgreSQL 双后端支持  和文件化记忆设计  为这套方案提供了良好基础——你只需在之上增加版本号、变更日志和同步协议即可。