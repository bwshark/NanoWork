/**
 * 增量句子切分：模型一边流式吐 token，这里一边把「已经成句」的部分交出去。
 *
 * ## 为什么不能等全文再切
 * `splitSpeech` 处理的是**完整**文本，它会等到调用方把整段给齐。语音讨论里
 * 那意味着「说完话 → 等模型生成完 → 才开始念」——两三句回复就是好几秒空白，
 * 用户唯一的感受是「它卡住了」。这里按句交出去，首句延迟从「生成完整段」
 * 降到「生成第一句」。
 *
 * ## 为什么切点取「第一个句末标点」而不是最后一个
 * 取最后一个等于「等这整段都生成完才切」——又回去了。取第一个才能让第 1 句
 * 尽快出去；后续句子在播第 1 句的时间里继续累积，正好被播放时间掩盖。
 *
 * ## 为什么要硬切
 * 模型偶尔会把整段写成一个长句（或干脆不打标点）。没有硬切时这个缓冲区
 * 会一直吞到回复结束，首句延迟又退化成「等全文」。
 */

/** 句末标点：中文全角与英文半角都收（模型可能混用） */
const SENTENCE_END = /[。！？!?；;…\n]/;

/** 硬切时优先在这些「次级断点」切，比按字符数硬切自然 */
const SOFT_BREAK = ['，', ',', '、', ' '];

/**
 * 一个片段至少要有几个「实字」才值得单独念。
 *
 * 去掉这个下限，「嗯。」「好。」会被切成独立片段，念出来一顿一顿；
 * 取 3 是能挡住纯语气词、又不至于把「我看看。」这类短句并进下一句。
 * 下限太高会反过来拖慢首句——首句延迟是本文件的头号目标。
 */
const MIN_PIECE_LEN = 3;

/**
 * 默认单段上限（字符）。
 *
 * 刻意比 TTS 的单次合成上限（600）小很多：语音讨论的回复本来就只有 2~3 句，
 * 按 120 字切既能让首句最快出声，又不会把一句话念成机械的碎片。
 */
const DEFAULT_MAX = 120;

export interface SentenceSplitter {
  /** 追加新到的增量文本，返回这次已经成句的部分（可能为空数组） */
  feed: (delta: string) => string[];
  /** 收尾：返回缓冲区里剩下的半句（调用方应在流结束后念它） */
  flush: () => string;
}

/** 只保留「实字」：判断一个片段是不是纯标点/语气碎片 */
function spokenLength(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]+/gu, '').length;
}

/** 在缓冲区里找硬切点：优先次级断点，其次按上限切；返回切出长度 */
function hardCut(text: string, max: number): number {
  const window = text.slice(0, max);
  let at = -1;
  for (const mark of SOFT_BREAK) {
    const idx = window.lastIndexOf(mark);
    if (idx > at) at = idx;
  }
  // 断点太靠前就失去意义（会把句子切成「嗯，」「那个，」这种碎片）
  return at >= max / 2 ? at + 1 : max;
}

/**
 * 找这一刀的落点（返回最后一个被切走的字符下标，-1 表示还不够切）。
 *
 * 优先取**第一个够长的**句末标点——不是最后一个：取最后一个等于「等这整段
 * 都生成完才切」，首句延迟又退化成等全文。
 */
function findCut(text: string, max: number): number {
  let from = 0;
  for (;;) {
    const rel = text.slice(from).search(SENTENCE_END);
    if (rel < 0) break;
    const at = from + rel;
    if (spokenLength(text.slice(0, at + 1)) >= MIN_PIECE_LEN) return at;
    // 太短（「嗯。」「啊？」）：不算断点，继续找下一个
    from = at + 1;
  }
  if (text.length > max) return hardCut(text, max) - 1;
  return -1;
}

export function createSentenceSplitter(max: number = DEFAULT_MAX): SentenceSplitter {
  let buf = '';

  return {
    feed: (delta) => {
      buf += delta;
      const out: string[] = [];
      for (;;) {
        const cut = findCut(buf, max);
        if (cut < 0) break;
        // 去掉前导标点：模型偶尔先吐「。。」再说话，带进片段会让 TTS 多停顿
        const piece = buf.slice(0, cut + 1).replace(/^[\s\p{P}\p{S}]+/u, '').trim();
        buf = buf.slice(cut + 1);
        if (piece !== '') out.push(piece);
      }
      return out;
    },
    flush: () => {
      const rest = buf.replace(/^[\s\p{P}\p{S}]+/u, '').trim();
      buf = '';
      return rest;
    },
  };
}
