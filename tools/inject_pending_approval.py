"""在**跑着的 gateway 进程**里注册一条待裁决审批，用于真机端到端验收。

用法（Windows / Git Bash）：
    cd /d/Workspace/study/nanowork
    ./nanobot/nanobot/.venv/Scripts/python.exe tools/inject_pending_approval.py \
        --channel feishu.feishu --chat-id oc_v3_abc123

⚠️ 为什么需要这个脚本
--------------------
真机验收 C.8 要看的是「桌面端能不能看到 IM 会话挂着的审批卡」。审批注册表
（``PENDING_APPROVALS``）是**进程级内存对象**，外部进程改不了它——
``GET /v1/approvals`` 读的是 gateway 进程里那张表。

于是「在另一个 Python 进程里注册」是**无效**的：那是另一张表，端点读不到。
这个脚本因此改走**渠道入站**这条路：把文本当成一条 inbound 消息投进
gateway 的 bus（``POST /v1/turn``），让引擎**自己**走完「调工具 → 需要审批 →
注册审批 → 挂起等裁决」的全流程。

这条路同时验证了整条链路：审批注册用的是渠道侧的 session key，与
``GET /v1/approvals`` 算出的 key 同形——这是整件事最脆的一环。

⚠️ 前置条件：目标会话必须**已经存在**于引擎磁盘上（``/v1/turn`` 用
``require_existing_session=True``，拼错的 chat_id 会被 404 拒绝）。
先跑一次 ``tools/list_channel_sessions.py`` 看有哪些真实会话。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

GATEWAY_HOST = "127.0.0.1"
GATEWAY_PORT = 18790


def _post(path: str, payload: dict) -> tuple[int, dict]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"http://{GATEWAY_HOST}:{GATEWAY_PORT}{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"error": raw}


def _get(path: str) -> tuple[int, dict]:
    req = urllib.request.Request(f"http://{GATEWAY_HOST}:{GATEWAY_PORT}{path}")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"error": raw}


def main() -> int:
    parser = argparse.ArgumentParser(description="在 gateway 进程里触发一次真实审批挂起")
    parser.add_argument("--channel", required=True, help="运行时渠道名，如 feishu.feishu")
    parser.add_argument("--chat-id", required=True, help="IM 会话 id（须已存在）")
    parser.add_argument(
        "--prompt",
        default="请在当前工作目录创建一个名为 approval-probe.md 的文件，内容写 hello。",
        help="触发写文件工具的指令",
    )
    args = parser.parse_args()

    # 1) 先看目标会话当前有没有挂着审批（确认链路通）
    status, before = _get(
        f"/v1/approvals?channel={args.channel}&chat_id={args.chat_id}"
    )
    print(f"[1] 注入前快照 HTTP {status}: {json.dumps(before, ensure_ascii=False)}")
    if status != 200:
        print("  ⚠️ 快照端点不可用，后续验证无意义", file=sys.stderr)
        return 2

    # 2) 投一条 inbound 消息进 bus，让引擎自己走审批流程
    status, turn = _post(
        "/v1/turn",
        {
            "channel": args.channel,
            "chat_id": args.chat_id,
            "content": args.prompt,
        },
    )
    print(f"[2] 投递轮次 HTTP {status}: {json.dumps(turn, ensure_ascii=False)}")
    if status != 200:
        print(
            "  ⚠️ 轮次没跑起来（会话不存在？模型没配好？），审批不会挂起",
            file=sys.stderr,
        )
        return 3

    # 3) 轮询快照直到出现审批（模型思考 + 调工具需要时间）
    import time

    deadline = time.time() + 180
    last = before
    while time.time() < deadline:
        time.sleep(3)
        status, last = _get(
            f"/v1/approvals?channel={args.channel}&chat_id={args.chat_id}"
        )
        count = len(last.get("approvals") or []) if status == 200 else 0
        print(f"[3] 快照 HTTP {status}, 审批数={count}")
        if count > 0:
            print("\n✅ 审批已挂起，桌面端助理视图应当弹出审批卡：")
            print(json.dumps(last, ensure_ascii=False, indent=2))
            print(
                "\n下一步：在桌面端点「允许本次」，"
                "再回到此脚本用 --resolve 验证裁决落到了引擎那张表上。"
            )
            return 0

    print("\n❌ 180 秒内没有出现审批请求。", file=sys.stderr)
    print(f"   最后一次快照：{json.dumps(last, ensure_ascii=False)}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
