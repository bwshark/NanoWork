"""个人知识库：每个用户一个「只有自己可见」的库（2026-10-30）。

## 为什么它是一本挂在「私有组织」下的普通知识库

个人库要的是**隐私**，而隐私的唯一判据是「谁在这本库所属的组织里」。这套产品里
这个判据只有一处实现：`visible_kb_ids` / `_kb_or_404` 都先确认「我是该组织成员」，
再谈角色与部门。所以个人库的做法是：

```
每个用户 → 一个 kind=personal 的组织（组织里只有他一个人，owner）
         → 组织下一本知识库（名字就是「我的个人知识库」）
```

于是文档、切块、向量、图片、原文件预览、回收站、检索 —— **一条代码都不用改**。
反过来给 `knowledge_bases` 加 `owner_user_id` 再写一条「个人库分支」，
就等于把「谁能看到哪本库」复制成两份实现；而 `visibility.py` 的注释里已经写明，
两份实现的结果必然是「列表里看不到、直接按 id 却读得到」这类组合漏洞。

## 三个刻意的细节

1. **id 是确定性的**（`p<用户id>` / `k<用户id>`），不是随机 id：这样「取或建」天然幂等，
   重复调用不会产生第二个私有组织 / 第二本个人库；并发下唯一会撞的是主键，见
   `ensure_personal_kb` 里的 `IntegrityError` 兜底。
2. **私有组织不出现在 `GET /api/orgs` 里**（见 `orgs/routes.py::list_orgs`）：
   它不是团队，画进侧栏的团队树会让人以为「我加入了一个只有我的公司」。
3. **私有组织不允许加人**（见 `orgs/routes.py::add_member`）：`kind` 是元数据不是权限，
   真要保证「仅自己可见」，就必须把「往这里塞人」这条路堵上。否则任何拿到自己
   org_id 的调用方都能把同事拉进个人空间，读到别人的私人资料。
"""

from __future__ import annotations

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from app.auth.models import User
from app.kb.models import DEFAULT_ALLOWED_ROLES, KnowledgeBase, roles_to_json
from app.orgs.models import ORG_KIND_PERSONAL, Organization, OrgMember
from app.orgs.roles import ROLE_OWNER

#: 个人库的显示名。与客户端常量 `PERSONAL_KB_NAME` 是同一句话 ——
#: 客户端不写死它（服务端说叫什么就叫什么），此处只是服务端的那一份。
PERSONAL_KB_NAME = "我的个人知识库"
#: 私有组织的名字。**不会展示给用户**（不出现在团队列表里），只为了日志与后台可读。
PERSONAL_ORG_NAME = "个人空间"

#: id 前缀：一眼能看出这是个人空间，且与 `new_user_id()` 的 32 位 hex 不会撞。
_PERSONAL_ORG_PREFIX = "p"
_PERSONAL_KB_PREFIX = "k"


def personal_org_id(user_id: str) -> str:
    """某个用户的私有组织 id（确定性，见模块注释第 1 条）。"""
    return f"{_PERSONAL_ORG_PREFIX}{user_id}"


def personal_kb_id(user_id: str) -> str:
    """某个用户的个人知识库 id（确定性）。"""
    return f"{_PERSONAL_KB_PREFIX}{user_id}"


def ensure_personal_kb(session: Session, user: User) -> tuple[Organization, KnowledgeBase]:
    """取出（必要时创建）该用户的私有组织与个人知识库。

    **取或建**而不是纯 GET：让客户端少一次「先查再建」的往返，也不会出现
    「第一个请求是列表、第二个才是建库」的时序问题。

    并发：两个请求同时走到这里时，二者都会算出同一个 id，其中一个 commit 撞主键。
    撞主键**不是错误**（另一个请求刚好把它建好了），所以这里回滚后直接重读。
    """
    org_id = personal_org_id(user.id)
    kb_id = personal_kb_id(user.id)

    org = session.get(Organization, org_id)
    if org is None:
        org = Organization(
            id=org_id,
            name=PERSONAL_ORG_NAME,
            kind=ORG_KIND_PERSONAL,
            created_by=user.id,
        )
        session.add(org)

    # 成员行是隔离的唯一凭据：没有它，连库主自己也过不了 `_kb_or_404`
    if session.get(OrgMember, (org_id, user.id)) is None:
        session.add(OrgMember(org_id=org_id, user_id=user.id, role=ROLE_OWNER))

    kb = session.get(KnowledgeBase, kb_id)
    if kb is None:
        kb = KnowledgeBase(
            id=kb_id,
            org_id=org_id,
            name=PERSONAL_KB_NAME,
            description="个人知识库仅自己可见，快来打造你的知识花园吧！",
            # 可见角色写全量：真正的门槛是「组织里只有我一个人」。
            # 写成「只有 owner」在这里没有区别，却会在将来复用时误导读者。
            allowed_roles=roles_to_json(list(DEFAULT_ALLOWED_ROLES)),
            created_by=user.id,
        )
        session.add(kb)

    try:
        session.commit()
    except IntegrityError:
        # 另一个请求先建好了同一套行：回滚后按普通查询取回即可（见 docstring）
        session.rollback()
        org = session.get(Organization, org_id)
        kb = session.get(KnowledgeBase, kb_id)
        if org is None or kb is None:
            # 主键冲突却不是这套行 → 脏数据（id 撞到真实团队），如实报错，
            # 不要静默返回一个不存在的对象
            raise

    session.refresh(kb)
    return org, kb
