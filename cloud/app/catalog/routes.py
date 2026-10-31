"""/api/models/builtin：内置模型目录的下发与运维接口。

## 两条权限线刻意不对称

- **读**：任何登录用户。内置模型是产品能力的一部分，不需要授权（也不需要组织归属
  ——它在任何团队之外）。
- **写**：只有持有 `NANOWORK_BUILTIN_ADMIN_TOKEN` 的运维。且**没配这个环境变量时
  整个写接口返回 404**，而不是 403：403 等于向未授权者确认「这里有个需要令牌的
  接口」，而大多数部署根本不该开它。

## 为什么响应是 camelCase

客户端 `ModelFormValue` 是 camelCase，多一层 snake→camel 的转换只会多一处
「哪个字段没转」的静默 bug（漏转的字段在客户端读成 `undefined`，然后被
`buildMutation` 的缺省值悄悄顶掉）。服务端直接给客户端要的形状。
"""

from __future__ import annotations

import json
import logging
import os
import secrets

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlmodel import Session, select

from app.auth.deps import current_user
from app.auth.models import User
from app.catalog.models import BuiltinModel
from app.db import get_session
from app.timeutil import utc_now

router = APIRouter(prefix="/api/models/builtin", tags=["models"])
logger = logging.getLogger(__name__)

ADMIN_TOKEN_ENV = "NANOWORK_BUILTIN_ADMIN_TOKEN"


class BuiltinModelView(BaseModel):
    """下发给客户端的一条内置模型（形状对齐客户端 `ModelFormValue`）。"""

    # `populate_by_name`：测试与运维脚本可以按 snake_case 构造，响应仍走 alias
    model_config = ConfigDict(populate_by_name=True)

    id: str
    model: str
    provider: str = ""
    provider_label: str = Field(default="", alias="providerLabel")
    api_base: str = Field(default="", alias="apiBase")
    api_key: str = Field(default="", alias="apiKey")
    max_tokens: int = Field(default=32768, alias="maxTokens")
    context_window_tokens: int = Field(default=200_000, alias="contextWindowTokens")
    temperature: float = 0.1
    reasoning_effort: str | None = Field(default=None, alias="reasoningEffort")
    supports_tools: bool = Field(default=True, alias="supportsTools")
    supports_vision: bool = Field(default=False, alias="supportsVision")
    supports_reasoning: bool = Field(default=True, alias="supportsReasoning")
    custom_protocol: bool = Field(default=False, alias="customProtocol")
    pricing: dict | None = None
    description: str = ""
    sort_order: int = Field(default=0, alias="sortOrder")


class BuiltinModelList(BaseModel):
    models: list[BuiltinModelView]


class BuiltinModelInput(BaseModel):
    """写接口的请求体：`id` 来自路径，其余字段可选（缺省沿用默认值）。"""

    model_config = ConfigDict(populate_by_name=True)

    model: str | None = None
    provider: str | None = None
    provider_label: str | None = Field(default=None, alias="providerLabel")
    api_base: str | None = Field(default=None, alias="apiBase")
    api_key: str | None = Field(default=None, alias="apiKey")
    max_tokens: int | None = Field(default=None, alias="maxTokens")
    context_window_tokens: int | None = Field(default=None, alias="contextWindowTokens")
    temperature: float | None = None
    reasoning_effort: str | None = Field(default=None, alias="reasoningEffort")
    supports_tools: bool | None = Field(default=None, alias="supportsTools")
    supports_vision: bool | None = Field(default=None, alias="supportsVision")
    supports_reasoning: bool | None = Field(default=None, alias="supportsReasoning")
    custom_protocol: bool | None = Field(default=None, alias="customProtocol")
    pricing: dict | None = None
    description: str | None = None
    sort_order: int | None = Field(default=None, alias="sortOrder")
    enabled: bool | None = None


def _pricing_of(row: BuiltinModel) -> dict | None:
    """行里的 JSON → 字典；坏数据按「没配单价」处理，不让整份目录 500。"""
    if not row.pricing_json:
        return None
    try:
        parsed = json.loads(row.pricing_json)
    except ValueError:
        logger.warning("内置模型 %s 的 pricing_json 不是合法 JSON，按未配置处理", row.id)
        return None
    return parsed if isinstance(parsed, dict) else None


def _view(row: BuiltinModel) -> BuiltinModelView:
    return BuiltinModelView(
        id=row.id,
        model=row.model,
        provider=row.provider,
        provider_label=row.provider_label,
        api_base=row.api_base,
        api_key=row.api_key,
        max_tokens=row.max_tokens,
        context_window_tokens=row.context_window_tokens,
        temperature=row.temperature,
        reasoning_effort=row.reasoning_effort,
        supports_tools=row.supports_tools,
        supports_vision=row.supports_vision,
        supports_reasoning=row.supports_reasoning,
        custom_protocol=row.custom_protocol,
        pricing=_pricing_of(row),
        description=row.description,
        sort_order=row.sort_order,
    )


def _require_admin(token: str | None) -> None:
    """写接口的准入。未配置令牌 → 404（接口等同于不存在）。"""
    expected = os.environ.get(ADMIN_TOKEN_ENV, "")
    if not expected:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not Found")
    # 定时比较，避免按字节差异猜令牌
    if not token or not secrets.compare_digest(token, expected):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="内置模型写接口需要管理员令牌"
        )


@router.get("", response_model=BuiltinModelList)
def list_builtin_models(
    _user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> BuiltinModelList:
    """当前可用的内置模型（`enabled=false` 的不下发）。

    排序 `(sort_order, id)` 必须稳定：客户端据此决定菜单里的先后，
    两次请求给出不同顺序会让「第二个就是常用的那个」这种肌肉记忆失效。
    """
    rows = session.exec(
        select(BuiltinModel)
        .where(BuiltinModel.enabled == True)  # noqa: E712 —— SQLModel 需要显式比较
        .order_by(BuiltinModel.sort_order, BuiltinModel.id)  # type: ignore[arg-type]
    ).all()
    return BuiltinModelList(models=[_view(row) for row in rows])


@router.put("/{model_id}", response_model=BuiltinModelView)
def upsert_builtin_model(
    model_id: str,
    body: BuiltinModelInput,
    _user: User = Depends(current_user),
    session: Session = Depends(get_session),
    x_builtin_admin_token: str | None = Header(default=None, alias="X-Builtin-Admin-Token"),
) -> BuiltinModelView:
    """新增或更新一条（运维用）。

    存在即更新、不存在即插入；**只覆盖请求体里给了的字段**——这样「只换密钥」
    不需要把整条模型重新抄一遍（抄漏一个能力声明就会让工具调用静默失效）。
    """
    _require_admin(x_builtin_admin_token)
    if not model_id.strip():
        raise HTTPException(status_code=422, detail="model_id 不能为空")

    row = session.get(BuiltinModel, model_id)
    created = row is None
    if row is None:
        row = BuiltinModel(id=model_id, model=body.model or model_id, created_at=utc_now())

    if body.model is not None:
        row.model = body.model
    if body.provider is not None:
        row.provider = body.provider
    if body.provider_label is not None:
        row.provider_label = body.provider_label
    if body.api_base is not None:
        row.api_base = body.api_base
    if body.api_key is not None:
        row.api_key = body.api_key
    if body.max_tokens is not None:
        row.max_tokens = body.max_tokens
    if body.context_window_tokens is not None:
        row.context_window_tokens = body.context_window_tokens
    if body.temperature is not None:
        row.temperature = body.temperature
    if body.reasoning_effort is not None:
        row.reasoning_effort = body.reasoning_effort or None
    if body.supports_tools is not None:
        row.supports_tools = body.supports_tools
    if body.supports_vision is not None:
        row.supports_vision = body.supports_vision
    if body.supports_reasoning is not None:
        row.supports_reasoning = body.supports_reasoning
    if body.custom_protocol is not None:
        row.custom_protocol = body.custom_protocol
    if body.pricing is not None:
        row.pricing_json = json.dumps(body.pricing, ensure_ascii=False)
    if body.description is not None:
        row.description = body.description
    if body.sort_order is not None:
        row.sort_order = body.sort_order
    if body.enabled is not None:
        row.enabled = body.enabled
    row.updated_at = utc_now()

    session.add(row)
    session.commit()
    session.refresh(row)
    logger.warning("内置模型 %s 已%s", model_id, "新增" if created else "更新")
    return _view(row)


@router.delete("/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_builtin_model(
    model_id: str,
    _user: User = Depends(current_user),
    session: Session = Depends(get_session),
    x_builtin_admin_token: str | None = Header(default=None, alias="X-Builtin-Admin-Token"),
) -> None:
    """彻底移除一条（下架请用 `enabled=false`：删除后客户端不会主动清理本机预设）。"""
    _require_admin(x_builtin_admin_token)
    row = session.get(BuiltinModel, model_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="内置模型不存在")
    session.delete(row)
    session.commit()
