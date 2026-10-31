"""LWW 裁决：纯函数，不碰数据库，因此可逐条单测。

三级 tie-break（m6 §七 批次 1 的完成判据）：

1. **`rev` 大者胜**；
2. 相等则 `updatedAt` 大者胜；
3. 再相等则 `entityId` 字典序大者胜。

第三级存在的理由不是「分出高下」，而是**确定性**：前两级都相等时，若没有一条
所有人都认同的规则，裁决结果就取决于代码里的分支顺序，而两端各自执行时可能
选出不同的胜者。字典序让「同一对版本」在任何设备上都得到同一个结论。

## 为什么 `rev` 必须排在时间之前（2026-10-31 修正，原先相反）

不是口味问题，是**数据正确性**：服务端落库时把 `updated_at` 归一为**服务端接收时刻**
（见 `routes.py`），而客户端本地写入用的是**本机时钟**。两侧只要有偏差，客户端刚改完
的数据在 push 时就会被判成「比服务端旧」，服务端把旧 payload 回给客户端 →
**用户刚做的修改被静默回滚**，而且下次还在同一处失败。

实测（2026-10-31，本机 vs 本地容器）：容器时钟比客户端快约 **1.1 秒**，
`twoDevice` 门禁②的「并发改同一实体」因此稳定红 —— 客户端 `rev=2` 的修改
输给了服务端 `rev=1` 的旧行。

`rev` 是客户端自增的版本号（每次修改 +1），与任何时钟无关；用它当第一裁决键，
单设备的修改就不会被自己的时钟误差吃掉。同 `rev` 的「真并发」（两台设备同时改）
仍按时间裁决 —— 那时两侧都是客户端时间，误差是设备间的事，且会有冲突提示，
不会静默丢数据。

写成 `compare_versions()` 而不是直接写进 `resolve()`，是为了让第三级能被单测
独立击中——`resolve()` 里两端 `entity_id` 必然相同，第三级永远平局，测不出来。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class VersionStamp:
    """参与裁决的四个字段（payload 不参与）。"""

    entity_id: str
    rev: int
    updated_at: datetime
    deleted_at: datetime | None = None


def compare_versions(a: VersionStamp, b: VersionStamp) -> int:
    """>0 表示 a 胜，<0 表示 b 胜，0 表示完全同版。见模块注释：`rev` 必须排在时间之前。"""
    if a.rev != b.rev:
        return 1 if a.rev > b.rev else -1
    if a.updated_at != b.updated_at:
        return 1 if a.updated_at > b.updated_at else -1
    if a.entity_id != b.entity_id:
        return 1 if a.entity_id > b.entity_id else -1
    return 0


@dataclass(frozen=True)
class Resolution:
    """裁决结果。

    `accepted` 为 True 表示 incoming 胜出（应当写库），False 表示服务端版本更新
    （incoming 是过期推送）。`reason` 供客户端判断要不要弹冲突提示。
    """

    accepted: bool
    reason: str
    winner: VersionStamp


_REASON_CREATE = "created"
_REASON_NEWER_TIME = "incoming_newer_time"
_REASON_NEWER_REV = "incoming_newer_rev"
_REASON_TIE_ID = "incoming_wins_tie_by_id"
_REASON_SAME = "identical"
_REASON_SERVER_TIME = "server_newer_time"
_REASON_SERVER_REV = "server_newer_rev"
_REASON_SERVER_ID = "server_wins_tie_by_id"


def resolve(current: VersionStamp | None, incoming: VersionStamp) -> Resolution:
    """服务端当前版本 vs 客户端推送版本的裁决。"""
    if current is None:
        return Resolution(True, _REASON_CREATE, incoming)

    cmp = compare_versions(incoming, current)
    if cmp == 0:
        # 同一版本：幂等接受，再写一次无害且能让 server_seq 推进（对端拉得到）
        return Resolution(True, _REASON_SAME, incoming)
    if cmp > 0:
        if incoming.rev != current.rev:
            reason = _REASON_NEWER_REV
        elif incoming.updated_at != current.updated_at:
            reason = _REASON_NEWER_TIME
        else:
            reason = _REASON_TIE_ID
        return Resolution(True, reason, incoming)

    if incoming.rev != current.rev:
        reason = _REASON_SERVER_REV
    elif incoming.updated_at != current.updated_at:
        reason = _REASON_SERVER_TIME
    else:
        reason = _REASON_SERVER_ID
    return Resolution(False, reason, current)
