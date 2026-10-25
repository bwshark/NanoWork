/**
 * 审批卡片：把「工具名 + 入参」翻译成一句人话 + 一组展示行。
 *
 * ## 为什么要单独抽一层
 *
 * 旧弹窗直接 `JSON.stringify(args, null, 2)` 铺满 200px 高的滚动块。问题是
 * **信息密度用错了地方**：`apply_patch` 的 `edits` 里塞着整段文件内容、
 * `exec` 的 `command` 是一串 `&&` 拼接，用户要在滚动条里自己找「这到底动
 * 的是哪个文件」。而真正需要被一眼看到的只有两三个事实：动什么、在哪、
 * 影响多大。
 *
 * 因此这里输出两样东西：
 * - `describeApproval()` —— 一句话摘要（卡片正文里加粗的那行）；
 * - `approvalRows()` —— 参数行（每行一个 `label: value`）。
 *
 * ## 两条硬约束
 *
 * 1. **绝不猜**：认不出的工具就不给摘要（`summary` 为 `null`），由调用方
 *    退回「工具名 + 完整参数」的兜底展示。编一句像模像样但可能错的话，
 *    比不编危险得多——用户是照着这句话决定放不放行的。
 * 2. **不丢信息**：参数行是「折叠」不是「删除」。摘要里的路径截断了，
 *    原始值仍在行里（够长的值会被再次截断，但截断处有省略号且保留尾部
 *    ——路径的区分度几乎全在尾部）。
 */

/** 单条参数行的展示上限。approval 卡片是「快速判断」，不是文件查看器 */
const MAX_VALUE_CHARS = 160;

/** 摘要句里路径的展示上限。短到不至于把标题挤成两行 */
const MAX_SUMMARY_PATH = 72;

/** 一个工具的展示形态 */
export interface ApprovalRow {
  /** 参数名（原样，便于用户和模型的说法对上） */
  label: string;
  /** 参数值（规范化为字符串；非字符串的按 JSON 简写） */
  value: string;
}

export interface ApprovalDescriptor {
  /**
   * 一句话摘要；`null` = 不认识这个工具，调用方走兜底展示。
   *
   * 刻意没有默认值：把「认不出」写成 `执行 exec` 这种话，等于用一句空话
   * 冒充结论。
   */
  summary: string | null;
  /** 参数行；顺序稳定（重要参数在前），便于用户形成肌肉记忆 */
  rows: ApprovalRow[];
}

/** 工具名 → 人话动作（与 `AGENT_TOOL_LABELS` 同源口径，但这里更短） */
const ACTION_LABELS: Record<string, string> = {
  write_file: '写入文件',
  edit_file: '编辑文件',
  edit: '编辑文件',
  apply_patch: '修改文件',
  exec: '执行命令',
  delete_file: '删除文件',
};

/** 单条路径的展示形态：超长时保留头尾，中间省略 */
function shortenPath(path: string): string {
  if (path.length <= MAX_SUMMARY_PATH) return path;
  const head = Math.ceil((MAX_SUMMARY_PATH - 1) / 2);
  const tail = MAX_SUMMARY_PATH - 1 - head;
  return `${path.slice(0, head)}…${path.slice(-tail)}`;
}

/** 把任意参数值变成一行可读文本（不做美化，只做归一） */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 截断长值，保留尾部（路径 / 命令的区分度都在尾部） */
function clipValue(text: string): string {
  if (text.length <= MAX_VALUE_CHARS) return text;
  const tail = Math.floor((MAX_VALUE_CHARS - 1) / 2);
  const head = MAX_VALUE_CHARS - 1 - tail;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** 取参数里的第一个字符串字段（多写法兼容：path / file_path / filepath） */
function firstString(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

const PATH_KEYS = ['path', 'file_path', 'filepath', 'file'];

/**
 * `apply_patch` 的 `edits` → 目标路径清单。
 *
 * 引擎的 `apply_patch` **不是** unified diff，而是 `edits: [{path, action, old_text,
 * new_text}]`（见 `@/lib/artifact/fileArtifact` 的 `derivePatchArtifacts`）。因此一条 patch
 * 可能同时动多个文件——摘要必须说清「几个文件」，只报第一个会让用户以为
 * 这次授权只影响一个文件。
 */
function patchPaths(args: Record<string, unknown>): string[] {
  const edits = args.edits;
  if (!Array.isArray(edits)) return [];
  const paths: string[] = [];
  for (const entry of edits) {
    if (typeof entry === 'string') {
      // 引擎之外的实现可能把 edits 传成 JSON 字符串（历史上出现过），
      // 认不出就跳过——这里不是解析器，不承担容错职责。
      continue;
    }
    if (entry && typeof entry === 'object') {
      const p = (entry as Record<string, unknown>).path;
      if (typeof p === 'string' && p.trim() !== '' && !paths.includes(p)) {
        paths.push(p);
      }
    }
  }
  return paths;
}

/** `exec` / `shell` 的命令串（两种键名都出现过） */
function commandOf(args: Record<string, unknown>): string | null {
  return firstString(args, ['command', 'cmd']);
}

/**
 * 生成摘要 + 参数行。
 *
 * 认不出的工具返回 `{ summary: null, rows }`：参数行仍按原样给出（这是唯一
 * 不丢信息的通道），只是不给结论句。
 */
export function describeApproval(
  tool: string,
  args: Record<string, unknown> | null | undefined,
): ApprovalDescriptor {
  const safeArgs = args ?? {};
  const rows = Object.entries(safeArgs).map(([label, value]) => ({
    label,
    value: clipValue(stringifyValue(value)),
  }));

  const name = (tool ?? '').trim();

  switch (name) {
    case 'write_file':
    case 'edit_file':
    case 'edit': {
      const path = firstString(safeArgs, PATH_KEYS);
      const action = ACTION_LABELS[name];
      return {
        summary: path ? `${action} ${shortenPath(path)}` : null,
        rows,
      };
    }

    case 'delete_file': {
      const path = firstString(safeArgs, PATH_KEYS);
      // 删除是唯一不可逆的一类（虽然引擎强制走回收站），摘要里把这一点
      // 说明白——用户看到「删除文件 X」才知道自己在批准什么。
      return {
        summary: path ? `删除文件 ${shortenPath(path)}` : null,
        rows,
      };
    }

    case 'apply_patch': {
      const paths = patchPaths(safeArgs);
      if (paths.length === 0) return { summary: null, rows };
      if (paths.length === 1) {
        return { summary: `修改文件 ${shortenPath(paths[0])}`, rows };
      }
      return {
        summary: `修改 ${paths.length} 个文件：${paths
          .slice(0, 2)
          .map(shortenPath)
          .join('、')}${paths.length > 2 ? ' 等' : ''}`,
        rows,
      };
    }

    case 'exec': {
      const command = commandOf(safeArgs);
      return {
        summary: command ? `执行命令 ${shortenPath(command)}` : null,
        rows,
      };
    }

    default:
      // MCP 工具（`mcp__<服务>__<工具>`）：名字本身就是唯一可读信息，
      // 参数是服务方自定义的，无从归纳。
      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        const server = parts[1] ?? '';
        const method = parts[2] ?? '';
        return {
          summary:
            server && method ? `调用 ${server} 的 ${method}` : `调用 ${name}`,
          rows,
        };
      }
      return { summary: null, rows };
  }
}

/** 工具名的人话说明（摘要认不出时的标题补充） */
export function approvalActionLabel(tool: string): string {
  const name = (tool ?? '').trim();
  if (AGENT_TOOL_LABELS_FALLBACK[name]) return AGENT_TOOL_LABELS_FALLBACK[name];
  if (name.startsWith('mcp__')) return '调用 MCP 工具';
  return '执行操作';
}

/**
 * 兜底用的一小张表。
 *
 * 刻意**不**复用 `@/lib/core/constants` 的 `AGENT_TOOL_LABELS`：那张表是「Agent 工具
 * 白名单编辑器」的候选项文案（「删除（进回收站）」之类），措辞服务于配置页
 * 而不是审批卡片。两处需求会各自漂移，绑在一起只会让改文案的人两边都不敢动。
 */
const AGENT_TOOL_LABELS_FALLBACK: Record<string, string> = {
  write_file: '写入文件',
  edit_file: '编辑文件',
  edit: '编辑文件',
  apply_patch: '修改文件',
  exec: '执行命令',
  delete_file: '删除文件',
};
