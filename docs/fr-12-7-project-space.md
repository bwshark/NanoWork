# FR-12.7 项目空间：服务端落地记录与客户端计划

> **状态**：服务端 + 客户端 + **任务/会话/产物的项目归属**已落（2026-10-31）。
> **需求出处**：`docs/nanowork-prd-design-v2.md` 第 3 章 `FR-12.7`（P2，M7）。
> **本文用途**：记清楚「哪些边界刻意没写成新判定」与「客户端为什么这么接」，避免下一轮把同一个坑再踩一遍。

---

## 一、服务端已落（`cloud/app/projects/`）

### 1.1 三张表

| 表 | 主键 | 说明 |
|---|---|---|
| `projects` | `id` | `org_id` / `name` / `description` / `created_by` / `archived_at`（**空串 = 活**） |
| `project_members` | `(project_id, user_id)` | 冗余 `org_id`；`role` ∈ `lead` / `member` |
| `project_kbs` | `(project_id, kb_id)` | 冗余 `org_id`；**只是入口，不是授权** |

`archived_at` 用空串而不是 NULL：`== ""` 与 `IS NULL` 在两套数据库上都要写两遍判断，迟早漏一处。
三张表都由 `create_all` 新建（不改老表），因此**不需要**动 `migrations.py::ADDED_COLUMNS`。

### 1.2 端点（9 个）

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/orgs/{org_id}/projects?includeArchived=` | 组织成员 |
| POST | `/api/orgs/{org_id}/projects` | 组织成员（创建者自动 `lead`） |
| GET | `/api/projects/{id}` | 组织成员 |
| PATCH | `/api/projects/{id}` | `lead` 或组织 admin |
| DELETE | `/api/projects/{id}` | **组织 admin**（破坏性，不给 lead） |
| POST | `/api/projects/{id}/members` | `lead` 或组织 admin |
| DELETE | `/api/projects/{id}/members/{user_id}` | 同上 |
| POST | `/api/projects/{id}/kbs` | 同上 + **调用者必须能读那本库** |
| DELETE | `/api/projects/{id}/kbs/{kb_id}` | `lead` 或组织 admin |

非组织成员一律 **404**（403 等于确认「项目存在，只是你没权限」，而 id 可枚举）。

### 1.3 三条边界（本模块存在的理由）

1. **项目不参与可见性判定**。详情里的库必须同时满足「被关联」与「我看得到」（`visible_kb_ids()`）。
   少这一层，`project_kbs` 就是绕过 `visibility.allows()` 的第二条通路 —— 症状是
   「团队视图里看不到、项目页却露出标题与文档数」，正是个人知识库那一轮踩过的组合漏洞。
2. **项目不能成为邀请旁路**。加人时目标必须是**本组织成员**，否则 409。
   否则任何 `lead` 都能把外部账号拉进项目，再从项目侧接触组织资料。
3. **加库要先过读权限**。「把我看不到的库加进项目」这个动作本身就在确认该 id 存在
   （哪怕列表会过滤），所以 403 发生在写入前，而不是列表渲染时。

### 1.4 判据

`cloud/tests/test_projects.py`（9 例）。两条核心用例与上面第 1、3 条一一对应：

- `test_project_kb_list_hides_invisible_kb` —— 组织 admin 把「只给管理员」的库加进项目后，
  **普通成员的项目详情里 `kbs` 为空、`kbCount` 为 0**；admin 自己看得到。
- `test_lead_cannot_add_kb_they_cannot_read` —— 普通成员作为项目 `lead` 加管理员专用库 → **403**。

其余：创建者即 lead / 非成员 404（列表·详情·PATCH 三处）/ 普通成员可看不可管 /
加非组织成员 409 / 重复加入 409 / 跨组织库 404 / 归档隐藏与恢复 / 删项目连带清关联。

---

## 二、客户端（首版已落，2026-10-31）

### 2.1 共用件：401 换票只有一份实现

`src/lib/net/authedRequest.ts` 是**唯一**的「带票请求」实现：实时取票（`getToken` 优先于
`token` 快照）、401 换票重放一次、网络失败给 `status: 0`。
`src/lib/kb/kbClient.ts` 的 `request()` 已改为**一层薄委托**（原来那 90 行实现删除），
`src/lib/project/projectClient.ts` 直接调它。

⚠️ 不要在任何一个客户端里再写一份：两份 401 行为出现的症状是「知识库页正常、项目页停在
未登录」，而两边日志都干净。

**验收方式**：把 `authedRequest` 里的 `if (response.status === 401 && ...)` 改成
`if (false && ...)`，`tests/lib/project/projectClient.test.ts` 的「刷新成功后用新票重放一次」
立刻变红（已实测），说明项目侧真的走的是共用件而不是自己的实现。

### 2.2 装配与页面

| 文件 | 作用 |
|---|---|
| `src/sync/projectGateway.ts` | 装配（与 `kbGateway.ts` 同构；无登录态返回 `null`） |
| `src/lib/project/projectClient.ts` | 9 个方法与类型；id 一律 `encodeURIComponent` |
| `src/pages/projects/ProjectsPage.tsx` | `/projects`：左列表 + 右详情 |
| `src/lib/core/constants.ts` / `router/index.tsx` / `layout/SidebarNav.tsx` | 路由与侧栏「项目」（知识库下方） |

界面上的四条口径：

- **只读 / 可管只认 `canManage`**。不在前端重算「我是不是 lead」——那是第二套规则。
- **删除入口比 `canManage` 更严**：只有组织 `admin`/`owner` 才显示（服务端就是这么判的），
  且要点两次（无对话框的确认，避免误删硬删）。
- **加人候选来自本组织成员**（`kb.listMembers(orgId)`，已加入的排除），不是让人盲填邮箱；
  服务端仍会再校验一次（409 的两种语义原样提示）。
- **看板与产物写「尚未接入」**，不写「0 个任务」——后者会被读成「项目里真的没有任务」。

### 2.3 判据

- `tests/lib/project/projectClient.test.ts`（9 例）：路径编码 / `includeArchived` /
  404 与 409 文案透传 / 204 不解析响应体 / **401 换票重放** / `canManage` 原样透传。
- `tests/projectsPage.test.tsx`（4 例）：未登录明说去登录（不是空列表）/ `canManage=false`
  时**不渲染**加人与加库 / `canManage=true` 时入口都在且候选只来自组织成员、已加入不重复 /
  「含归档」默认不带、点开才带。

### 2.4 项目归属（2026-10-31 同批落地）

**三个实体，两种归属方式** —— 这个区别是刻意的：

| 实体 | 怎么归属 | 为什么 |
|---|---|---|
| `Session` | 自己存 `projectId` | 用户直接选的；进 `SESSION_SYNC_FIELDS` 白名单（声明，跨设备成立） |
| `TaskConfig` | 自己存 `projectId` | 任务可以不属于任何会话；**不参与引擎下发**，改它不重启网关 |
| 产物 | **派生**：产物 → 会话 → 项目 | ⛔ 不在产物上冗余存：会话移到别的项目时那份快照会留在原地，「项目 A 还挂着已属于 B 的文件」而**不报错** |

派生实现是 `src/lib/project/projectScope.ts` 的三个纯函数（`sessionsOfProject` /
`tasksOfProject` / `artifactsOfProject`）+ `projectExists`（悬空引用判据）。

**两条边界**：会话被删 → 它的产物从项目里消失（会话没了就不再是「这个项目的工作成果」）；
项目被删 → 会话/任务上的 `projectId` **不自动清空**（清理要在删除时批量改写本机数据，而删除是
服务端动作、本机可能离线）→ 界面按「项目已不存在」渲染，**不凭字符串反推项目名**。

判据：`tests/lib/project/projectScope.test.ts`（12 例，含一条反向护栏：在产物上故意塞一个
指向别的项目的 `projectId`，派生投影必须无视它）+ `tests/projectsPage.test.tsx` 第 5 例
（只有归属本项目的会话/任务出现，另一条必须不出现，且页面不再出现「尚未接入」）。
两处变异都精确变红后还原（`cmp` 校验字节一致）：去掉会话归属过滤 / 产物不按会话收窄。

`tests/projectsPage.test.tsx` 共 11 例。除新建入口三例外，移进/移出四例：会话移入后真的写进
`projectId` **且 `rev` 涨了**（不涨就同步不过去）、移出清成 `undefined`（写空串会红）、
任务移入同款、候选列表**不含已属于别的项目的条目**。
变异（4 处，均精确变红后 `cmp` 校验还原）：去掉会话归属过滤 / 产物不按会话收窄 /
移出写成空串 / 候选不排除已归属。

### 2.5 项目内新建入口（2026-10-31 同批落地）

项目详情头部两个按钮：「新建会话」「新建任务」。可见性走 `canContribute`
= `myRole !== '' || 组织 admin/owner` —— 不是权限校验（数据在本机，前端拦不住也不必拦），
而是**别提供做不了的动作**：没加入项目的组织成员在这里点新建，成果会出现在别人的项目看板里。

**`projectId` 只有一个来源**：`createTaskInProject` 提交时写一次，`TaskFormDialog` 的
`initial` **刻意不带**它。⚠️ 这条是变异验证发现的：两处都写时，拆掉任意一处用例都不红
（另一处在兜底）—— 看似更稳，实际让「归属从哪来」变成两个来源。收成一处后，拆掉它用例必红。

会话走 `createSession(undefined, '新会话', { projectId })`：先建再跳页（`createSession`
会把新会话设为 active，聊天页打开时落在它上面；反过来会先看到旧会话闪一下）。

### 2.6 移进 / 移出项目（2026-10-31 同批落地）

项目页每个任务 / 会话行带「移出」，区块底部带「把已有任务/会话移进来」。

**候选只列「未归属任何项目」的条目**：已属于别的项目的是「跨项目搬移」，
涉及对面项目成员要不要知道，是另一件事，这一版不做。

**只调 `updateSession` / `updateTask`，不手写 `rev`**：会话的由 `withSessionSync` 比较
白名单字段后自动递增，任务的由 `metaForEdit` 递增。手写一遍就是「同一改动涨两次」，
同步层会当成两次独立变更反复推送。

**移出写 `undefined` 而不是空串**：`undefined` 才是「不属于任何项目」。空串在投影里
同样是假，但它造出一个没有意义的中间态，还会让白名单比较多出一种「值变了但其实没变」的情形。

⛔ **两个「移出」按钮必须带 `aria-label`（含对象名）**。页面上同时有任务行与会话行，
纯文字「移出」会让辅助技术、也让用例点到错误的行 —— 这不是理论问题：第一版没有
`aria-label` 时，用例连跑红、单跑绿，报错指向的断言完全无辜（见 §2.8 的污染记录）。

### 2.7 仍未做

- 项目内「共享记忆」：记忆目前是个人 / 项目工作区两级（`FR-4.4`），要挂到项目上得先定
  「同一个项目的成员看到同一份记忆」的合并规则；
- 项目列表的排序 / 搜索（现在是按创建时间倒序，几十个以内够用）；
- **跨项目搬移**（A 项目的会话直接移到 B 项目）：现在要先移出、再移入，两步。

### 2.8 ⛔ 「创建项目报 Not Found」= 镜像没重建（2026-10-31 现场）

**症状**：组织下拉能出来（`GET /api/orgs` 成功），但点「创建」报 `Not Found`，
左侧列表区也显示 `Not Found`。`/health` 仍是 200，其它页面全正常。

**根因**：`cloud/app/projects/` 是新增模块，而运行中的镜像是 4 小时前构建的，
**里面根本没有这个目录**（`docker exec nanowork-cloud ls /app/app/projects` →
`No such file or directory`）。`docker restart` / 无 `--build` 的 `up` 都只重启**旧镜像**。

**判据（一条命令，不需要文件、不需要登录）**：

```bash
cd cloud && python docker/verify.py --routes-only
```

它拉 `/openapi.json` 检查必需路由是否注册（`REQUIRED_ROUTE_PREFIXES`）。缺了会打印
「镜像与源码不同步」并 **exit 1**。用 `openapi` 而不是逐个请求的原因：不需要登录态，
也不会把「路由不存在」与「不是成员」（服务端同样是 404）混成同一个现象。

⚠️ 已用变异验证：把清单里任一路由改成不存在的路径 → 自检变红且 exit 1；还原后 exit 0。

**重建命令**（网络受限时用本地已有的基础镜像，否则会卡在 docker.io 拉取）：

```bash
BASE_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/python:3.12-slim \
  APT_MIRROR=mirrors.aliyun.com docker compose build cloud
```

### 2.9 一条测试污染的现场记录

`tests/projectsPage.test.tsx` 第一版**没有 `beforeEach` 清 store**。某条用例留下的任务
（`projectId: 'p1'`）会渲染出自己的「移出」按钮，下一条用例 `buttonByText('移出')` 点到的是
**任务那个**，于是「会话移出」看起来没生效 —— **单跑绿、连跑红**，且失败断言（`expected 'p1'
to be undefined`）指向的地方完全无辜。

两处修：① 加 `beforeEach` 重置 `useSessionsStore` / `useTasksStore`；
② 两个移出按钮带 `aria-label`（`把会话「X」移出项目`），用例改用 `byAria` 定位。
②不是①的替代品：污染还会以别的形态出现（比如候选列表串味），①才是根治。

---

## 三、与另外两条（FR-7.5 / FR-2.6）的关系

- **`FR-7.5` 人机双写**：需要「谁在什么时候改了哪个产物」的归属，项目是天然的分组维度。
  先把 `projectId` 落到任务与产物上（客户端打标 + 同步负载带字段），人机双写才有地方挂。
- **`FR-2.6` 组织资产发布**：发布目标是「组织资产库」，项目是发布来源之一。
  它依赖的仍是知识库的写权限口径（`_writable_kb_or_404`），不依赖项目。

所以顺序是：**项目（容器）→ 任务 / 产物的 `projectId` 归属 → 人机双写 → 资产发布**。
反过来做，前两条会各自长出一套「归属」字段。
