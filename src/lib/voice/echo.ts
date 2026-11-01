/**
 * 自激回声判据：这段识别结果，是不是「助手自己刚说的话被麦克风录回去了」？
 *
 * ## 为什么需要它
 * 语音讨论的麦克风全程开着（要能随时打断播报）。外放时扬声器的声音必然被麦克风
 * 收到，于是助手的回复会被实时识别成一整句「用户发言」——界面上的表现就是
 * **助手的话变成了用户输入**。更糟的是模型看到「用户复述了我刚说的话」，
 * 会顺着这条线解释、道歉、复述，形成自我对话的死循环（实测三轮就彻底跑偏）。
 *
 * 主防线是播报期间不向识别送音频（见 `useVoiceDiscussion` 的音频闸门），
 * 那是确定性的。这一层是兜底：闸门刚打开的一瞬间、系统语音播报的尾音、
 * 以及用户外放音量极大时仍可能漏进来一点点。判据是纯函数，可以钉住。
 *
 * ## 为什么是「二元组 Dice 相似度」而不是包含 / 编辑距离
 * - **包含**：识别几乎不会一字不差地包含整句（ASR 常吞掉开头几个字、
 *   句中的「，」「。」会变成「,」或直接消失），漏判率高；
 *   反过来短句被长句包含又太容易误杀。
 * - **编辑距离**：对语序调换、多一两个字极度敏感，阈值只能在「漏判 echo」和
 *   「误杀真人复述」之间二选一，没有可用区间。
 * - **二元组 Dice**：只看「说没说过同样的话」。漏字、增字、语序微调都只
 *   轻微拉低分数（实测漏 3 字仍有 0.89），而真人追问（「你刚才说…」）
 *   会引入足够多的新二元组把分数压到 0.7 以下。
 *
 * ## 为什么短句一律不判
 * 「好的」「嗯嗯」这类短句本来就会被双方反复说，判了纯属误杀。
 * 而被录回去的 echo 一定是**整句**（TTS 念的就是一整句），
 * 所以把门槛放在 10 个字符，漏判风险几乎为零。
 */

/**
 * 判定所需的最短长度（归一化后的字符数）。
 *
 * 取 10 而不是 6：`放在发送键旁边吧` 这种「用户几乎复述原话」的短句
 * 在 8 字时会被判成 echo（Dice 0.93），而 10 字以上真人几乎不可能
 * 逐字重复助手的话——除非他真的就是在念，那丢掉也无所谓。
 */
const MIN_LENGTH = 10;

/** Dice 相似度阈值：0.82 能容忍漏 3 字 / 多个「嗯」，同时挡得住真人追问 */
const ECHO_THRESHOLD = 0.82;

/**
 * 覆盖率阈值：助手原话有多大比例被「念回来」。
 *
 * 为什么还需要它（Dice 不够）：实测的回声常常是**混合音频**——TTS 还在响，
 * 用户已经开始说话了，识别结果会把两者拼成一句：
 * ```
 * 你好呀，我在呢，…，直接说就行。就这样被你占断了所有路我
 * └──────────── 助手原话（完整） ────────────┘└──── 用户真话 ────┘
 * ```
 * 这句的 Dice 只有 0.80（多出来的尾巴把分母拉大了），但覆盖率是 1.0
 * ——助手说的每个二元组都出现了。所以要两条指标取「或」。
 *
 * 取 0.80 而不是更严：回声漏掉几个字是常态（ASR 会吞开头），
 * 而这里是死循环的最后一道闸，误杀一句的代价远小于整场讨论报废。
 */
const COVERAGE_THRESHOLD = 0.8;

/**
 * 归一化：只保留「说了哪些字」。
 *
 * 去空白与标点是必须的——识别结果里的标点由模型自行补，与 TTS 原文
 * （含 `！`、`，`）永远对不上，不归一化的话完全相同的两句话相似度也只有 0.7。
 */
export function normalizeSpeech(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 按字符二元组建袋（计数，处理重复片段） */
function bigrams(text: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    bag.set(gram, (bag.get(gram) ?? 0) + 1);
  }
  return bag;
}

/** 两句话的 Dice 相似度（0~1，1 = 完全相同） */
export function speechSimilarity(a: string, b: string): number {
  const x = normalizeSpeech(a);
  const y = normalizeSpeech(b);
  if (x === '' || y === '') return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;

  const bagX = bigrams(x);
  const bagY = bigrams(y);
  let overlap = 0;
  for (const [gram, count] of bagX) {
    const other = bagY.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  // 二元组总数 = 长度 - 1；Dice = 2|交集| / (|X| + |Y|)
  const total = x.length - 1 + (y.length - 1);
  return (2 * overlap) / total;
}

/**
 * 助手的原话有多大比例出现在这段识别结果里（0~1）。
 *
 * 分母是**助手文本**而不是识别结果：我们问的是「它说的话是不是被念回来了」，
 * 对方多说几句自己的话不该把这个比例稀释掉（那正是 Dice 的盲区）。
 */
export function coverRatio(heardText: string, saidText: string): number {
  const heard = normalizeSpeech(heardText);
  const said = normalizeSpeech(saidText);
  if (heard.length < 2 || said.length < 2) return 0;

  const bagHeard = bigrams(heard);
  let overlap = 0;
  let total = 0;
  for (const [gram, count] of bigrams(said)) {
    total += count;
    const other = bagHeard.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  return total === 0 ? 0 : overlap / total;
}

/**
 * 这段识别结果是否只是助手自己说过的话。
 *
 * @param transcript 识别回来的文本（用户发言候选）
 * @param assistantTexts 最近几条助手回复（越近越可能被录回，但都要比）
 */
export function isEchoTranscript(
  transcript: string,
  assistantTexts: readonly string[],
): boolean {
  const heard = normalizeSpeech(transcript);
  if (heard.length < MIN_LENGTH) return false;

  for (const said of assistantTexts) {
    const original = normalizeSpeech(said);
    if (original.length < MIN_LENGTH) continue;
    if (original === heard) return true;
    if (speechSimilarity(heard, original) >= ECHO_THRESHOLD) return true;
    if (coverRatio(heard, original) >= COVERAGE_THRESHOLD) return true;
  }
  return false;
}
