import { DEFAULT_TRANSCRIPTION, useSettingsStore } from '@/stores/settingsStore';
import { fetchSSE, readSSEStream, type SSEStreamEnd } from '@/lib/core/sse';
import { createSseLatencyTracker, type SessionLatencySample } from '@/lib/core/sseLatency';
// MIME 推断统一复用附件模块的扩展名映射表（文档 / 表格 / 幻灯片 / PDF / 文本标记 /
// 配置日志 / 图片 / 音视频），避免出现「Composer 能选、上传时却退化成 octet-stream」
import { inferMime } from '@/lib/artifact/attachments';
import type { ModelInfo, ConnectionStatus, UsageStats } from '@/types';
import type {
  ApprovalDecision,
  ChatHandle,
  ChatRequest,
  ExpertGroupRequest,
  StreamHandlers,
  TranscribeRequest,
  UploadFile,
} from '../types';
import {
  ToolCallAccumulator,
  extractRawToolCalls,
} from './sseToolCalls';
import { extractArtifacts } from './artifactExtractor';
import {
  readPluginIndex,
  setPluginEnabledInEngine,
  type PluginRequestContext,
  type PluginToggleOutcome,
} from './plugins';
import { readUsageFromRuntime, type UsageRequestContext } from './usage';
import type { MemberEventPhase, SubagentEventPhase } from '@/types/process';
import type { PluginEngineIndex } from '@/types/plugin';
import type { DreamReviewResponse } from '../types';

/**
 * 网关 [LOCAL PATCH] 注入的进度事件结构（delta.nanobot_event）。
 * kind=reasoning：深度思考片段；kind=reasoning_end：思考段结束；
 * kind=tool：工具执行阶段事件（phase=start/end/error，含 call_id/name/arguments/result/error）；
 * kind=approval_request：逐条批准请求（引擎已挂起，等待 POST /v1/tool-approvals/{id}）；
 * kind=plan：Plan 模式下 submit_plan 产出的结构化计划（plan_id / steps，FR-1.5）；
 * kind=member：专家团成员生命周期（member / member_event + 该相位的透传载荷，FR-2.4）。
 */
interface NanobotStreamEvent {
  kind?: string;
  content?: string;
  phase?: string;
  call_id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  /** kind=approval_request：审批请求 id / 工具名 / 入参 */
  id?: string;
  tool?: string;
  args?: Record<string, unknown>;
  /** kind=plan：计划 id 与步骤清单 */
  plan_id?: string;
  steps?: Array<{ id?: string; text?: string; status?: string }>;
  /**
   * kind=member：归属成员（`id` / `name`）与生命周期相位 `member_event`；
   * `plan` / `output` / `error` 是该相位的透传载荷（按相位取其一）。
   */
  member?: { id?: string; name?: string };
  member_event?: string;
  output?: string;
  plan?: string;
  /**
   * kind=subagent：归属子代理（`id` / `label`）与生命周期相位 `subagent_event`；
   * `task` / `tool` / `error` 是该相位的透传载荷（按相位取其一）。
   */
  subagent?: { id?: string; label?: string };
  subagent_event?: string;
  task?: string;
}

/** 结果/错误展示文本截断上限（过程时间线仅做摘要展示） */
const PROCESS_TEXT_MAX = 4000;

/** plan 步骤的合法状态（与 `@/types/event` 的 `PlanStep` 一致，此处窄化成字面量元组以便收窄未知值） */
const PLAN_STEP_STATUSES = ['pending', 'running', 'done', 'skipped'] as const;
type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

/**
 * 成员生命周期相位：引擎的 `member_event` → 契约层的窄联合。
 *
 * 用**白名单映射**而不是「原样透传」：引擎将来加了新相位时，旧客户端应当忽略它
 * （少显示一条），而不是把一个自己都不认识的字符串渲染出去——后者迟早会被
 * 某处当成已知相位处理，把「团长在汇总」显示成「成员开始执行」。
 */
const MEMBER_PHASES: Record<string, MemberEventPhase> = {
  group_planned: 'planned',
  member_started: 'started',
  member_finished: 'finished',
  member_failed: 'failed',
  group_aggregating: 'aggregating',
};

/**
 * 子代理相位（FR-2.5 第 4 步）。
 *
 * 与成员相位表同一个纪律：未知相位**忽略不猜**。引擎将来加新相位时，
 * 这里不补映射的表现是「少显示一条」，而不是把不认识的状态渲染成「已完成」。
 */
const SUBAGENT_PHASES: Record<string, SubagentEventPhase> = {
  started: 'started',
  tool: 'tool',
  done: 'done',
  error: 'error',
};

/** 任意工具结果转展示文本：字符串原样、其余 JSON 序列化，超长截断 */
function toDisplayText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return undefined;
  return text.length > PROCESS_TEXT_MAX ? `${text.slice(0, PROCESS_TEXT_MAX)}…` : text;
}

/** 可达性探测的超时。探测要短：心跳是周期任务，单次挂起会堆积下一次。 */
const PROBE_TIMEOUT_MS = 3000;

/**
 * 判定「该端点没有 `/health` 路由」的 HTTP 状态。
 * nanobot 用 aiohttp，未知路径一律 404；405/501 兼容其它实现。
 */
const HEALTH_ABSENT_STATUSES = new Set([404, 405, 501]);

/**
 * 由 `/v1` 基址推同源的健康检查地址。
 *
 * `/health` 注册在**根路径**（`nanobot/api/server.py` 的 `add_get("/health", ...)`），
 * 不在 `/v1` 之下，所以要剥掉末段的版本前缀。
 * 开发态代理同理：`/api/nanobot/v1` → `/api/nanobot/health`。
 */
function healthUrlOf(endpoint: string): string {
  return `${endpoint.replace(/\/v\d+$/, '')}/health`;
}

/**
 * 契约层专家团 → 引擎 wire 形态（`expert_group`）。
 *
 * 键名 camelCase → snake_case 的转换收在这里（与 workspace / tool_allow 同款分工），
 * 契约类型因此不必出现引擎的键名。可选字段只在**存在**时写出——不要用 `?? ''` 之类
 * 把它们填成确定值，否则「未声明的人设」会变成一段空字符串人设发下去。
 */
function expertGroupWire(group: ExpertGroupRequest): Record<string, unknown> {
  return {
    mode: group.mode,
    members: group.members.map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.systemPrompt ? { system_prompt: m.systemPrompt } : {}),
      ...(m.toolAllow !== undefined ? { tool_allow: m.toolAllow } : {}),
      ...(m.toolDeny !== undefined ? { tool_deny: m.toolDeny } : {}),
      ...(m.model ? { model: m.model } : {}),
    })),
    ...(group.lead ? { lead: group.lead } : {}),
    ...(group.aggregate ? { aggregate: group.aggregate } : {}),
    ...(group.maxConcurrent !== undefined ? { max_concurrent: group.maxConcurrent } : {}),
  };
}

/**
 * nanobot 网关**传输层**：直连 OpenAI 兼容 SSE 流式接口。
 *
 * 定位（D1 分层）：本文件只负责「把一次请求发出去、把字节流解成事件」，
 * 是 `NanobotHttpRuntime` 之下的 transport 原语。对外契约是
 * `AgentRuntime.chat()` / `abort()`；`sendMessage()` 返回句柄的形态是
 * transport 级细节，不向 UI/store 暴露（见 ../types.ts 顶部边界约定）。
 *
 * 经源码确认：nanobot 当前 /v1/chat/completions 仅流式返回 `delta.content`
 * 纯文本，不含 tool_calls / artifacts 事件，但支持 `session_id` 隔离与会话
 * 文件上传。本实现：
 *   1) 透传 session_id（会话级隔离）；
 *   2) 支持随请求上传文件（multipart/form-data，对齐 nanobot API）；
 *   3) 按 OpenAI 规范增量解析 delta.tool_calls（未来网关/代理下发时自动生效，
 *      当前版本静默跳过，不影响文本流）；
 *   4) 流结束后对完整文本做 artifact 启发式提取（code/mermaid/html 围栏块），
 *      对标 WorkBuddy 富产物内联渲染。
 */
export class NanobotClient {
  readonly kind = 'nanobot' as const;

  /**
   * `/health` 可用性结论缓存：endpoint → 是否支持（`false` 表示已确认没有此路由）。
   *
   * 缓存是必须的：没有它，第三方端点每次心跳都要先吃一个 404 再回退 `/models`，
   * 反而比改前多一次往返。
   *
   * 不设过期。判定失准只会让某个端点多打一次 `/models`——结果依然正确，只是略费；
   * 不会把可用网关误判成离线。键是端点字符串，条目数由用户配置过的端点数决定，
   * 不会无限增长。
   */
  private readonly healthSupport = new Map<string, boolean>();

  /**
   * 引擎正挂起等待用户裁决的批准请求：id → 登记时刻（FR-1.5）。
   *
   * 引擎此时阻塞在 `before_execute_tool` 里，SSE 上**一个字节都不会有**——这段
   * 静默是「人在思考」，不是链路故障。只要集合里有**未过期**的挂起请求，静默超时
   * 就只重新布防、不开火（详见 `sendMessage` 的 timer 逻辑），否则用户盯着授权
   * 弹窗想两分钟，流就被我们自己掐了（引擎侧要等自己的超时才判拒，宽松得多）。
   *
   * 记时刻而不是只存 id：裁决可能永远不回来（用户中途中断、引擎进程被杀），
   * 过期即作废，免得一个陈旧 id 永久抑制所有会话的静默超时。
   *
   * 粒度是「客户端级」而非「会话级」：裁决事件本身不带会话标识，而误判方向
   * 偏保守（宁可少杀一次超时）是可接受的取舍。
   */
  private readonly pendingApprovals = new Map<string, number>();

  /**
   * 等裁决时允许的最长静默。
   *
   * 引擎侧的裁决等待默认 300s（超时按拒绝处理），这里取 3 倍余量：既覆盖
   * 「用户慢慢看」，也不至于让一个再也不回来的裁决把链路判死能力永久关掉。
   */
  private static readonly APPROVAL_WAIT_MAX_MS = 900_000;

  /**
   * 归一化 endpoint 并做开发态代理改写。
   * 开发模式下访问默认本地网关时改走 Vite dev server 代理，避免浏览器 CORS 拦截。
   */
  private resolveEndpoint(raw: string): string {
    const endpoint = raw.replace(/\/+$/, '');
    if (import.meta.env.DEV && endpoint === 'http://127.0.0.1:8900/v1') {
      return '/api/nanobot/v1';
    }
    return endpoint;
  }

  private getConfig() {
    const { gatewayEndpoint, apiToken } = useSettingsStore.getState().settings;
    return { endpoint: this.resolveEndpoint(gatewayEndpoint), token: apiToken };
  }

  /** 鉴权头；token 缺省时用网关 token，转录服务单独配了 key 时以其为准 */
  private authHeaders(token?: string): Record<string, string> {
    const effective = token ?? this.getConfig().token;
    return effective ? { Authorization: `Bearer ${effective}` } : {};
  }

  /**
   * 探测网关可达性。
   *
   * 优先打引擎的常量健康检查 `GET /health`（返回 `{"status":"ok"}`），
   * 而不是 `GET /v1/models`：后者每次都要遍历 modelPresets 组装一遍模型目录
   * （`nanobot/api/server.py` 的 `handle_models`）。心跳是应用空闲时的**唯一
   * 稳态 HTTP 流量**，往返次数与单次成本都值得挑最省的。
   *
   * `gatewayEndpoint` 用户可配，可能指向没有 `/health` 的第三方 OpenAI 兼容
   * 服务（vLLM / LM Studio / 官方 API），因此带一次回退：确认无此路由后记入
   * `healthSupport`，此后固定走 `/models`，不会每跳都先吃一个 404。
   */
  async probe(): Promise<ConnectionStatus> {
    const { endpoint } = this.getConfig();

    if (this.healthSupport.get(endpoint) !== false) {
      const res = await this.fetchProbe(healthUrlOf(endpoint));
      // 连不上 / 超时：网关真的不可达，没必要再拿 `/models` 试第二遍
      if (!res) return 'offline';
      if (res.ok) return 'connected';
      // 只在「路由确实不存在」时永久降级。5xx 属临时故障，不写缓存——
      // 否则一次抖动就把这个端点永久降级成每跳多打一个请求。
      if (HEALTH_ABSENT_STATUSES.has(res.status)) this.healthSupport.set(endpoint, false);
    }

    return this.probeViaModels(endpoint);
  }

  /** 回退路径：`/health` 不可用时按原语义打 `/v1/models` */
  private async probeViaModels(endpoint: string): Promise<ConnectionStatus> {
    const res = await this.fetchProbe(`${endpoint}/models`);
    return res?.ok ? 'connected' : 'offline';
  }

  /**
   * 带超时的探测请求。
   * 网络层失败（拒连 / 超时 / DNS）返回 `null`，与「有响应但状态码非 2xx」区分开：
   * 前者说明不可达，后者说明可达但语义不对，两者后续处理不同。
   */
  private async fetchProbe(url: string): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      return await fetch(url, { headers: this.authHeaders(), signal: controller.signal });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 列出可用模型 */
  async listModels(): Promise<ModelInfo[]> {
    const { endpoint } = this.getConfig();
    const res = await fetch(`${endpoint}/models`, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new Error(`获取模型列表失败：HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      data?: Array<{ id: string; label?: string; model?: string }>;
    };
    return (json.data ?? []).map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      model: m.model ?? m.id,
    }));
  }

  /**
   * 读引擎侧插件索引（`GET /v1/plugins`，FR-3.4）。
   *
   * 复用本类的 endpoint 解析与鉴权头（含开发态代理改写）——`plugins.ts`
   * 只管 wire，不自己拼地址，否则开发态要改两处。
   */
  listPlugins(): Promise<PluginEngineIndex> {
    return readPluginIndex(this.pluginContext());
  }

  /** 切换插件启停（`POST /v1/plugins/{name}`） */
  setPluginEnabled(name: string, enabled: boolean): Promise<PluginToggleOutcome> {
    return setPluginEnabledInEngine(this.pluginContext(), name, enabled);
  }

  private pluginContext(): PluginRequestContext {
    const { endpoint } = this.getConfig();
    return { endpoint, headers: this.authHeaders() };
  }

  /**
   * 读本机 LLM 用量报表（`GET /v1/usage`，FR-11.1）。
   *
   * 与插件域同款分工：endpoint 解析与鉴权头复用本类（含开发态代理改写），
   * `usage.ts` 只管 wire 与解码。
   */
  readUsage(): Promise<UsageStats> {
    return readUsageFromRuntime(this.usageContext());
  }

  private usageContext(): UsageRequestContext {
    const { endpoint } = this.getConfig();
    return { endpoint, headers: this.authHeaders() };
  }

  /**
   * 构造请求体 / 请求参数。
   * 无文件 → JSON + body；有文件 → multipart/form-data（对齐 nanobot 的 -F files=@）。
   *
   * 注意：nanobot serve 的 /v1/chat/completions 硬性只接受单条 user message，
   * 多轮上下文由服务端 session_id 维护。因此前端把 system 角色提示（Agent 身份、记忆等）
   * 拼接到当前用户输入前面，作为单条 user message 发送，否则 Agent 切换/身份提示不会生效。
   */
  private buildRequest(req: ChatRequest): {
    headers: Record<string, string>;
    body?: string;
    form?: FormData;
  } {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';

    // 收集 system 段（Agent systemPrompt、记忆标签块等），拼接到用户输入前
    const systemParts = req.messages
      .filter((m) => m.role === 'system' && typeof m.content === 'string' && m.content.trim() !== '')
      .map((m) => m.content as string);
    const combinedText =
      systemParts.length > 0
        ? `${systemParts.join('\n\n')}\n\n---\n\n${userText}`
        : userText;

    const singleMessage = { role: 'user' as const, content: combinedText };

    // 空值时省略 model，让网关使用其配置默认模型
    const effectiveModel = req.model && req.model.trim() ? req.model : undefined;
    const base: Record<string, unknown> = {
      messages: [singleMessage],
      stream: true,
      ...(effectiveModel ? { model: effectiveModel } : {}),
      ...(req.sessionId ? { session_id: req.sessionId } : {}),
      // 会话级工作空间 / 权限：引擎按 turn 解析 workspace_scope 生效
      ...(req.workspace ? { workspace: req.workspace } : {}),
      ...(req.accessMode ? { access_mode: req.accessMode } : {}),
      // 逐条批准开关：与 access_mode 同处会话级 scope（tool_approval 轴）
      ...(req.approvalMode ? { approval_mode: req.approvalMode } : {}),
      // 执行模式：与上面三轴同处会话级 scope（session_mode 轴，FR-1.4）
      ...(req.sessionMode ? { session_mode: req.sessionMode } : {}),
      // Agent 工具白名单（FR-2.2，第四根轴）：由引擎的工具网关强制，不靠提示词。
      // 判据是「不是 undefined」——空数组是**已声明的空白名单**（一个工具都不许），
      // 用真值判断会把它当成「未声明」从而静默放开全部工具。
      ...(req.agentId ? { agent_id: req.agentId } : {}),
      ...(req.toolAllow !== undefined ? { tool_allow: req.toolAllow } : {}),
      ...(req.toolDeny !== undefined ? { tool_deny: req.toolDeny } : {}),
      // 专家团编排（FR-2.4 路径②）：命中时由引擎按成员派发，本轮不再走单 Agent loop
      ...(req.expertGroup ? { expert_group: expertGroupWire(req.expertGroup) } : {}),
    };
    const auth = this.authHeaders();

    if (!req.files || req.files.length === 0) {
      return {
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(base),
      };
    }

    // 多文件上传：message=拼接后的用户文本，files=多个 base64 解码后的文件
    //
    // 注意（已核对 nanobot/nanobot/api/server.py 的 _parse_multipart）：
    // multipart 路径只识别 message / session_id / model / workspace / access_mode /
    // approval_mode / session_mode / agent_id / tool_allow / tool_deny /
    // expert_group / files，
    // **不解析 stream**，该分支下 stream 恒为 False，
    // 网关只会回完整 JSON（非 SSE）。
    // 因此前端必须兼容非流式响应（见 streamFormRequest.handleNonStreamResponse）。
    // 这里仍补上 stream：网关后续若支持 multipart 流式，前端无需改动即可自动生效。
    const form = new FormData();
    form.append('message', combinedText);
    form.append('stream', 'true');
    // model 是 multipart 明确支持的字段，漏传会让「会话里选的模型」在带文件时失效
    if (effectiveModel) form.append('model', effectiveModel);
    if (req.sessionId) form.append('session_id', req.sessionId);
    if (req.workspace) form.append('workspace', req.workspace);
    if (req.accessMode) form.append('access_mode', req.accessMode);
    if (req.approvalMode) form.append('approval_mode', req.approvalMode);
    // multipart 分支的 server 侧解析已同步支持 session_mode；上传文件时也带上，
    // 否则「带附件的一轮」会静默退回 craft（只读约束在这一轮失效）
    if (req.sessionMode) form.append('session_mode', req.sessionMode);
    // 带附件的一轮也必须带上 Agent 工具策略，否则「带附件」成为最小权限的旁路
    // （与 session_mode 同样的漏法）。multipart 没有原生数组，用逗号分隔串——
    // 引擎侧 `normalize_tool_names` 接受这个形态。空数组发成空串，语义是
    // 「已声明的空白名单」，与 JSON 分支保持一致。
    if (req.agentId) form.append('agent_id', req.agentId);
    if (req.toolAllow !== undefined) form.append('tool_allow', req.toolAllow.join(','));
    if (req.toolDeny !== undefined) form.append('tool_deny', req.toolDeny.join(','));
    // 带附件的一轮也必须带上专家团清单，否则「带附件」会成为专家团编排的旁路
    // （与 session_mode / agent_id 同款漏法）。multipart 无嵌套对象，用 JSON 串承载，
    // 引擎侧 `_parse_multipart` 会 json.loads 回来。
    if (req.expertGroup) {
      form.append('expert_group', JSON.stringify(expertGroupWire(req.expertGroup)));
    }
    req.files.forEach((f: UploadFile) => {
      const mime = f.mimeType ?? inferMime(f.name);
      const bytes = Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0));
      form.append('files', new Blob([bytes], { type: mime }), f.name);
    });
    // multipart 不能手动设 Content-Type（浏览器自动加 boundary），仅附加鉴权
    return { headers: { ...auth }, form };
  }

  /**
   * 语音转文字：POST `{endpoint}/audio/transcriptions`（multipart: file + model）。
   *
   * 配置来源为 settings.transcription：endpoint 留空复用网关地址，
   * token 留空复用网关 key；模型未配则直接抛错（不带模型请求多数网关会 400）。
   */
  async transcribe(req: TranscribeRequest): Promise<string> {
    const { transcription, gatewayEndpoint } = useSettingsStore.getState().settings;
    const cfg = transcription ?? DEFAULT_TRANSCRIPTION;
    if (!cfg.enabled) {
      throw new Error('未启用语音输入，请先到「设置 → 语音输入」开启');
    }
    const model = cfg.model.trim();
    if (model === '') {
      throw new Error('未配置转录模型（如 whisper-1）');
    }
    // endpoint 留空 → 复用网关（多数自部署网关与 LLM 共用同一服务）
    const raw = cfg.endpoint.trim() !== '' ? cfg.endpoint : gatewayEndpoint;
    const endpoint = this.resolveEndpoint(raw);

    const form = new FormData();
    form.append('file', req.audio, req.filename ?? 'voice.webm');
    form.append('model', model);
    // 语言：请求级优先，其次配置级；都为空则交给服务端自动检测
    const language = (req.language ?? '').trim() || cfg.language.trim();
    if (language !== '') form.append('language', language);
    if (req.prompt && req.prompt.trim() !== '') form.append('prompt', req.prompt.trim());

    const res = await fetch(`${endpoint}/audio/transcriptions`, {
      method: 'POST',
      // multipart 不能手动设 Content-Type（浏览器自动补 boundary），仅附加鉴权
      headers: this.authHeaders(cfg.apiToken.trim() || undefined),
      body: form,
    });
    if (!res.ok) {
      throw new Error(`转录失败：HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { text?: string };
    const text = (json.text ?? '').trim();
    if (text === '') throw new Error('转录结果为空，请重试');
    return text;
  }

  /**
   * 回传一条逐条批准的裁决（FR-1.5）。
   *
   * 引擎此时正阻塞在 `before_execute_tool` 里等这个结果，因此这是**独立于
   * SSE 流之外**的一次 POST——流本身是单向的，塞不进去。
   *
   * 404 表示请求已超时 / 已被取消 / 已裁决过：必须抛错让 UI 如实提示
   * 「该授权已失效」，吞掉会误导用户以为工具已放行。
   *
   * 副作用：把该请求从 `pendingApprovals` 摘掉，让静默超时恢复正常计时。
   */
  /**
   * 让引擎**热加载**磁盘上的配置（模型增删改 / 换默认模型「保存即生效」）。
   *
   * 为什么需要它：`/v1/models` 来自引擎启动时装配的预设目录，光写配置文件不起作用，
   * 以前只能靠重启网关。返回 `false` 表示这个网关不支持热加载（老版本），调用方
   * 据此退回「需重启」提示——不抛错，因为「不支持」不是失败。
   */
  async reloadEngineConfig(): Promise<boolean> {
    const { endpoint } = this.getConfig();
    try {
      const res = await fetch(`${endpoint}/config/reload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      });
      // 404/501 = 端点不存在（老网关）；其余不 ok 也不该阻断保存——配置已写盘。
      return res.ok;
    } catch {
      return false;
    }
  }

  async respondApproval(
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<void> {
    const { endpoint } = this.getConfig();
    try {
      const res = await fetch(
        `${endpoint}/tool-approvals/${encodeURIComponent(requestId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
          body: JSON.stringify({
            decision,
            ...(reason && reason.trim() !== '' ? { reason } : {}),
          }),
        },
      );
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? '该工具调用已失效（可能已超时或被取消），请重新发起'
            : `回传工具裁决失败：HTTP ${res.status} ${res.statusText}`,
        );
      }
    } finally {
      // 无论成没成都摘掉挂起标记：404 说明引擎已自行超时判拒，网络失败时引擎
      // 也会在自身超时后继续——留着会让这个 id 永久抑制静默超时（内存与语义双漏）。
      this.pendingApprovals.delete(requestId);
    }
  }

  /**
   * FR-4.6 Dream 审查闸门：拉取待审查的候选 diff。
   *
   * 网关开闸门（默认开）时，Dream 的合并产物先落 `memory/.dream_candidate/`，
   * 不直写 `MEMORY.md`。客户端从这里拿到「新增 / 修改 / 删除」三类 diff 供人审。
   * 没有候选时返回 `{ pending: false }`。
   */
  async getDreamReview(): Promise<DreamReviewResponse> {
    const { endpoint } = this.getConfig();
    const res = await fetch(`${endpoint}/dream/review`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
    });
    if (!res.ok) {
      throw new Error(`拉取 Dream 候选失败：HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as DreamReviewResponse;
  }

  /**
   * FR-4.6 Dream 审查闸门：采纳候选，把变化写回正式记忆文件。
   */
  async acceptDream(): Promise<{ ok: boolean; updated: number }> {
    const { endpoint } = this.getConfig();
    const res = await fetch(`${endpoint}/dream/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
    });
    if (!res.ok) {
      throw new Error(`采纳 Dream 候选失败：HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as { ok: boolean; updated: number };
  }

  /**
   * FR-4.6 Dream 审查闸门：丢弃候选，正式记忆文件不动。
   */
  async rejectDream(): Promise<{ ok: boolean }> {
    const { endpoint } = this.getConfig();
    const res = await fetch(`${endpoint}/dream/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
    });
    if (!res.ok) {
      throw new Error(`丢弃 Dream 候选失败：HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as { ok: boolean };
  }

  /**
   * 静默超时（idle timeout）参数。
   *
   * 判据是**「多久收不到任何字节算链路已死」**，而不是「整轮请求最多跑多久」。
   * 早期实现按总时长掐表（固定 120s），一轮里工具调用多、模型输出长的任务会在
   * 流**正常推进**时被客户端单方面 abort——用户看到「超时：超过 120 秒仍未返回
   * 完整结果」，而网关其实还在跑（「写个小游戏并保存到本地」就会撞上）。
   * 产品要求长任务支持小时级运行，因此计时器改为**每次收到数据即归零**：
   * 只要链路一直在动，请求就可以一直跑下去。
   *
   * 基准 120s 覆盖「单次工具执行 + 一次模型往返」的常规静默；带附件时按体积追加
   * 额度（网关要解码、解析文档再交给模型，几十 MB 的 PDF/DOCX 往往远超 120s）。
   *
   * 唯一的例外见 `pendingApprovals`：等用户裁决时链路本来就是静默的。
   */
  private static readonly IDLE_BASE_MS = 120_000;
  private static readonly IDLE_PER_MB_MS = 60_000;
  private static readonly IDLE_MAX_MS = 600_000;

  /**
   * 计算本次请求的静默额度（连续多久收不到任何字节即判定断链）。
   *
   * - 首字节前：这段额度用来容忍网关排队、解析附件的时间；
   * - 流展开后：用来容忍两次事件之间的间隔（模型思考、单次工具执行）。
   *
   * 两种情形共用一份额度是有意为之：附件只有在「交给模型之前」才需要额外时间，
   * 而那时正好落在首字节前，所以按体积追加一次即可，无需两套参数。
   */
  private resolveIdleWindow(req: ChatRequest): number {
    // content 为 base64，解码后体积约为其长度的 3/4
    const bytes = (req.files ?? []).reduce(
      (sum, f) => sum + Math.floor(((f.content?.length ?? 0) * 3) / 4),
      0,
    );
    if (bytes === 0) return NanobotClient.IDLE_BASE_MS;
    return Math.min(
      NanobotClient.IDLE_MAX_MS,
      NanobotClient.IDLE_BASE_MS +
        Math.ceil(bytes / (1024 * 1024)) * NanobotClient.IDLE_PER_MB_MS,
    );
  }

  /**
   * 是否仍有「有效期内」的挂起裁决，并顺手清理过期条目。
   *
   * 拆成独立方法而不是内联在 timer 里：清理是**副作用**，需要有名字、有注释，
   * 也需要被单测的语义覆盖（见 `pendingApprovals`）。
   */
  private hasFreshApprovalWait(): boolean {
    const now = Date.now();
    for (const [id, registeredAt] of this.pendingApprovals) {
      if (now - registeredAt >= NanobotClient.APPROVAL_WAIT_MAX_MS) {
        this.pendingApprovals.delete(id);
      }
    }
    return this.pendingApprovals.size > 0;
  }

  /**
   * 静默超时的报错文案。
   *
   * 「还没开口」与「说到一半断了」必须分开说：前者多半是网关还在排队 / 处理，
   * 重试即可能成功；后者说明链路中途断了，已收到的内容是残缺的。
   * 另外**只有**带附件的轮次才提附件——无附件时提示「附件越大网关处理越久」
   * 只会让用户一头雾水（这正是报障截图里的那句）。
   *
   * 注意判据是「是否解析出过负载」而非「是否收到过字节」：网关会先回响应头再
   * 长时间思考，只按字节判断会把「迟迟不出第一个字」误报成「已收到部分结果」。
   */
  private timeoutMessage(info: {
    /** 是否已解析出过内容（决定是「还没开口」还是「说到一半」） */
    gotContent: boolean;
    /** 距离最后一次收到数据的静默时长 */
    silentMs: number;
    /** 本轮是否带附件（决定重试建议） */
    hasFiles: boolean;
  }): string {
    const silentS = Math.max(1, Math.round(info.silentMs / 1000));
    if (info.gotContent) {
      return (
        `响应超时：已收到部分结果，但此后 ${silentS} 秒无新数据。` +
        (info.hasFiles
          ? '可重试，或先压缩 / 拆分附件再发送。'
          : '可重试；若反复超时请检查网关是否正常。')
      );
    }
    return (
      `响应超时：${silentS} 秒内网关没有返回任何内容。` +
      (info.hasFiles
        ? '网关可能仍在解码 / 解析附件，可重试或先压缩、拆分附件再发送。'
        : '网关可能仍在处理，可重试；若反复超时请检查网关是否正常。')
    );
  }

  /**
   * 发送消息并流式接收。
   * 事件顺序：onStatus('thinking') → onReasoning*（其间 onStatus('reasoning')）/
   * onProcessTool*（进度事件）→ onToken* → onToolCall* → onArtifact* →
   * onStatus('done') → onDone()。
   *
   * 取消语义（FR-中断）：返回的 ChatHandle.abort() 会立即终止底层 SSE；
   * fetchSSE / streamFormRequest 把中断视为正常结束（不通过 onError 上报），
   * 已累积的文本/工具调用/富产物在 abort 时停止接收，不再做最终的 flush / artifact 启发式提取。
   *
   * 超时与手动 abort 的区别：手动 abort 静默结束；超时则必须通过 onError 显式报错，
   * 否则用户只看到消息停在半截、界面毫无提示，会误以为程序崩了。
   *
   * 超时是**静默超时**而非总时长上限：每收到一次数据（响应头 / 任意字节，含
   * keep-alive 帧）计时器就归零，因此长任务只要网关还在持续输出就不会被打断，
   * 只有连续 `resolveIdleWindow()` 毫秒毫无动静才判定链路已死。
   * 唯一例外是引擎挂起等用户裁决的那段静默（见 `pendingApprovals`）。
   *
   * 收尾判定共三类，顺序不可颠倒（见 `runStream` 的 2.5 步）：
   * - 用户 abort 或静默超时 → 提前返回（后者另经 onError 报错）；
   * - **异常结束** → `onInterrupted`，且**不**再 flush 工具调用 / 提取产物；
   * - 其余 → 正常收尾（flush + artifact + onStatus('done') + onDone）。
   *
   * 「异常结束」= `finish_reason` 为 `error`/`length`，或 SSE body 提前结束而没发
   * `[DONE]`。旧实现只看「流有没有断」而不看这两样，于是被掐断的一轮会被宣布成完成
   * （2026-09-29 断流事故）。
   */
  sendMessage(req: ChatRequest, handlers: StreamHandlers): ChatHandle {
    const controller = new AbortController();
    const idleWindow = this.resolveIdleWindow(req);
    const hasFiles = (req.files?.length ?? 0) > 0;

    // 用可控 timer 代替 AbortSignal.timeout：既需要区分中断来源，也需要能在
    // 每次收到数据后归零（见类内 IDLE_* 常量说明）。
    let timedOut = false;
    // 是否解析出过真实内容：只影响超时文案（「说到一半断了」vs「还没开口」）
    let gotContent = false;
    // 计时基准：还没收到任何数据时是「请求发出时刻」，收到过之后是「最后一次收到数据的时刻」
    let idleSince = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 重新武装计时器（幂等：先清掉旧的那一个） */
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // 引擎挂起等人裁决时链路本来就是静的（见 pendingApprovals）：只重新布防。
        // 但「等人」是有期限的——过期条目先清掉，避免一个再也不回来的裁决
        // 把这条链路的判死能力永久关掉。
        if (this.hasFreshApprovalWait()) {
          arm();
          return;
        }
        timedOut = true;
        controller.abort();
      }, idleWindow);
    };
    /** 收到任何数据（响应头 / 任意字节，含 keep-alive 帧）：归零静默计时 */
    const touch = () => {
      idleSince = Date.now();
      arm();
    };
    /** 解析出一条真实负载（内容 / 工具 / 计划事件）：说明网关已经开口 */
    const noteContent = () => {
      gotContent = true;
    };
    arm();

    // 不抛错的 done：避免外部 await 误判；真正的错误由 onError 透传
    const done = this.runStream(req, handlers, controller.signal, touch, noteContent)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        if (timedOut) {
          handlers.onError(
            new Error(
              this.timeoutMessage({
                gotContent,
                silentMs: Date.now() - idleSince,
                hasFiles,
              }),
            ),
          );
        }
      });

    return {
      done,
      abort: () => controller.abort(),
    };
  }

  /**
   * 流式请求的实际执行体；与 ChatHandle 解耦。signal 中断由 fetchSSE/streamFormRequest 内部识别为正常结束。
   *
   * - `onActivity`：传输层每次收到数据（响应头 / 任意字节）时回调，用于静默超时计时；
   * - `onPayload`：解析出一条真实负载时回调（内容 / 工具 / 计划事件），仅用于让
   *   超时文案区分「说到一半断了」与「还没开口」（见 `sendMessage`）。
   */
  private async runStream(
    req: ChatRequest,
    handlers: StreamHandlers,
    signal: AbortSignal,
    onActivity: () => void,
    onPayload: () => void,
  ): Promise<void> {
    if (signal.aborted) return;
    const { endpoint } = this.getConfig();
    handlers.onStatus('thinking');

    const { headers, body, form } = this.buildRequest(req);
    const accumulator = new ToolCallAccumulator();
    let fullText = '';
    /**
     * 本轮是否已经通过 onError 报过错。
     *
     * 协议级失败（HTTP 非 2xx / body 缺失 / 帧解析失败）与「异常结束」都发生在同一次
     * 调用里，两处都上报会让用户看到两条互相矛盾的提示（「发送失败」+「已中断」）。
     * 有一处报过就不再叠加（见收尾处的异常结束判定）。
     */
    let reportedError = false;
    const reportError = (err: Error) => {
      reportedError = true;
      handlers.onError(err);
    };
    /**
     * 引擎在终结帧里给出的 `finish_reason`。
     *
     * nanobot 只在流末尾发一帧（`{delta: {}, finish_reason: ...}`），通常与 `[DONE]`
     * 同批到达。它是「引擎承认自己失败 / 被截断」的唯一显式信号，2026-09-29 事故里
     * 客户端从不读它，于是断流与正常收尾完全同形。
     */
    let finishReason: string | null = null;

    const requestInit: RequestInit = {
      method: 'POST',
      headers,
      signal,
    };
    if (form) {
      requestInit.body = form as unknown as BodyInit;
    } else {
      requestInit.body = body;
    }

    // 文本流走 fetchSSE；文件流走标准 fetch（nanobot 文件上传也可能纯文本流）
    const useForm = !!form;
    const streamUrl = `${endpoint}/chat/completions`;

    // —— 会话延迟埋点（FR-11.7）：响应头 → 首字节 → 首 token ——
    // `onActivity` 在本轮里承担了两种语义（响应头到 / 每个字节到），而首字延迟需要
    // 一个**唯一**的首字节时刻，故另接一个只报一次的 `onFirstByte`（见 sse.ts 的注释）。
    const latency = createSseLatencyTracker();
    let sawResponseHeaders = false;
    const trackActivity = () => {
      if (!sawResponseHeaders) {
        sawResponseHeaders = true;
        latency.markStart();
      }
      onActivity();
    };
    const trackFirstByte = () => latency.markFirstByte();

    const onChunk = (data: string) => {
      if (data === '[DONE]') return;
      // 中断后即使收到迟到的帧也不再回调给 store
      if (signal.aborted) return;
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: unknown;
              nanobot_event?: NanobotStreamEvent;
            };
            finish_reason?: string | null;
          }>;
        };
        const choice = json.choices?.[0];
        // 终结帧按标准 OpenAI 形状**只有 finish_reason、没有 delta**：必须先取它，
        // 再判 delta 是否存在，否则这一帧会被整体丢掉，异常结束就再也认不出来了。
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) return;

        // 帧结构合法 = 网关已经「开口」：超时文案据此区分断链与未响应。
        // 放在 delta 判空之后而不是 onChunk 开头：解析失败的脏帧不算开口。
        onPayload();

        // 1) 文本流
        if (delta.content) {
          // 先打点再回调：`onToken` 会把内容写进 store 并触发渲染，之后再打点
          // 等于把「渲染开销」也算进了首字延迟。
          latency.markFirstToken();
          fullText += delta.content;
          handlers.onToken(delta.content);
          handlers.onStatus('streaming');
        }

        // 1.5) nanobot 进度事件（网关 [LOCAL PATCH] 注入：深度思考 / 工具执行行）
        const nbEvent = delta.nanobot_event;
        if (nbEvent) {
          if (nbEvent.kind === 'reasoning' && nbEvent.content) {
            handlers.onReasoning?.(nbEvent.content);
            // 深度思考正文正在回吐 → 独立状态，区别于「首帧未到」的 thinking
            handlers.onStatus('reasoning');
          } else if (nbEvent.kind === 'reasoning_end') {
            handlers.onReasoningEnd?.();
            // 思考段收束：回到「等待模型响应」，等待正文首帧或下一个思考段
            handlers.onStatus('thinking');
          } else if (nbEvent.kind === 'tool' && nbEvent.name) {
            const phase =
              nbEvent.phase === 'end' ? 'end' : nbEvent.phase === 'error' ? 'error' : 'start';
            handlers.onProcessTool?.({
              id: String(nbEvent.call_id || `nbtool-${nbEvent.name}`),
              tool: String(nbEvent.name),
              args: nbEvent.arguments ?? {},
              phase,
              result: phase === 'end' ? toDisplayText(nbEvent.result) : undefined,
              error: phase === 'error' ? toDisplayText(nbEvent.error) : undefined,
            });
            handlers.onStatus(phase === 'start' ? 'tooling' : 'thinking');
          } else if (nbEvent.kind === 'approval_request' && nbEvent.id) {
            // 引擎已阻塞在工具执行前等裁决：把请求交给上层弹窗，
            // 裁决经 respondApproval() 走 POST /v1/tool-approvals/{id} 送回。
            // 同时登记为「挂起中」——这段静默不算链路故障（见 pendingApprovals）。
            const approvalId = String(nbEvent.id);
            this.pendingApprovals.set(approvalId, Date.now());
            handlers.onApprovalRequest?.({
              id: approvalId,
              tool: String(nbEvent.tool ?? ''),
              args: nbEvent.args ?? {},
              ...(nbEvent.call_id ? { callId: String(nbEvent.call_id) } : {}),
            });
            handlers.onStatus('tooling');
          } else if (nbEvent.kind === 'member' && nbEvent.member_event) {
            // FR-2.4 第 3 步：成员归属。未知相位**直接忽略**，不猜——
            // 猜错会把「团长在汇总」渲染成「成员开始执行」，比少显示一条更误导。
            const phase = MEMBER_PHASES[nbEvent.member_event];
            if (phase) {
              const rawId = nbEvent.member?.id;
              const rawName = nbEvent.member?.name;
              // 分组键必须稳定且非空，否则同一个成员会被拆成多组：id 缺了就退回名字，
              // 两者都缺才用占位（那时确实无从归属，宁可显示「未知成员」）。
              const memberId = String(rawId || rawName || 'unknown');
              const text = toDisplayText(nbEvent.output ?? nbEvent.plan);
              handlers.onProcessMember?.({
                memberId,
                memberName: String(rawName || rawId || memberId),
                phase,
                ...(text !== undefined ? { text } : {}),
                ...(nbEvent.error !== undefined
                  ? { error: toDisplayText(nbEvent.error) }
                  : {}),
              });
            }
          } else if (nbEvent.kind === 'subagent' && nbEvent.subagent_event) {
            // FR-2.5 第 4 步：子代理归属。相位未知一律忽略（与成员同纪律）。
            const phase = SUBAGENT_PHASES[nbEvent.subagent_event];
            if (phase) {
              const rawId = nbEvent.subagent?.id;
              const rawName = nbEvent.subagent?.label;
              // 分组键稳定且非空，否则同一个子代理被拆成多组（判据同成员分支）
              const subagentId = String(rawId || rawName || 'unknown');
              // started 带任务摘要、tool 带工具名——两者都缺时留空，别拿 iteration 充数
              const text =
                phase === 'tool' ? nbEvent.tool : toDisplayText(nbEvent.task ?? nbEvent.output);
              handlers.onProcessSubagent?.({
                subagentId,
                subagentName: String(rawName || rawId || subagentId),
                phase,
                ...(text !== undefined ? { text } : {}),
                ...(nbEvent.error !== undefined
                  ? { error: toDisplayText(nbEvent.error) }
                  : {}),
              });
            }
          } else if (nbEvent.kind === 'plan' && nbEvent.plan_id) {
            // 计划是「给用户看的清单」，不是待办数据流：步骤缺字段时按引擎
            // 已归一化的形状补齐，绝不因一条脏数据把这轮的全部内容丢掉。
            handlers.onPlan?.({
              planId: String(nbEvent.plan_id),
              steps: (nbEvent.steps ?? [])
                .filter((s) => typeof s?.text === 'string' && s.text.trim() !== '')
                .map((s, i) => ({
                  id: String(s?.id ?? `s${i + 1}`),
                  text: String(s?.text ?? ''),
                  status: (PLAN_STEP_STATUSES as readonly string[]).includes(s?.status ?? '')
                    ? (s?.status as PlanStepStatus)
                    : ('pending' as PlanStepStatus),
                })),
            });
          }
        }

        // 2) 工具调用（标准 OpenAI 增量格式；nanobot 当前不下发，静默跳过）
        const rawToolCalls = extractRawToolCalls(delta);
        if (rawToolCalls.length > 0) {
          handlers.onStatus('tooling');
          const pending = accumulator.ingest(rawToolCalls);
          pending.forEach((ev) => handlers.onToolCall(ev));
        }
      } catch (err) {
        // SSE 注释 / keep-alive 行直接跳过；其它 JSON 解析错误必须暴露，
        // 否则流中一帧损坏会被静默吞掉，用户只会看到内容「断了半截」
        const trimmed = data.trim();
        if (!trimmed || trimmed.startsWith(':')) return;
        console.error('[nanobotClient] SSE chunk parse error:', data, err);
        reportError(
          new Error(
            `SSE 消息解析失败：${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    };

    let end: SSEStreamEnd;
    if (useForm) {
      // 文件流：复用 fetch 解析（fetchSSE 当前面向 JSON body，此处独立实现以保证兼容）
      end = await this.streamFormRequest(
        streamUrl,
        requestInit,
        onChunk,
        reportError,
        signal,
        trackActivity,
        trackFirstByte,
      );
    } else {
      end = await fetchSSE(
        streamUrl,
        { ...requestInit, onActivity: trackActivity, onFirstByte: trackFirstByte } as never,
        onChunk,
        reportError,
      );
    }

    // 首字延迟采样上报（FR-11.7）：只有真的等到首字才上报 —— 没等到就报一个
    // 全 null 的样本，只会让报表多出无法解释的空行。
    // 刻意放在下面的中断判断**之前**：用户中途点了停止时，已经量到的首字延迟
    // 依然是一条有效数据（它衡量的是「多久看到第一个字」，与后来停不停无关）。
    if (latency.hasFirstToken) handlers.onLatency?.(latency.sample());

    // 中断后跳过 flush 与启发式提取，避免给用户「看起来正常生成」的错觉
    if (signal.aborted) return;

    // 2.5) 异常结束判定——**必须先于**正常收尾，否则一次被掐断的流会被宣布成完成：
    //   - `eof`：body 提前结束、`[DONE]` 从未出现（引擎进程被杀 / 代理断流）；
    //   - `error`：引擎在终结帧里承认了失败；
    //   - `length`：撞上迭代 / 输出上限，内容没写完。
    // `reportedError` 为真说明协议级失败已经报过，不重复上报。
    if (!reportedError) {
      const interrupted: 'engine_error' | 'truncated' | null =
        finishReason === 'length'
          ? 'truncated'
          : end === 'eof' || finishReason === 'error'
            ? 'engine_error'
            : null;
      if (interrupted) {
        handlers.onInterrupted?.(interrupted);
        return;
      }
    }

    // 3) 流结束：flush 工具调用（done）+ 启发式提取 artifact
    const doneCalls = accumulator.flush();
    doneCalls.forEach((ev) => handlers.onToolCall(ev));

    const artifacts = extractArtifacts(fullText);
    artifacts.forEach((ev) => handlers.onArtifact(ev));

    handlers.onStatus('done');
    handlers.onDone();
  }

  /** 文件上传场景的 SSE 流式解析（与 fetchSSE 共用同一套 SSE 缓冲解析）。
   *  注意：nanobot 在 multipart 文件上传场景下会返回完整 JSON（非 SSE 流），
   *  这里通过 Content-Type 判断，兼容两种形态。
   *  signal 触发 abort 时静默结束，不再走 onError 通道。
   *  `onActivity` 交由 fetchSSE 同款语义：响应头到达与每次读到字节都回调。
   */
  private async streamFormRequest(
    url: string,
    init: RequestInit,
    onMessage: (data: string) => void,
    onError: (err: Error) => void,
    signal: AbortSignal,
    onActivity: () => void,
    onFirstByte: () => void,
  ): Promise<SSEStreamEnd> {
    if (signal.aborted) return 'eof';
    try {
      const response = await fetch(url, init);
      // 服务端已应答即视为链路活跃（大附件的网关解析耗时落在这一段之前）
      onActivity();
      if (signal.aborted) return 'eof';
      if (!response.ok) {
        throw new Error(`SSE 请求失败：HTTP ${response.status} ${response.statusText}`);
      }
      if (!response.body) throw new Error('SSE 响应缺少 body 流');

      const contentType = response.headers.get('content-type') ?? '';
      // nanobot 带文件上传时回完整 JSON chat.completion（非流式），需兜底解析
      if (!contentType.includes('text/event-stream')) {
        const text = await response.text();
        if (signal.aborted) return 'eof';
        this.handleNonStreamResponse(text, onMessage, onError, signal);
        // 完整 JSON 本身就是「一个写完了的回答」，没有 [DONE] 可言 → 视为正常收尾。
        // 若在这里回 'eof'，每一轮带附件的对话都会被误判成「已中断」。
        return 'done';
      }

      return await readSSEStream(response.body.getReader(), signal, onMessage, onActivity, onFirstByte);
    } catch (err) {
      // 中断造成的 AbortError 视作正常结束
      if (signal.aborted) return 'eof';
      if (err instanceof DOMException && err.name === 'AbortError') return 'eof';
      onError(err instanceof Error ? err : new Error(String(err)));
      return 'eof';
    }
  }

  /**
   * 处理 nanobot 返回的非流式完整 JSON（常见于 multipart 文件上传）。
   * 把完整内容包装成 OpenAI 流式 delta 格式喂给 onMessage，让上层走统一路径。
   */
  private handleNonStreamResponse(
    text: string,
    onMessage: (data: string) => void,
    onError: (err: Error) => void,
    signal: AbortSignal,
  ): void {
    if (signal.aborted) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const json = JSON.parse(trimmed) as {
        choices?: Array<{
          message?: { content?: string; role?: string };
          delta?: { content?: string };
        }>;
      };
      const content =
        json.choices?.[0]?.message?.content ?? json.choices?.[0]?.delta?.content;
      if (content) {
        // 伪装成一个 SSE delta 事件，让 onMessage 统一解析 content + nanobot_event
        onMessage(JSON.stringify({ choices: [{ delta: { content } }] }));
      }
    } catch (err) {
      console.error('[nanobotClient] 非流式响应解析失败:', text, err);
      onError(
        new Error(
          `非流式响应解析失败：${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
}
