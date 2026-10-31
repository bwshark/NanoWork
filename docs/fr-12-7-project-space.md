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

### 2.5 仍未做

- 项目内「共享记忆」：记忆目前是个人 / 项目工作区两级（`FR-4.4`），要挂到项目上得先定
  「同一个项目的成员看到同一份记忆」的合并规则；
- 项目列表的排序 / 搜索（现在是按创建时间倒序，几十个以内够用）；
- 「在项目里新建会话 / 任务」的入口（`createSession({ projectId })` 与
  `TaskFormDialog` 的 `initial.projectId` 已就绪，但还没有按钮去传它）。

---

## 三、与另外两条（FR-7.5 / FR-2.6）的关系

- **`FR-7.5` 人机双写**：需要「谁在什么时候改了哪个产物」的归属，项目是天然的分组维度。
  先把 `projectId` 落到任务与产物上（客户端打标 + 同步负载带字段），人机双写才有地方挂。
- **`FR-2.6` 组织资产发布**：发布目标是「组织资产库」，项目是发布来源之一。
  它依赖的仍是知识库的写权限口径（`_writable_kb_or_404`），不依赖项目。

所以顺序是：**项目（容器）→ 任务 / 产物的 `projectId` 归属 → 人机双写 → 资产发布**。
反过来做，前两条会各自长出一套「归属」字段。
