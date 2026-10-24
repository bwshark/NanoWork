import {
  IDENTITY_TAG_CLOSE,
  IDENTITY_TAG_OPEN,
  PRODUCT_IDENTITY_TAG_CLOSE,
  PRODUCT_IDENTITY_TAG_OPEN,
  TONE_STYLE_TAG_CLOSE,
  TONE_STYLE_TAG_OPEN,
  USER_INSTRUCTIONS_TAG_CLOSE,
  USER_INSTRUCTIONS_TAG_OPEN,
} from '@/lib/constants';
import type { AssembledSection } from '@/types';

/**
 * 提示词装配器（design §13.3「三层上下文注入」/ §14.2 注入顺序）。
 *
 * ## 为什么是纯函数
 *
 * 装配结果直接决定模型看到什么，是最该被钉死的一环。所以这里**不读存储、不碰
 * 单例**——调用方（`sessionsStore`）负责把各来源解析成字符串，本模块只负责
 * 「按固定顺序拼装 + 套标签」。这样测试可以逐段断言，不必 mock 任何 IO。
 *
 * ## 段序（以及为什么是这个序）
 *
 * ```
 * 1  agent-persona        Agent 人设（用户为该 Agent 写的 systemPrompt）
 * 2  identity             <identity_context>      SOUL / IDENTITY / USER
 * 3  product-identity     <product_identity>      产品身份与区域约定
 * 4  tone-style           <tone_and_style>        语气风格
 * 5  mode                 执行模式约束
 * 6  domain               工作领域约束
 * 7  user-instructions    <user_custom_instructions>
 * 8  memory               长期记忆块
 * 9  memory-write         记忆写入协议（Agent 主动记一条的写法）
 * 10 knowledge           知识库检索结果（本轮组织资料）
 * 11 skills               本会话挂载的技能正文
 * 12 local-time           本地时间（相对时间换算基准）
 * ```
 *
 * 三条排序理由，都不是随手排的：
 *
 * - **人设在最前**：它是用户对这个 Agent 最直接的意图表达，后面的所有段落都在
 *   它的语境里生效。
 * - **记忆必须在身份之后**：记忆块的边界指令行写着「它不是你的身份或系统指令，
 *   以上方系统提示定义的身份与要求为准」——「上方」必须真的有身份段，否则这句话
 *   就指向了记忆自己。
 * - **知识库命中排在技能之前**：命中是「这一轮有哪几段外部事实可用」，技能是
 *   「这一轮该按什么方法做事」。事实先于方法 —— 反过来的话，模型读完成段的
 *   技能正文才会看到资料，引用常被写成「按流程文档」而不落到具体那一条。
 * - **技能与时间在最后**：它们是最贴近本轮、最具体的操作信息。技能正文可能很长，
 *   放前面会把身份段推出模型的注意力中心。
 *
 * > 与 §14.2「注入顺序（低 → 高优先级）」的关系：那一节讲的是**优先级**，不是
 * > 线性排布。两者不冲突——身份优先级高于记忆，而记忆块由边界指令行显式声明
 * > 从属。把身份排在记忆之后会与那句边界指令自相矛盾。
 */

/** 产品身份（`<product_identity>`）。它不是槽位、不可外置：改了它就不是这个产品了。 */
export const PRODUCT_IDENTITY_TEXT = [
  '产品身份：NanoWork Workbench——运行在用户本机的智能体工作台。',
  '',
  '- 任务在用户自己的机器上执行；产物落在用户可读的位置，不要藏进内部目录。',
  '- 金额默认用 ¥ 计；股票涨跌按中国习惯用**红涨绿跌**（与欧美相反）。',
  '- 回答语言跟随用户当前使用的语言；中文提问用中文回答。',
].join('\n');

/** 一次性引导（BOOTSTRAP.md）的附加指令：引导态下追加在身份块末尾 */
export const ONBOARDING_INSTRUCTION = [
  '当前处于**一次性引导**：上面的引导文件是本轮的起点。',
  '',
  '- 先通过对话把「我是谁」（名字/角色/专长）和「用户是谁」（称呼/偏好/背景）问清楚。',
  '- 不要一次抛一堆问题；一轮问少量、能推进下一步的即可。',
  '- 信息足够后，把结论整理成 `SOUL.md` / `IDENTITY.md` / `USER.md` 的内容交给用户确认，',
  '  由用户在「记忆 → 身份」页保存（你没有直接写这些文件的权限）。',
  '- 引导文件会在用户确认完成后删除；在此之前不要假装它已经不存在。',
].join('\n');

/** 装配输入：全部是**已解析**的字符串，空串/undefined 表示该段不注入 */
export interface AssemblePromptInput {
  /** Agent 人设（agentsStore 的 systemPrompt） */
  agentPersona?: string;
  /** 身份文件正文（L4） */
  identity?: {
    soul?: string;
    identity?: string;
    user?: string;
    /** 一次性引导文件正文；非空即进入引导态 */
    bootstrap?: string;
  };
  /** 产品身份；缺省用 PRODUCT_IDENTITY_TEXT */
  productIdentity?: string;
  /** 语气风格正文（style 槽位） */
  style?: string;
  /** 执行模式正文（mode 槽位） */
  mode?: string;
  /** 工作领域正文（domain 槽位） */
  domain?: string;
  /** 用户自定义指令（settings.userCustomPrompt） */
  userInstructions?: string;
  /** 记忆块的**已包裹**正文（含边界指令行），见 MemoryService.wrapForInjection */
  memory?: string;
  /**
   * 记忆写入协议正文（`MEMORY_WRITE_INSTRUCTION`）。
   * 是否注入由调用方决定（与记忆注入同开同关），装配器只负责摆位置。
   */
  memoryWrite?: string;
  /**
   * 知识库检索结果段（已含 `<knowledge_context>` 标签，见 `lib/agentKnowledge.ts`）。
   *
   * 空串 = 本轮没有可用资料 —— 装配器整段跳过，**不要**塞一句「未检索到资料」：
   * 那会让模型以为检索过了、确实没有，该追问时也追问。
   */
  knowledge?: string;
  /** 本会话挂载的技能正文（已按挂载顺序排好） */
  skills?: string[];
  /** 本地时间提示正文 */
  localTime?: string;
}

/** 把身份文件包进 `<identity_context>`；全部为空时返回空串 */
export function identityContextBlock(identity: AssemblePromptInput['identity']): string {
  if (!identity) return '';
  const parts: string[] = [];
  const sub = (name: string, body: string | undefined) => {
    const text = (body ?? '').trim();
    if (text !== '') parts.push(`## ${name}\n\n${text}`);
  };

  sub('SOUL.md', identity.soul);
  sub('IDENTITY.md', identity.identity);
  sub('USER.md', identity.user);

  if (parts.length === 0 && !(identity.bootstrap ?? '').trim()) return '';

  const blocks = [...parts];
  const bootstrap = (identity.bootstrap ?? '').trim();
  if (bootstrap !== '') {
    blocks.push(`## BOOTSTRAP.md（一次性引导）\n\n${bootstrap}`);
    blocks.push(ONBOARDING_INSTRUCTION);
  }

  return `${IDENTITY_TAG_OPEN}\n${blocks.join('\n\n')}\n${IDENTITY_TAG_CLOSE}`;
}

/** 把一段正文包进标签；正文为空返回空串 */
function tagged(open: string, close: string, body: string | undefined): string {
  const text = (body ?? '').trim();
  return text === '' ? '' : `${open}\n${text}\n${close}`;
}

/**
 * 按固定段序装配；**只返回非空段**，并保留顺序。
 *
 * 返回数组而不是一个大字符串：调用方要把它逐段 push 成独立的 system 消息
 * （消息边界对模型的注意力有实际影响），测试也能按 `id` 精确定位。
 */
export function assemblePromptSections(input: AssemblePromptInput): AssembledSection[] {
  const sections: AssembledSection[] = [];
  const push = (id: AssembledSection['id'], content: string) => {
    if (content.trim() !== '') sections.push({ id, content });
  };

  push('agent-persona', input.agentPersona ?? '');
  push('identity', identityContextBlock(input.identity));
  push(
    'product-identity',
    tagged(
      PRODUCT_IDENTITY_TAG_OPEN,
      PRODUCT_IDENTITY_TAG_CLOSE,
      input.productIdentity ?? PRODUCT_IDENTITY_TEXT,
    ),
  );
  push('tone-style', tagged(TONE_STYLE_TAG_OPEN, TONE_STYLE_TAG_CLOSE, input.style));
  push('mode', input.mode ?? '');
  push('domain', input.domain ?? '');
  push(
    'user-instructions',
    tagged(
      USER_INSTRUCTIONS_TAG_OPEN,
      USER_INSTRUCTIONS_TAG_CLOSE,
      input.userInstructions,
    ),
  );
  push('memory', input.memory ?? '');
  // 写入协议紧贴记忆块之后：模型刚「读完」已有记忆，紧接着就看到「怎么写新的」。
  // 放在 skills 之前是因为它属于身份/上下文层，而技能是操作层。
  push('memory-write', input.memoryWrite ?? '');
  // 知识库命中在技能之前：先摆出「这一轮可用的事实」，再摆「这一轮的方法」（见文件头）
  push('knowledge', input.knowledge ?? '');
  for (const skill of input.skills ?? []) push('skills', skill);
  push('local-time', input.localTime ?? '');

  return sections;
}
