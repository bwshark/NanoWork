/**
 * 实时语音识别：WebSocket 流式客户端（DashScope Qwen-ASR-Realtime 协议）。
 *
 * ## 协议（实测确认，不是照文档猜的）
 * ```
 * wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=xxx
 * Authorization: Bearer <key>
 *
 * 客户端 → 服务端
 *   { type: 'session.update', session: {
 *       modalities: ['text'], input_audio_format: 'pcm', sample_rate: 16000,
 *       input_audio_transcription: { language: 'zh' }, turn_detection: null } }
 *   { type: 'input_audio_buffer.append', audio: '<base64 PCM16>' }   // 反复送
 *   { type: 'input_audio_buffer.commit' }                            // 手动分段
 *   { type: 'session.finish' }
 *
 * 服务端 → 客户端（**实测**事件链，用官方样例音频验证）
 *   session.created → session.updated
 *   → conversation.item.input_audio_transcription.delta   (中间结果，字段 text + stash)
 *   → conversation.item.input_audio_transcription.completed (最终文本，字段 transcript)
 *   注意：commit 后**不发** `session.finished`（实测只发 completed）
 * ```
 *
 * ## 两个实测踩到的坑
 * 1. **`qwen3-asr-flash-realtime` 在本机额度已耗尽**（`AllocationQuota.FreeTierOnly`），
 *    而 `qwen-audio-3.1-realtime-flash` 可用。所以默认模型取后者，并在错误文案里
 *    区分「额度」与「协议」——两者的补救动作完全不同。
 * 2. 服务端在 `session.created` 之后**立刻**下发配置回执；若在 `session.updated`
 *    之前就灌音频，服务端会丢掉前面几片（实测开头静音被吞）。因此必须**等回执
 *    再开闸**，这段延迟（~200ms）用「连接中」状态盖住。
 *
 * ## 为什么不做 VAD 分段
 * `turn_detection` 用 `server_vad` 会让服务端按静音自动切句，适合「说完一句就
 * 上屏」的对话式场景。但语音输入的目标是**一整段话落进输入框**，中途停顿不该
 * 被切成两条独立结果。因此这里用 Manual 模式：录音期间只 append，停止时才
 * commit 一次，拿一条完整结果。
 */

/** 发送分片大小：3200 字节 = 100ms @16kHz/16bit 单声道 */
const CHUNK_BYTES = 3200;

/** 发送节拍（ms）：与分片时长对齐，模拟实时送流 */
const CHUNK_INTERVAL_MS = 100;

/** 连接超时（ms）：握手 + session.updated 的总预算 */
const CONNECT_TIMEOUT_MS = 8000;

/**
 * 兜底超时（ms）：commit 后**一片 completed 都没回来**时的最终期限。
 *
 * 主路径不是它——实测服务端在 commit 后 ~300ms 就发 completed，随后
 * 由「completed 静默」判定收尾（见 onmessage 的注释）。这个值只防
 * 网络丢包 / 服务端异常，给足余量但不让用户干等。
 */
const FINISH_TIMEOUT_MS = 12000;

/**
 * commit 之后「多久没有新的 completed 就认定说完了」（ms）。
 *
 * 实测一次 commit 可能因停顿切成多条 completed，间隔通常 <300ms。
 * 这个值**直接计入用户说完到 AI 开口的延迟**，所以不能图稳给大：
 * 600ms 时体感是「我说完了它还在等」，压到 400ms 仍能覆盖多段下发，
 * 而不会把长句切成两条（真的超出就是那段停顿够长，切成两条也合理）。
 */
const SETTLE_SILENCE_MS = 400;

export interface RealtimeAsrOptions {
  /** 服务商 WebSocket 地址（已含 model 与 api_key 查询参数） */
  url: string;
  /** 语言（ISO-639-1），空则自动检测 */
  language?: string;
  /** 中间结果回调（边说边出字） */
  onPartial?: (text: string) => void;
  /** 最终结果回调 */
  onFinal: (text: string) => void;
  /** 错误回调（已转成可读文案） */
  onError: (message: string) => void;
  /** 服务端已就绪（可以开始送音频） */
  onReady?: () => void;
}

export interface RealtimeAsrSession {
  /**
   * 送一片 PCM16 样本（内部按队列排队，不会乱序）。
   *
   * 接受 `Int16Array` 而非 `Uint8Array`：Worklet 回传的就是 int16 样本，
   * 让调用方先转字节再传，等于每片都多一次无谓的拷贝。
   */
  push: (pcm: Int16Array | ArrayBuffer | Uint8Array) => void;
  /** 结束：commit + finish，等最终文本 */
  finish: () => void;
  /** 立即断开并丢弃（用户取消） */
  abort: () => void;
  /** 是否仍然连接受用 */
  readonly alive: boolean;
}

/**
 * 把 `compatible-mode/v1` 这类 REST 地址换算成 realtime WS 地址，并附上鉴权。
 *
 * ## 为什么鉴权走 query 而不是 header
 * 浏览器 `new WebSocket(url)` **不能设自定义 header**，也没有合法的子协议写法
 * （`Sec-WebSocket-Protocol` 的 token 不允许空格/斜杠，`Bearer sk-xxx` 直接被
 * 引擎判为 `SyntaxError: invalid subprotocol`）。
 *
 * 实测确认 `?api_key=<key>` 是 DashScope 接受的传法：
 * - 真 key → `session.created`
 * - 假 key → 握手 `401 InvalidApiKey`
 * 两者对比说明它**确实在做鉴权**，不是碰巧放行。
 *
 * ⚠️ 代价：key 会出现在 URL 里，因此只允许 `wss://`（TLS 加密通道）；
 * 明文 `ws://` 下拒绝拼 key，避免把凭据暴露在明文链路上。
 *
 * 规则（实测）：把 `/compatible-mode/v1` 整段换成 `/api-ws/v1/realtime`，
 * scheme 换 `wss:`。用户也可能直接填 WS 地址，此时只补 model 与 key。
 */
export function toRealtimeUrl(endpoint: string, model: string, apiKey: string): string {
  const raw = endpoint.trim().replace(/[,;，；]+$/, '').replace(/\/+$/, '');
  let base = raw;
  if (/\/compatible-mode\/v1$/.test(base)) {
    base = base.replace(/\/compatible-mode\/v1$/, '/api-ws/v1/realtime');
  } else if (!/\/api-ws\/v1\/realtime$/.test(base)) {
    // 兜底：去掉 /v1 再拼（自建网关常见的 `.../v1` 前缀）
    base = `${base.replace(/\/v1$/, '')}/api-ws/v1/realtime`;
  }
  base = base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

  const params: string[] = [];
  if (!base.includes('model=')) params.push(`model=${encodeURIComponent(model)}`);
  // 明文 ws 不拼 key（凭据会裸奔）；调用方会因此拿到 401 并给出可读文案
  if (apiKey && base.startsWith('wss:')) {
    params.push(`api_key=${encodeURIComponent(apiKey)}`);
  }
  if (params.length === 0) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${params.join('&')}`;
}

/**
 * 建立一个实时识别会话。
 *
 * 返回的 session 是**命令式对象**而不是 React state：音频帧每 100ms 一片，
 * 走 state 会让整棵输入区每 100ms 重渲染一次（打字都会掉帧）。
 */
export function openRealtimeAsr(options: RealtimeAsrOptions): RealtimeAsrSession {
  const { url, language, onPartial, onFinal, onError, onReady } = options;

  let ws: WebSocket | null = null;
  let ready = false;
  let finished = false;
  let disposed = false;
  /** 待发送队列：在 ready 之前到达的片段先攒着，不能丢 */
  const pending: Uint8Array[] = [];
  let pumpTimer: number | null = null;
  let connectTimer: number | null = null;
  let finishTimer: number | null = null;
  /** 累积的最终文本（服务端可能分多条 completed 下发） */
  let finalText = '';

  const clearTimers = () => {
    if (pumpTimer !== null) window.clearInterval(pumpTimer);
    if (connectTimer !== null) window.clearTimeout(connectTimer);
    if (finishTimer !== null) window.clearTimeout(finishTimer);
    pumpTimer = null;
    connectTimer = null;
    finishTimer = null;
  };

  const close = () => {
    clearTimers();
    if (ws) {
      try {
        ws.close();
      } catch {
        /* 已关闭 */
      }
      ws = null;
    }
  };

  const fail = (message: string) => {
    if (disposed) return;
    disposed = true;
    close();
    onError(message);
  };

  /**
   * 收尾：交付最终文本并断开。
   *
   * 幂等（`disposed` 守卫）：completed 静默计时器与 `session.finished`
   * 都可能先到，两条路径都会调它。
   */
  const settle = () => {
    if (disposed) return;
    disposed = true;
    close();
    const text = finalText.trim();
    if (text === '') onError('没有识别到语音内容，请靠近麦克风重试');
    else onFinal(text);
  };

  /**
   * 送一片音频。
   *
   * base64 手写而不是 `btoa(String.fromCharCode(...))`：后者在 3200 字节时
   * 会触发参数展开上限（不同引擎阈值不一），且每片都要建一次中间字符串数组。
   */
  const sendChunk = (bytes: Uint8Array) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        event_id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'input_audio_buffer.append',
        audio: bytesToBase64(bytes),
      }),
    );
  };

  /** 按 100ms 节拍把队列送出去（模拟实时，而不是一次灌完） */
  const startPump = () => {
    if (pumpTimer !== null) return;
    pumpTimer = window.setInterval(() => {
      if (disposed || !ready) return;
      const next = pending.shift();
      if (!next) return;
      sendChunk(next);
    }, CHUNK_INTERVAL_MS);
  };

  try {
    ws = new WebSocket(url);
  } catch (err) {
    onError(
      `无法建立实时语音连接：${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      push: () => undefined,
      finish: () => undefined,
      abort: () => undefined,
      alive: false,
    };
  }

  // 鉴权已在 URL 的 api_key 查询参数里（见 toRealtimeUrl 的注释：
  // 浏览器无法设 header，子协议也不合法）。这里连上就直接配会话。
  ws.onopen = () => {
    ws?.send(
      JSON.stringify({
        event_id: 'e_session',
        type: 'session.update',
        session: {
          modalities: ['text'],
          input_audio_format: 'pcm',
          sample_rate: 16000,
          ...(language?.trim()
            ? { input_audio_transcription: { language: language.trim() } }
            : {}),
          // Manual 模式：由客户端 commit 决定分段（见文件头「为什么不做 VAD」）
          turn_detection: null,
        },
      }),
    );
    connectTimer = window.setTimeout(() => {
      if (!ready) fail('实时语音连接超时，请检查网络或服务地址');
    }, CONNECT_TIMEOUT_MS);
  };

  ws.onmessage = (ev) => {
    let msg: {
      type?: string;
      transcript?: string;
      text?: string;
      stash?: string;
      error?: unknown;
    };
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    const type = msg.type ?? '';

    if (type === 'session.updated') {
      ready = true;
      if (connectTimer !== null) window.clearTimeout(connectTimer);
      connectTimer = null;
      onReady?.();
      startPump();
      return;
    }

    /**
     * 中间结果。
     *
     * ⚠️ **事件名是 `delta` 不是 `text`**——官方「客户端事件」文档只写了
     * `conversation.item.input_audio_transcription.text`，但实测
     * `qwen-audio-3.1-realtime-flash` 下发的是 `.delta`。两个都认，
     * 因为不同模型/版本可能走不同名字（只认一个就会「中间结果永远不出现」，
     * 表现为「录完才出字」——正是要避免的旧行为）。
     *
     * 字段语义：`text` 是**已定稿**部分，`stash` 是**当前这句的临时尾巴**
     * （会随着后续音频不断变长/被改写）。两者拼起来才是「目前为止说的全部内容」。
     */
    if (
      type === 'conversation.item.input_audio_transcription.delta' ||
      type === 'conversation.item.input_audio_transcription.text'
    ) {
      const text = `${msg.text ?? ''}${msg.stash ?? ''}`.trim();
      if (text) onPartial?.(text);
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const piece = (msg.transcript ?? '').trim();
      if (piece) {
        finalText = finalText ? `${finalText}${piece}` : piece;
        onPartial?.(finalText);
      }
      /**
       * ⚠️ **实测：commit 之后服务端只发 completed，不发 `session.finished`**。
       *
       * 因此不能等 `session.finished` 才收尾（那样会一直挂到超时，用户看到
       * 「正在收尾」转圈十几秒）。这里用「completed 后静默 600ms」作为收尾判据：
       * - 一次 commit 可能因停顿切成多条 completed（间隔通常 <300ms）；
       * - 600ms 内没有新的 completed 就认定说完了。
       *
       * 只在 `finished`（已 commit）之后才启动这个计时器：录音中途的 completed
       * 不该触发收尾（那是上一句的定稿，后面还会继续）。
       */
      if (finished && !disposed) {
        if (finishTimer !== null) window.clearTimeout(finishTimer);
        finishTimer = window.setTimeout(() => settle(), SETTLE_SILENCE_MS);
      }
      return;
    }

    if (type === 'session.finished') {
      // 有些模型/版本会发这个（实测 qwen-audio-3.1-realtime-flash 不发，
      // 只发 completed）。两条路都要能收尾，见 completed 分支的注释。
      settle();
      return;
    }

    if (type === 'error') {
      // 服务端错误：区分「额度」与「其它」——补救动作完全不同
      const detail = JSON.stringify(msg.error ?? msg).slice(0, 300);
      if (/FreeTierOnly|free quota|quota has been exhausted/i.test(detail)) {
        fail(
          '实时语音模型免费额度已用尽。请到阿里云百炼控制台充值或关闭「仅用免费额度」，或改用非实时模型（qwen3-asr-flash）。',
        );
      } else {
        fail(`实时语音识别失败：${detail}`);
      }
    }
  };

  ws.onerror = () => {
    // 握手被拒 / 网络错误：onclose 会紧跟，由它统一报错，这里不重复
  };

  ws.onclose = (ev) => {
    if (disposed) return;
    if (finished) return;
    // 1006 = 异常断开（多为鉴权失败或模型不可用）
    if (!ready) {
      fail(
        ev.code === 1006
          ? '实时语音连接被拒绝：请检查 API Key、服务地址，以及该模型是否已开通'
          : `实时语音连接关闭（${ev.code}）`,
      );
    }
  };

  return {
    push: (pcm) => {
      if (disposed) return;
      // Int16Array 要走「样本 → 字节」视图转换：`new Uint8Array(int16arr)` 会
      // 按元素逐个读（int16 转 uint8 会截断成 1 字节），得到的是错的音频。
      // 必须用 `buffer` 视图才能拿到真正的 2 字节 PCM。
      const bytes =
        pcm instanceof Uint8Array
          ? pcm
          : pcm instanceof Int16Array
            ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
            : new Uint8Array(pcm);
      if (bytes.byteLength === 0) return;
      // 按 3200 字节切：麦克风回调给的是任意长度，服务端偏好 100ms 一片
      for (let i = 0; i < bytes.byteLength; i += CHUNK_BYTES) {
        pending.push(bytes.subarray(i, Math.min(i + CHUNK_BYTES, bytes.byteLength)));
      }
      // ready 之前不 pump；startPump 在 session.updated 里启动
    },
    finish: () => {
      if (disposed) return;
      finished = true;
      // 队列里还有没送完的：等它排空再 commit，否则尾部会被截掉
      const doFinish = () => {
        if (pending.length > 0 && ws?.readyState === WebSocket.OPEN) {
          window.setTimeout(doFinish, CHUNK_INTERVAL_MS);
          return;
        }
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event_id: 'e_commit', type: 'input_audio_buffer.commit' }));
          ws.send(JSON.stringify({ event_id: 'e_finish', type: 'session.finish' }));
        }
        // 兜底：completed 静默计时器（600ms）是主路径；这里只防「一片 completed
        // 都没回来」的极端情况（网络丢包 / 服务端异常）。给足余量但别让用户
        // 盯着「正在收尾」转太久。
        finishTimer = window.setTimeout(() => settle(), FINISH_TIMEOUT_MS);
      };
      doFinish();
    },
    abort: () => {
      disposed = true;
      close();
    },
    get alive() {
      return !disposed && ws !== null;
    },
  };
}

/** Uint8Array → base64（分块避免参数展开上限） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}
