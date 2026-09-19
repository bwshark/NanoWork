import { DEFAULT_TRANSCRIPTION, useSettingsStore } from '@/stores/settingsStore';
import { fetchSSE, readSSEStream } from '@/lib/sse';
// MIME 推断统一复用附件模块的扩展名映射表（文档 / 表格 / 幻灯片 / PDF / 文本标记 /
// 配置日志 / 图片 / 音视频），避免出现「Composer 能选、上传时却退化成 octet-stream」
import { inferMime } from '@/lib/attachments';
import type { ModelInfo, ConnectionStatus } from '@/types';
import type {
  ApprovalDecision,
  ChatHandle,
  ChatRequest,
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
import type { PluginEngineIndex } from '@/types/plugin';

/**
 * 网关 [LOCAL PATCH] 注入的进度事件结构（delta.nanobot_event）。
 * kind=reasoning：深度思考片段；kind=reasoning_end：思考段结束；
 * kind=tool：工具执行阶段事件（phase=start/end/error，含 call_id/name/arguments/result/error）；
 * kind=approval_request：逐条批准请求（引擎已挂起，等待 POST /v1/tool-approvals/{id}）；
 * kind=plan：Plan 模式下 submit_plan 产出的结构化计划（plan_id / steps，FR-1.5）。
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
}

/** 结果/错误展示文本截断上限（过程时间线仅做摘要展示） */
const PROCESS_TEXT_MAX = 4000;

/** plan 步骤的合法状态（与 `@/types/event` 的 `PlanStep` 一致，此处窄化成字面量元组以便收窄未知值） */
const PLAN_STEP_STATUSES = ['pending', 'running', 'done', 'skipped'] as const;
type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

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
    // approval_mode / session_mode / agent_id / tool_allow / tool_deny / files，
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
   */
  async respondApproval(
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<void> {
    const { endpoint } = this.getConfig();
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
  }

  /**
   * 计算本次流式请求的硬超时。
   *
   * 纯文本请求沿用 120s；携带文件时按附件总体积追加额度（网关侧要解码、解析文档、
   * 再交给模型处理，几十 MB 的 PDF/DOCX 往往远超 120s）。固定 120s 会让大文件任务
   * 在流中途被掐断，表现为「对话突然断了、消息停在半截」，而服务端其实还在正常跑。
   */
  private resolveTimeout(req: ChatRequest): number {
    const base = 120_000;
    const perMb = 60_000;
    const max = 600_000;
    // content 为 base64，解码后体积约为其长度的 3/4
    const bytes = (req.files ?? []).reduce(
      (sum, f) => sum + Math.floor(((f.content?.length ?? 0) * 3) / 4),
      0,
    );
    if (bytes === 0) return base;
    return Math.min(max, base + Math.ceil(bytes / (1024 * 1024)) * perMb);
  }

  /**
   * 发送消息并流式接收。
   * 事件顺序：onStatus('thinking') → onReasoning* / onProcessTool*（进度事件）→
   * onToken* → onToolCall* → onArtifact* → onStatus('done') → onDone()。
   *
   * 取消语义（FR-中断）：返回的 ChatHandle.abort() 会立即终止底层 SSE；
   * fetchSSE / streamFormRequest 把中断视为正常结束（不通过 onError 上报），
   * 已累积的文本/工具调用/富产物在 abort 时停止接收，不再做最终的 flush / artifact 启发式提取。
   *
   * 超时与手动 abort 的区别：手动 abort 静默结束；超时则必须通过 onError 显式报错，
   * 否则用户只看到消息停在半截、界面毫无提示，会误以为程序崩了。
   */
  sendMessage(req: ChatRequest, handlers: StreamHandlers): ChatHandle {
    const controller = new AbortController();
    const timeoutMs = this.resolveTimeout(req);
    // 用可控 timer 代替 AbortSignal.timeout：需要区分中断来源
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    // 不抛错的 done：避免外部 await 误判；真正的错误由 onError 透传
    const done = this.runStream(req, handlers, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        if (timedOut) {
          handlers.onError(
            new Error(
              `响应超时：超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回完整结果。` +
              '附件越大网关处理越久，可重试或压缩/拆分文件后再试。',
            ),
          );
        }
      });

    return {
      done,
      abort: () => controller.abort(),
    };
  }

  /** 流式请求的实际执行体；与 ChatHandle 解耦。signal 中断由 fetchSSE/streamFormRequest 内部识别为正常结束。 */
  private async runStream(
    req: ChatRequest,
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const { endpoint } = this.getConfig();
    handlers.onStatus('thinking');

    const { headers, body, form } = this.buildRequest(req);
    const accumulator = new ToolCallAccumulator();
    let fullText = '';

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
          }>;
        };
        const delta = json.choices?.[0]?.delta;
        if (!delta) return;

        // 1) 文本流
        if (delta.content) {
          fullText += delta.content;
          handlers.onToken(delta.content);
          handlers.onStatus('streaming');
        }

        // 1.5) nanobot 进度事件（网关 [LOCAL PATCH] 注入：深度思考 / 工具执行行）
        const nbEvent = delta.nanobot_event;
        if (nbEvent) {
          if (nbEvent.kind === 'reasoning' && nbEvent.content) {
            handlers.onReasoning?.(nbEvent.content);
            handlers.onStatus('thinking');
          } else if (nbEvent.kind === 'reasoning_end') {
            handlers.onReasoningEnd?.();
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
            handlers.onApprovalRequest?.({
              id: String(nbEvent.id),
              tool: String(nbEvent.tool ?? ''),
              args: nbEvent.args ?? {},
              ...(nbEvent.call_id ? { callId: String(nbEvent.call_id) } : {}),
            });
            handlers.onStatus('tooling');
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
        handlers.onError(
          new Error(
            `SSE 消息解析失败：${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    };

    if (useForm) {
      // 文件流：复用 fetch 解析（fetchSSE 当前面向 JSON body，此处独立实现以保证兼容）
      await this.streamFormRequest(streamUrl, requestInit, onChunk, handlers, signal);
    } else {
      await fetchSSE(streamUrl, requestInit as never, onChunk, (err) =>
        handlers.onError(err),
      );
    }

    // 中断后跳过 flush 与启发式提取，避免给用户「看起来正常生成」的错觉
    if (signal.aborted) return;

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
   */
  private async streamFormRequest(
    url: string,
    init: RequestInit,
    onMessage: (data: string) => void,
    handlers: StreamHandlers,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    try {
      const response = await fetch(url, init);
      if (signal.aborted) return;
      if (!response.ok) {
        throw new Error(`SSE 请求失败：HTTP ${response.status} ${response.statusText}`);
      }
      if (!response.body) throw new Error('SSE 响应缺少 body 流');

      const contentType = response.headers.get('content-type') ?? '';
      // nanobot 带文件上传时回完整 JSON chat.completion（非流式），需兜底解析
      if (!contentType.includes('text/event-stream')) {
        const text = await response.text();
        if (signal.aborted) return;
        this.handleNonStreamResponse(text, onMessage, handlers, signal);
        return;
      }

      await readSSEStream(response.body.getReader(), signal, onMessage);
    } catch (err) {
      // 中断造成的 AbortError 视作正常结束
      if (signal.aborted) return;
      if (err instanceof DOMException && err.name === 'AbortError') return;
      handlers.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * 处理 nanobot 返回的非流式完整 JSON（常见于 multipart 文件上传）。
   * 把完整内容包装成 OpenAI 流式 delta 格式喂给 onMessage，让上层走统一路径。
   */
  private handleNonStreamResponse(
    text: string,
    onMessage: (data: string) => void,
    handlers: StreamHandlers,
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
      handlers.onError(
        new Error(
          `非流式响应解析失败：${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
}
