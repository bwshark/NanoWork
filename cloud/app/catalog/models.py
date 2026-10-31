"""内置模型目录（云端下发）。

## 为什么这些模型不放客户端

`agnes-3.0-flash` / `agnes-2.5-flash` 是**平台自带**的模型：用户不需要自己找
apiBase、也不需要知道密钥。定义留在客户端（config.json 或代码里）有两个后果：

1. 换一台机器安装后看不到它们 —— 本机 `modelPresets` 是空的，选择器里自然没有；
2. 改一次地址 / 换一次密钥要发版。

所以清单落在云端一张**全局表**里（不是按账户的同步实体），客户端登录后拉取，
按需写进本地引擎配置。这张表回答的是「本产品提供哪些模型」，不是「我配过哪些模型」
——后者是 `sync_items` 里 `collection='models'` 的事（客户端自定义模型仍走同步）。

## 明文密钥是刻意的

引擎跑在用户本机，请求直接从 `apiBase` 发出，所以本地必须持有 apiKey。这里
**原样存储、原样下发**，不做加密：加密只会把明文挪到另一个地方（客户端解密的
那一刻），换不来任何实际边界。真正的边界是「谁能读这个端点」——
`GET` 要求登录，写接口要求运维持有 `NANOWORK_BUILTIN_ADMIN_TOKEN`。
"""

from __future__ import annotations

from datetime import datetime

from sqlmodel import Field, SQLModel

from app.timeutil import utc_now


class BuiltinModel(SQLModel, table=True):
    """一条内置模型（= 引擎里的一个 modelPreset 加它引用的 provider 条目）。"""

    __tablename__ = "builtin_models"  # type: ignore[assignment]

    #: 预设名 —— 也是请求里发出的 `model` 值、选择器里显示的那行字。
    #: 用预设名而不是自增 id：客户端要按它判断「本机是否已经播种过」。
    id: str = Field(primary_key=True)

    #: 交给上游的真实模型名（通常与 `id` 相同，但不强制）
    model: str

    #: 供应商 config key（自定义供应商时预设的 `provider` 就是它，如 `agnes`）
    provider: str = Field(default="")

    #: 供应商展示名（写进 `providers.<key>.displayName`）
    provider_label: str = Field(default="")

    api_base: str = Field(default="")
    api_key: str = Field(default="")

    max_tokens: int = Field(default=32768)
    context_window_tokens: int = Field(default=200_000)
    temperature: float = Field(default=0.1)
    reasoning_effort: str | None = Field(default=None)

    supports_tools: bool = Field(default=True)
    supports_vision: bool = Field(default=False)
    supports_reasoning: bool = Field(default=True)
    custom_protocol: bool = Field(default=False)

    #: 单价（每百万 token）的 JSON 字符串；空串 = 不配。
    #: 存 JSON 而不是三列：客户端那边 `normalizePricing` 已经把「全零 / 缺键」
    #: 折成 `null`，这里再拆成列只会两处各写一遍归一规则。
    pricing_json: str = Field(default="")

    #: 选择器里的一行说明（可选，空串不渲染）
    description: str = Field(default="")

    #: 列表内排序（小在前）。同值时按 `id` 兜底排序，保证两次请求顺序一致。
    sort_order: int = Field(default=0)

    #: 下架开关：关掉后客户端不再下发，但**不会**反向删除用户本机已有的预设。
    #: 删用户的东西比少给一个模型严重得多。
    enabled: bool = Field(default=True)

    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
