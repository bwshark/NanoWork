"""内置模型的出厂种子。

## 为什么是「种子」而不是「常量」

表里已经有行之后，`ensure_seed` **什么都不做**——它只补「表里还没有的 id」。
这条规则对应两个真实的运维场景：

- 运维在库里改了 apiBase / 换了密钥 → 重启不能把改动冲回出厂值；
- 出厂清单加了一条新模型 → 重启后它自动出现（缺的才补，已有的不动）。

## 密钥从环境变量来，不写进仓库

默认两条模型的 `api_key` 取自 `NANOWORK_BUILTIN_AGNES_API_KEY`。没有设置时
种子仍会写入（key 为空），客户端据此显示「已内置但缺少密钥」而不是让模型
凭空消失——「看得到但用不了」比「什么都看不到」好排查。
真正需要立刻可用的部署，应当用管理员端点补一次 key（见 `routes.py`）。
"""

from __future__ import annotations

import json
import logging
import os

from sqlmodel import Session, select

from app.catalog.models import BuiltinModel
from app.timeutil import utc_now

logger = logging.getLogger(__name__)

#: 种子清单被整体覆盖时用的环境变量（值是 JSON 数组，形状同 `BuiltinModel` 的蛇形字段）
SEED_ENV = "NANOWORK_BUILTIN_MODELS"
#: agnes 系模型的密钥（只作用于 `provider == "agnes"` 且 key 为空的条目）
AGNES_KEY_ENV = "NANOWORK_BUILTIN_AGNES_API_KEY"

DEFAULT_AGNES_API_BASE = "https://apihub.agnes-ai.com/v1"


def _defaults() -> list[dict]:
    """出厂清单。

    两条模型的参数取自引擎侧的实测值（`nanowork.config.json` 里那条可用的
    `agnes-3.0-flash`）：32768 输出 / 200K 上下文 / 支持工具与思考。
    `agnes-2.5-flash` 与它同供应商同代，参数一致——差异只在上游模型名。
    """
    key = os.environ.get(AGNES_KEY_ENV, "")
    common = {
        "provider": "agnes",
        "provider_label": "Agnes",
        "api_base": DEFAULT_AGNES_API_BASE,
        "api_key": key,
        "max_tokens": 32768,
        "context_window_tokens": 200_000,
        "temperature": 0.1,
        "supports_tools": True,
        "supports_vision": False,
        "supports_reasoning": True,
        "custom_protocol": False,
    }
    return [
        {
            **common,
            "id": "agnes-3.0-flash",
            "model": "agnes-3.0-flash",
            "description": "响应快，适合日常对话与工具调用",
            "sort_order": 10,
        },
        {
            **common,
            "id": "agnes-2.5-flash",
            "model": "agnes-2.5-flash",
            "description": "上一代轻量模型，成本更低",
            "sort_order": 20,
        },
    ]


def seed_entries() -> list[dict]:
    """本次启动要保证存在的条目（环境变量可整体覆盖）。"""
    raw = os.environ.get(SEED_ENV)
    if not raw:
        return _defaults()
    try:
        parsed = json.loads(raw)
    except ValueError:
        # 配错了就退回出厂清单，而不是让整个进程起不来：
        # 内置模型是锦上添花的能力，不该拥有一票否决服务启动的权力。
        logger.warning("%s 不是合法 JSON，改用出厂清单", SEED_ENV)
        return _defaults()
    if not isinstance(parsed, list):
        logger.warning("%s 不是数组，改用出厂清单", SEED_ENV)
        return _defaults()
    return [item for item in parsed if isinstance(item, dict) and item.get("id")]


def _row_from(item: dict) -> BuiltinModel:
    """字典 → 行。只取声明过的键，未知键忽略（与引擎 `extra="ignore"` 同款宽容）。"""
    now = utc_now()
    return BuiltinModel(
        id=str(item.get("id", "")).strip(),
        model=str(item.get("model") or item.get("id") or "").strip(),
        provider=str(item.get("provider") or ""),
        provider_label=str(item.get("provider_label") or item.get("providerLabel") or ""),
        api_base=str(item.get("api_base") or item.get("apiBase") or ""),
        api_key=str(item.get("api_key") or item.get("apiKey") or ""),
        max_tokens=int(item.get("max_tokens") or item.get("maxTokens") or 32768),
        context_window_tokens=int(
            item.get("context_window_tokens") or item.get("contextWindowTokens") or 200_000
        ),
        temperature=float(item.get("temperature") or 0.1),
        reasoning_effort=item.get("reasoning_effort") or item.get("reasoningEffort") or None,
        supports_tools=bool(item.get("supports_tools", item.get("supportsTools", True))),
        supports_vision=bool(item.get("supports_vision", item.get("supportsVision", False))),
        supports_reasoning=bool(
            item.get("supports_reasoning", item.get("supportsReasoning", True))
        ),
        custom_protocol=bool(item.get("custom_protocol", item.get("customProtocol", False))),
        pricing_json=_pricing_json(item),
        description=str(item.get("description") or ""),
        sort_order=int(item.get("sort_order") or item.get("sortOrder") or 0),
        enabled=bool(item.get("enabled", True)),
        created_at=now,
        updated_at=now,
    )


def _pricing_json(item: dict) -> str:
    """单价统一存成 JSON 字符串（接受 python 字典或 JSON 字符串两种输入）。"""
    raw = item.get("pricing")
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw.strip()
    if isinstance(raw, dict):
        return json.dumps(raw, ensure_ascii=False)
    return ""


def ensure_seed(session: Session) -> int:
    """补齐缺失的种子条目，返回本次插入的条数（0 = 无事可做）。

    **不更新已有行**：见文件头「为什么是种子而不是常量」。
    """
    entries = seed_entries()
    if not entries:
        return 0
    existing = {
        row.id
        for row in session.exec(select(BuiltinModel).where(BuiltinModel.id.in_([e["id"] for e in entries]))).all()
    }
    inserted = 0
    for item in entries:
        model_id = str(item.get("id", "")).strip()
        if not model_id or model_id in existing:
            continue
        session.add(_row_from(item))
        inserted += 1
    if inserted:
        session.commit()
        logger.warning("内置模型种子：新增 %d 条", inserted)
    return inserted
