/**
 * 专家包（Expert Package，FR-3.3）。
 *
 * 需求原文只有一句：「专家可打包分发（含头像、初始提示词、绑定技能）」。
 * 落地时要回答三个问题，答案写在下面，避免后来者重新推一遍：
 *
 * 一、**为什么不是一个 zip / 不是完整 plugin 包**。
 * PRD §12.5.1 的约束是「专家与技能统一为 plugin，靠 `expertType` 区分个体与团队」，
 * 指的是**不要为专家另建一套 CRUD / 另造一套启用开关表**。本期要解决的是「把我
 * 调好的一位专家发给同事」，内容就是一个 Agent 配置 + 几个技能引用，没有包根目录、
 * 没有多文件资源、没有安装目录约定。做成 zip 需要引入压缩库或主进程解压，而收益
 * 只是「省得两个文件」。因此本期格式是**单文件 JSON**，清单字段名与 `plugin.json`
 * 同构（`name` / `version` / `description` / `expertType`），将来若要升级为真正的
 * plugin 包，字段不用改名——只多一层文件布局。
 *
 * 二、**技能只带引用、不带包本体**。
 * 把技能实现塞进专家包，就等于要求「导入方信任一段会跑在它机器上的代码」。技能的
 * 分发有它自己的通道（`skillsStore` / 插件市场）。所以这里只记 `{id, name}`：
 * 本地有这个 id 就绑定，没有就**如实报缺失、照常导入**——一个专家换台机器就装不进
 * 来，比「少了两个技能」糟糕得多。
 *
 * 三、**头像有上限**。
 * 头像字段允许 dataURL（`types/agent.ts` 的约定），而 dataURL 进 JSON 会膨胀成
 * 几十上百 KB 的 base64。包是给人贴聊天窗口 / 发邮件的，超过上限就剔除并在解析
 * 时给出 warning，**不让整个导出失败**——为了一个头像丢掉整份配置不值。
 */

/** 包清单 schema。带版本号，解析时严格比对——不做「猜一个相近版本」的兼容。 */
export const EXPERT_PACKAGE_SCHEMA = 'nanowork.expert/v1' as const;

/** 导出文件名后缀。带上 `.json` 是为了系统双击时能落到文本编辑器而不是问「用什么打开」。 */
export const EXPERT_PACKAGE_FILE_SUFFIX = '.nanowork-expert.json';

/**
 * 头像字符上限（96K 字符 ≈ 72KB base64 载荷）。
 *
 * 取值理由是「够放一张 128×128 的 PNG」而不是「技术上能塞多大」：头像的展示位
 * 是 40px 的圆形 Avatar，再大纯属浪费，而它会被复制进每一份导出的包里。
 */
export const EXPERT_PACKAGE_MAX_AVATAR_CHARS = 96 * 1024;

/** 包内的一条技能引用。 */
export interface ExpertPackageSkillRef {
  /** 技能 id，与本地 `skillsStore` 的 id 同一取值域 */
  id: string;
  /**
   * 人类可读名。只在「本地缺这个 id」时有用——那时 id 对用户毫无意义，
   * 至少让他知道少的是「代码审查」还是「网页抓取」。
   */
  name: string;
}

/** 包内承载的专家（Agent）配置。字段与 `Agent` 一一对应，但**不带**本地标识与同步元数据。 */
export interface ExpertPackageAgent {
  /** 专家名 */
  name: string;
  /** 初始提示词（系统身份） */
  systemPrompt: string;
  /** 头像：emoji 或 dataURL；未设置即省略 */
  avatar?: string;
  /** 工具白名单；省略 = 不限制。**空数组有效**（一个工具都不许），不能当「没设置」 */
  toolAllow?: string[];
  /** 工具黑名单；优先级高于 `toolAllow` */
  toolDeny?: string[];
  /** 领域模板覆盖；省略 = 跟随全局 */
  promptDomain?: string;
  /** 风格模板覆盖；省略 = 跟随全局 */
  promptStyle?: string;
  /**
   * 模型绑定：**预设名**（与 `Session.model` 同一取值域）。
   *
   * 跨机器几乎一定失效——预设是本机 `modelsStore` 里的条目，同事那边没有同名的。
   * 所以导入侧必须校验，校验不了就丢弃（见 `planExpertImport` 的 `missingModel`）。
   */
  model?: string;
}

/** 一份专家包。 */
export interface ExpertPackage {
  /** 必须是 `EXPERT_PACKAGE_SCHEMA`；不符直接拒（不做版本嗅探） */
  schema: string;
  /** 稳定标识（slug），同时用作导出文件名主干 */
  slug: string;
  /** 语义化版本 */
  version: string;
  description: string;
  /**
   * 个体（agent）或团队（team）。
   *
   * 团队包的完整形态要带 `memberAgents` 的互相引用，本期只解析 `agent` 形态；
   * 声明为 `team` 的包会被 `unsupported-expert-type` 明确拒掉，而不是「按个体
   * 导进去」——半截导入比明确不支持更难排查。
   */
  expertType: 'agent' | 'team';
  /**
   * 技能引用清单，**唯一来源**。
   *
   * 刻意不在这里再放一份 `agent.skillIds`：两份清单必然漂移，而漂移症状是
   * 「包里写着 3 个技能、导进去只有 2 个」且查不出是谁写错的。导入时由本清单
   * 派生 `skillIds`。
   */
  skills: ExpertPackageSkillRef[];
  agent: ExpertPackageAgent;
  /** 导出时间（ISO），展示用，不参与任何判定 */
  exportedAt?: string;
}

/** 解析失败的分类。界面据此给不同文案——「不是专家包」和「包坏了」的指引完全不同。 */
export type ExpertPackageParseErrorKind =
  | 'not-json'
  | 'not-object'
  | 'schema-mismatch'
  | 'unsupported-expert-type'
  | 'missing-field'
  | 'invalid-field';

export type ExpertPackageParseResult =
  | {
      ok: true;
      pkg: ExpertPackage;
      /** 非致命问题（如头像超限被剔除）。界面要展示——静默丢字段最招人恨 */
      warnings: string[];
    }
  | { ok: false; kind: ExpertPackageParseErrorKind; error: string };

/**
 * 导入计划：把「包里写的」和「这台机器上有的」对完账的结果。
 *
 * 之所以拆出一个纯函数而不是在 store 里就地算：这些判定（重名、缺技能、缺模型）
 * 每一条都有反直觉的边界，必须能被单测逐个钉住；放进 store 就只能靠 UI 测。
 */
export interface ExpertImportPlan {
  pkg: ExpertPackage;
  /** 归一后的专家名（重名时已加后缀），也就是最终落库的 `name` */
  name: string;
  /** 是否因重名改过名 */
  renamed: boolean;
  /** 本地缺失的技能：**不阻塞导入**，只是这些绑定被丢掉 */
  missingSkills: ExpertPackageSkillRef[];
  /** 本地缺失的模型预设：丢弃（回落「会话选择 → 网关默认」） */
  missingModel?: string;
  /** 可直接交给 `createAgent` 的草稿（已被归一：缺失技能/模型/头像都已剔除） */
  draft: ExpertAgentDraft;
}

/**
 * 落地草稿：`createAgent` 的入参形状。
 *
 * 刻意**不**写成 `Partial<Agent>`：那是「什么都能传」的全集，新增 Agent 字段时
 * 编译器不会提醒你回来看一眼「这个字段要不要进包」。写死字段集之后，一旦 `Agent`
 * 上多了与「分发一位专家」相关的东西（比如绑定 MCP），这里是必须主动改的地方。
 */
export interface ExpertAgentDraft {
  name: string;
  systemPrompt: string;
  skillIds: string[];
  avatar?: string;
  toolAllow?: string[];
  toolDeny?: string[];
  promptDomain?: string;
  promptStyle?: string;
  model?: string;
}
