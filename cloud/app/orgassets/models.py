"""组织级资产（FR-2.6）：把「某个人的专家 / 技能 / 提示词模板」发布成全组织可见。

## 为什么存成「快照 + 载荷」而不是指向原实体

专家 / 技能 / 提示词模板都是**本机资产**（`agentsStore` 的 localStorage、
`~/.nanowork/skills/*/SKILL.md`、`~/.nanowork/prompts/**`）。云端根本拿不到它们，
也不该拿：同步层只传用户意图（见 `types/skill.ts` 关于「扫描结果不上云」的说明）。

所以发布 = 把一个**内容快照**写进组织库。这条决定带来两个必须写进代码的推论：

1. **快照是死的**。发布者改了本机那个专家，组织资产不会跟着变，要重新发布。
   反过来也成立：有人导入后改了，组织里那份不受影响。这不是缺陷——「人走了经验
   还在」（US-10）要的正是这一份不再依赖任何人的副本。
2. **载荷里不能有机器 / 账号专属字段**。`path` 是**别人机器上的路径**，`imBinding`
   是**别人账号的机器人绑定**，两者上云后对其他人毫无意义，还可能泄露内网结构
   （FR-10.5）。客户端发布时已经剥掉，服务端这里再**拒绝**一次——客户端那份是
   为了让发布成功，这一份是为了让漏剥的客户端**报错而不是静默泄露**。

## 三种载荷的形状

| kind | 必需键 | 说明 |
|---|---|---|
| `agent` | `systemPrompt` | 专家的人格 / 工具面 / 模型绑定；`skillIds` 里指向别处技能的 id 在导入端按「本地没有就忽略」处理 |
| `skill` | `prompt` | 技能正文（前置提示词）与 `allowedTools` |
| `prompt` | `kind` / `key` / `text` | 单个提示词槽位的覆盖正文（`kind` ∈ mode/domain/style） |

形状校验刻意放在服务端而不是只靠客户端：`payload` 是自由 JSON，没有这一层，
一个拼错字段名的客户端会发布出一堆「点开是空白」的资产，而这种坏数据在列表里
看起来完全正常。

## 不做「同源去重」

POST 永远新建，不会按 `name` 或原始 id 合并。原因是合并的失败模式更糟：两个管理员
各自发布过同名技能时，「我发的那份被对方悄悄顶掉」在界面上毫无痕迹，而列表里多一条
是可以看见、可以自己删的。需要改一份已发布的资产就走 PATCH（管理员按 id 改）。
"""

from __future__ import annotations

from datetime import datetime

from sqlmodel import Field, SQLModel

from app.timeutil import utc_now

#: 资产种类。刻意用字符串而不是 Enum：SQLite 与 PostgreSQL 上都是 TEXT，
#: 加一种只需改这里与客户端的标签表（`Record` 类型会强制补齐）。
ASSET_KIND_AGENT = "agent"
ASSET_KIND_SKILL = "skill"
ASSET_KIND_PROMPT = "prompt"

ASSET_KINDS: tuple[str, ...] = (ASSET_KIND_AGENT, ASSET_KIND_SKILL, ASSET_KIND_PROMPT)


class OrgAsset(SQLModel, table=True):
    """一条组织资产快照。

    `payload` 是 **JSON 文本**而不是 JSONB：开发用 SQLite、生产用 PostgreSQL，
    两边都能存 TEXT，读的时候统一 `json.loads`。用方言专有类型会让「同一份 schema
    两个库」这条约定破功（见 `db.py` 模块注释）。
    """

    __tablename__ = "org_assets"  # type: ignore[assignment]

    id: str = Field(primary_key=True)
    org_id: str = Field(index=True, foreign_key="organizations.id")
    #: agent / skill / prompt（取值见 `ASSET_KINDS`）
    kind: str = Field(index=True)
    name: str = Field(index=True)
    description: str = Field(default="")
    #: `json.dumps` 的产物；形状随 `kind` 不同，校验见 `routes.validate_payload`
    payload: str = Field(default="{}")
    #: 发布人（组织 admin/owner）。导入端据此显示「谁发的」——追责与信任都靠它
    published_by: str = Field(index=True)
    published_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
