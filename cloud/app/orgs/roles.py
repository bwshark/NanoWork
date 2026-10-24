"""角色阶梯与判定（纯函数，不碰数据库，因此可以逐条单测）。

## 三条反直觉的规则，都写在这里而不是散在路由里

1. **「授予的角色不得高于自己」**：admin 能把人升到 admin，但**不能**把人升到 owner。
   少了这条，任何一次「多邀请一个管理员」都可能变成权限提升的台阶。
2. **「最后一个 owner 不可降级 / 不可移除」**：否则组织会变成没人能管的孤儿
   （没有 owner，admin 也改不了别人的角色——没人能再任命 owner）。
3. **不在组织里 = 404 而不是 403**：403 等于告诉对方「这个组织存在，只是你没权限」，
   而组织 id 是 uuid 形状、可以被枚举着猜。
"""

from __future__ import annotations

ROLE_MEMBER = "member"
ROLE_ADMIN = "admin"
ROLE_OWNER = "owner"

#: 角色的等级。数值只用于比较，**不要**持久化它（改等级不该触发数据迁移）。
ROLE_RANK: dict[str, int] = {ROLE_MEMBER: 1, ROLE_ADMIN: 2, ROLE_OWNER: 3}

VALID_ROLES = tuple(ROLE_RANK)


def is_valid_role(role: str) -> bool:
    return role in ROLE_RANK


def rank(role: str) -> int:
    """未知角色一律 0（比 member 更低）：脏数据不能换来任何权限。"""
    return ROLE_RANK.get(role, 0)


def role_at_least(role: str, minimum: str) -> bool:
    return rank(role) >= rank(minimum) > 0


def can_grant(actor_role: str, target_role: str) -> bool:
    """能否把某人设为 `target_role`：不能授予高于自己的角色。"""
    return is_valid_role(target_role) and rank(target_role) <= rank(actor_role)
