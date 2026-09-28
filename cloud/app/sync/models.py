"""`sync_items` 表：一行 = 一个 `(user, collection, entity)` 的当前版本。

两个字段看起来多余，实际各有一条非显然的理由：

- **`server_seq`（而非直接用自增 id 当游标）**：push 走的是 UPDATE，行 id 不变。
  若游标取 `id`，对端的游标一旦越过这一行，此后该实体的**任何更新都拉不到**
  （id 没变，永远 `<= since`）——这是「同步一次成功、之后再也不动」的典型成因。
  所以每次写入都要**推进 seq**，让「变更」本身产生新的游标位置。
- **`client_updated_at` 与 `updated_at` 并存**：`updated_at` 是**服务端接收时间**
  （§5.3，抵御时钟漂移），`client_updated_at` 只作审计，不参与任何裁决。
  只留一个的话，排查「这条到底是谁改的」时就无从下手。

`payload` 存 JSON 文本而非数据库原生 JSON 类型：MVP 不需要在 SQL 里查询 payload
内部，而 SQLite 与 PostgreSQL 的 JSON 类型/算子并不一致，文本最省事也最好迁。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import UniqueConstraint
from sqlmodel import Field, SQLModel


class SyncItem(SQLModel, table=True):
    __tablename__ = "sync_items"  # type: ignore[assignment]
    __table_args__ = (
        UniqueConstraint("user_id", "collection", "entity_id", name="uq_sync_entity"),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    collection: str
    entity_id: str = Field(index=True)

    rev: int = 0
    # 服务端接收时间：LWW 裁决的唯一时间依据
    updated_at: datetime
    # 客户端上报的时间，仅审计
    client_updated_at: datetime | None = None
    deleted_at: datetime | None = None
    updated_by: str | None = None
    payload: str = "{}"
    # 变更游标：每次写入都推进，供 pull 增量取用
    server_seq: int = 0


class SyncEvent(SQLModel, table=True):
    """`sync_events` 表：一行 = 一条**不可变**的会话事件（append-only）。

    与 `sync_items` 的关键差异（也是它必须独立成表、而非复用实体行的原因）：

    - **行语义是「一条事实」而非「一个当前版本」**：没有 `rev` / `updated_at` /
      `deleted_at` 这类「当前版本」列——事件一旦落库就不再改写（m6 §四 末注）。
    - **不做 `updatedAt` 归一**：事件的 `timestamp` / `seq` 是客户端权威事实，
      服务端**不重写**。往事件体里写服务端接收时刻等于污染事实，且事件无 `rev`，
      LWW 三级比较对它无意义。
    - **幂等由唯一键把关**：`(user_id, session_id, event_id)`。重复推同一条事件
      **不写库、不推进 `server_seq`**——与实体「完全同版幂等跳过」同一纪律。

    `server_seq` 与 `sync_items` **共享**同一条每用户变更游标（`_next_seq` 取两表
    最大值 + 1）：这样 `pull?since=` 天然覆盖「实体 + 事件」，客户端只需一个游标、
    「先 pull 后 push」也只需一次往返。
    """

    __tablename__ = "sync_events"  # type: ignore[assignment]
    __table_args__ = (UniqueConstraint("user_id", "session_id", "event_id", name="uq_sync_event"),)

    id: int | None = Field(default=None, primary_key=True)
    user_id: str = Field(index=True)
    session_id: str = Field(index=True)
    event_id: str
    # 会话内事件 seq（客户端值，供排查 / 排序参考；不作为服务端游标）
    seq: int = 0
    # 整条事件 JSON（含 sessionId / seq / type / timestamp / …）
    payload: str = "{}"
    # **与 sync_items 共享**的每用户变更游标
    server_seq: int = 0
