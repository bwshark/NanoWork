"""部门树的纯函数（不碰数据库，因此可以逐条单测）。

三个函数对应三件必须做对的事：

1. `subtree_ids`：**知识库共享给「技术部」时，子部门也必须能看到**。少了这条，
   共享语义会随组织长出一层子部门而悄悄变窄——上层以为「整条线都能看」，
   实际只有挂在父节点上的人能看，而界面上没有任何提示。
2. `ordered_for_display`：返回**父在子前**的扁平顺序。客户端因此不必自己搭树，
   按缩进渲染即可；顺序稳定（同级按名字排序）也让「刚建的部门跳到列表末尾」不会发生。
3. `depth_of`：层级上限。树是给组织用的，深到 8 层必然是用错了；不设上限时
   一个脚本就能造出一条长链，之后每次可见性计算都要走完它。
"""

from __future__ import annotations

from collections.abc import Iterable

from app.orgs.models import Department

#: 部门树的最大层数（根为 1）。超过就拒绝新建。
MAX_DEPTH = 8


def children_map(departments: Iterable[Department]) -> dict[str, list[Department]]:
    """父 id → 子部门（同级按名字排序，保证渲染顺序稳定）。"""
    out: dict[str, list[Department]] = {}
    for department in departments:
        out.setdefault(department.parent_id, []).append(department)
    for children in out.values():
        children.sort(key=lambda item: (item.name, item.id))
    return out


def subtree_ids(departments: Iterable[Department], roots: Iterable[str]) -> set[str]:
    """`roots` 及其**全部后代**的 id 集合。

    带访问标记：数据里若出现环（理论上不该有，但父子关系是两次写入的结果），
    这里会让遍历停下来，而不是把请求挂死。
    """
    mapping = children_map(departments)
    seen: set[str] = set()
    stack = [root for root in roots if root]
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        stack.extend(child.id for child in mapping.get(current, []))
    return seen


def ordered_for_display(departments: Iterable[Department]) -> list[Department]:
    """深度优先、父在子前。孤儿节点（父已被删/不存在）当根处理，不能从列表里消失。"""
    items = list(departments)
    mapping = children_map(items)
    known = {department.id for department in items}
    roots = [department for department in items if department.parent_id not in known]
    roots.sort(key=lambda item: (item.name, item.id))

    ordered: list[Department] = []
    seen: set[str] = set()

    def walk(node: Department) -> None:
        if node.id in seen:
            return
        seen.add(node.id)
        ordered.append(node)
        for child in mapping.get(node.id, []):
            walk(child)

    for root in roots:
        walk(root)
    # 环里的节点从任何根都走不到：补在末尾，宁可位置难看也不要让它们凭空消失
    for department in items:
        walk(department)
    return ordered


def child_depth(departments: Iterable[Department], parent_id: str) -> int:
    """在 `parent_id` 下新建一个部门时，**新部门**的层数（根为 1）。

    - 父为空 → 1（新建的是根）；
    - 父不存在 → 0（调用方据此回 422，而不是把孤儿挂上去）；
    - 父链有环 → `MAX_DEPTH + 1`（上层据此拒绝，而不是死循环）。
    """
    if not parent_id:
        return 1
    by_id = {department.id: department for department in departments}
    depth = 1
    current = parent_id
    steps = 0
    while current:
        if current not in by_id:
            return 0
        steps += 1
        if steps > MAX_DEPTH:
            return MAX_DEPTH + 1
        depth += 1
        current = by_id[current].parent_id
    return depth
