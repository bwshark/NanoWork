"""/api/orgs/{org_id}/assets/*：组织资产（FR-2.6）的发布、浏览、撤回。

## 权限口径

| 动作 | 谁可以 |
|---|---|
| 浏览列表 | **本组织成员**（非成员 404，与组织 / 项目同一条纪律） |
| 发布 / 修改 / 撤回 | 组织 `admin` / `owner` |

为什么发布要管理员：这一条对应 PRD 原话「**管理员**把个人 Skill / 专家 / 提示词模板
发布为组织资产」。全员可发布会让组织资产退化成另一个公共网盘，而「谁发的」也就不再
是一种背书。普通成员发布被回 **403**（不是 404）——他确实是本组织成员，只是角色不够，
这两件事必须能分清。

## 404 的两处，语义不同

1. **不是本组织成员** → 连列表都 404（组织 id 可枚举，403 等于确认组织存在）；
2. **资产不属于这个 org** → 拿 A 组织的资产 id 去 B 组织的路径下操作，一律 404。
   第二条不是「多此一举」：若只按 asset_id 取行、只校验「你是某组织的管理员」，
   就出现了一条跨组织改别人资产的通路（管理员在很多组织里都是管理员）。
"""

from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.auth.deps import current_user
from app.auth.models import User
from app.auth.security import new_user_id
from app.db import get_session
from app.orgs.guards import membership_or_404, require_role
from app.orgs.roles import ROLE_ADMIN
from app.orgassets.models import ASSET_KINDS, OrgAsset
from app.timeutil import iso_z, utc_now

router = APIRouter(tags=["org-assets"])

#: 单条资产的载荷上限。够放下最长的系统提示词（几万字符），又能挡住「拿资产库当
#: 网盘」——一旦允许，清理逻辑、列表序列化、前端渲染都会被拖垮。
MAX_PAYLOAD_BYTES = 64 * 1024

#: **机器 / 账号专属**的键：上云对其他成员毫无意义，且可能泄露本机或账号信息
#: （FR-10.5）。客户端发布前会剥掉，这里再拒一次，见 `models.py` 模块注释。
FORBIDDEN_KEYS: tuple[str, ...] = ("path", "imBinding")

#: 每种 kind 必须带的键。缺了就是「点开一片空白」的坏数据，宁可发布时报错。
REQUIRED_KEYS: dict[str, tuple[str, ...]] = {
    "agent": ("systemPrompt",),
    "skill": ("prompt",),
    "prompt": ("kind", "key", "text"),
}

PROMPT_SLOT_KINDS: tuple[str, ...] = ("mode", "domain", "style")

AssetKind = Literal["agent", "skill", "prompt"]


class PublishAssetRequest(BaseModel):
    kind: AssetKind
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)
    #: 自由 JSON，形状随 kind 不同（见 `REQUIRED_KEYS`）
    payload: dict = Field(default_factory=dict)


class UpdateAssetRequest(BaseModel):
    """三档语义：不传 = 不动 / 传值 = 改。`description` 传空串即清空。"""

    name: str | None = Field(default=None, min_length=1, max_length=64)
    description: str | None = Field(default=None, max_length=500)
    payload: dict | None = None


class AssetView(BaseModel):
    id: str
    orgId: str
    kind: str
    name: str
    description: str
    payload: dict
    publishedBy: str
    #: 发布人邮箱。列表里要显示「谁发的」——只给 id 的话界面还得再查一次
    publishedByEmail: str
    publishedAt: str
    updatedAt: str


def _iter_keys(value: object) -> list[str]:
    """递归收集 JSON 里的全部键名（含嵌套 dict / list 里的）。"""
    found: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            found.append(str(key))
            found.extend(_iter_keys(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(_iter_keys(item))
    return found


def find_forbidden_key(payload: object) -> str | None:
    """返回第一个命中的禁用键（没有则 `None`）。"""
    banned = set(FORBIDDEN_KEYS)
    for key in _iter_keys(payload):
        if key in banned:
            return key
    return None


def validate_payload(kind: str, payload: dict) -> str | None:
    """按 kind 校验载荷形状；返回错误文案，`None` 表示通过。

    做成纯函数（不碰 Session、不抛 HTTPException）是为了能逐条单测——
    「缺 systemPrompt 能不能挡住」这种事不该靠起一个服务来验证。
    """
    if kind not in ASSET_KINDS:
        return f"未知的资产种类：{kind}"
    missing = [key for key in REQUIRED_KEYS[kind] if not payload.get(key)]
    if missing:
        return f"载荷缺少必需字段：{'/'.join(missing)}"

    if kind == "prompt":
        slot_kind = payload.get("kind")
        if slot_kind not in PROMPT_SLOT_KINDS:
            return "提示词槽位种类只能是 mode / domain / style"
        if not isinstance(payload.get("text"), str):
            return "提示词正文必须是字符串"

    if kind == "agent" and not isinstance(payload.get("systemPrompt"), str):
        return "systemPrompt 必须是字符串"
    if kind == "skill" and not isinstance(payload.get("prompt"), str):
        return "prompt 必须是字符串"

    banned = find_forbidden_key(payload)
    if banned is not None:
        # 说得具体一点：运维看到一个 400 得能立刻知道该改客户端哪儿
        return f"载荷里不能带机器/账号专属字段：{banned}"

    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_PAYLOAD_BYTES:
        return f"载荷过大：{len(encoded)} 字节，上限 {MAX_PAYLOAD_BYTES}"
    return None


def _dump(payload: dict) -> str:
    # `sort_keys` 让「同样的载荷」在库里逐字一致：便于比对与人工排查
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _load_payload(raw: str) -> dict:
    """读回的载荷。脏数据（手工改库 / 老版本写入）按空对象处理，不让列表整页 500。"""
    try:
        value = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _view(session: Session, asset: OrgAsset) -> AssetView:
    publisher = session.get(User, asset.published_by)
    return AssetView(
        id=asset.id,
        orgId=asset.org_id,
        kind=asset.kind,
        name=asset.name,
        description=asset.description,
        payload=_load_payload(asset.payload),
        publishedBy=asset.published_by,
        publishedByEmail=publisher.email if publisher is not None else "",
        publishedAt=iso_z(asset.published_at),
        updatedAt=iso_z(asset.updated_at),
    )


def _asset_or_404(session: Session, org_id: str, asset_id: str) -> OrgAsset:
    """按 (org_id, asset_id) 取资产：不属于这个组织一律 404（见模块注释第 2 条）。"""
    asset = session.get(OrgAsset, asset_id)
    if asset is None or asset.org_id != org_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="资产不存在")
    return asset


def _reject(detail: str) -> None:
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


@router.get("/api/orgs/{org_id}/assets", response_model=list[AssetView])
def list_assets(
    org_id: str,
    kind: str = "",
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> list[AssetView]:
    """本组织的资产列表（全员可见）。`kind` 为空 = 全部。"""
    membership_or_404(session, org_id, user)
    statement = select(OrgAsset).where(OrgAsset.org_id == org_id)
    if kind:
        if kind not in ASSET_KINDS:
            _reject(f"未知的资产种类：{kind}")
        statement = statement.where(OrgAsset.kind == kind)
    rows = session.exec(statement).all()
    # 最近发布的在前：组织资产是「新东西先看」，与项目列表同口径
    rows = sorted(rows, key=lambda row: row.published_at, reverse=True)
    return [_view(session, row) for row in rows]


@router.post(
    "/api/orgs/{org_id}/assets",
    response_model=AssetView,
    status_code=status.HTTP_201_CREATED,
)
def publish_asset(
    org_id: str,
    payload: PublishAssetRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> AssetView:
    member = membership_or_404(session, org_id, user)
    require_role(member, ROLE_ADMIN)

    name = payload.name.strip()
    if not name:
        _reject("资产名不能为空")
    error = validate_payload(payload.kind, payload.payload)
    if error is not None:
        _reject(error)

    asset = OrgAsset(
        id=new_user_id(),
        org_id=org_id,
        kind=payload.kind,
        name=name,
        description=payload.description.strip(),
        payload=_dump(payload.payload),
        published_by=user.id,
    )
    session.add(asset)
    session.commit()
    session.refresh(asset)
    return _view(session, asset)


@router.patch("/api/orgs/{org_id}/assets/{asset_id}", response_model=AssetView)
def update_asset(
    org_id: str,
    asset_id: str,
    payload: UpdateAssetRequest,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> AssetView:
    """改一份已发布的资产（改错字 / 换正文）。

    `kind` **不可改**：换种类等于换了一份资产，`payload` 的形状也对不上。
    需要换种类就撤回后重新发布。
    """
    member = membership_or_404(session, org_id, user)
    require_role(member, ROLE_ADMIN)
    asset = _asset_or_404(session, org_id, asset_id)

    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            _reject("资产名不能为空")
        asset.name = name
    if payload.description is not None:
        asset.description = payload.description.strip()
    if payload.payload is not None:
        error = validate_payload(asset.kind, payload.payload)
        if error is not None:
            _reject(error)
        asset.payload = _dump(payload.payload)
    asset.updated_at = utc_now()
    session.add(asset)
    session.commit()
    session.refresh(asset)
    return _view(session, asset)


@router.delete("/api/orgs/{org_id}/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def withdraw_asset(
    org_id: str,
    asset_id: str,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> None:
    """撤回（真删）。

    不做软删除：组织资产是**快照副本**，原实体还在发布者本机，撤回不是丢数据。
    留一个 `deletedAt` 反而会让「撤回后又想发一模一样的一份」变成两条历史记录。
    """
    member = membership_or_404(session, org_id, user)
    require_role(member, ROLE_ADMIN)
    asset = _asset_or_404(session, org_id, asset_id)
    session.delete(asset)
    session.commit()
