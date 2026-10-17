/**
 * 引擎运行时自检的领域类型（FR-13.6）。主进程与渲染层共用一份。
 *
 * ## 为什么是「三项」而不是一个布尔
 *
 * 三项的**修法完全不同**，而用户唯一能拿到的信息就是这个报告：
 *
 * | 项 | 失败说明什么 | 用户要做什么 |
 * |---|---|---|
 * | `interpreter` | 机器上没有可用的 Python 环境（或 venv 被改名 / 移走） | 建 venv 或指认一个解释器 |
 * | `engine-import` | 解释器能跑，但引擎包导入不了（依赖没装齐 / 装到别的解释器里） | 在那个解释器里装依赖 |
 * | `config` | 引擎能跑，但配置文件不符合引擎 schema | 改配置（报错里直接指出字段） |
 *
 * 合成一个 `ok: false` 会把这三种情况糊成一句「引擎启动失败」，而用户对着它
 * 什么也做不了 —— 那正是本次要消灭的「黑盒」。
 */

/** 三项自检的标识。**稳定值**：UI 的文案映射与测试都按它索引。 */
export type EngineSelfCheckId = 'interpreter' | 'engine-import' | 'config';

/**
 * 单项目状态。
 *
 * - `ok` 通过；
 * - `failed` **确定有问题**（要修）；
 * - `skipped` **无法判定**（例：配置文件还不存在，引擎首次启动时会生成；或解释器是
 *   PATH 上的裸命令名，无法预检）。刻意与 `failed` 分开：把「不知道」显示成红色
 *   会让新装用户以为坏了，而这三种情况都会在下一步自检里被真正判定。
 */
export type EngineSelfCheckStatus = 'ok' | 'failed' | 'skipped';

/** 失败时的可操作引导：分步说明 + 真实命令 + 本机文档路径 */
export interface EngineSelfCheckRemedy {
  /** 分步说明，先说清「这是什么问题」再给步骤 */
  steps: string[];
  /** 可直接复制执行的命令（**含真实路径**，不是示意） */
  commands: string[];
  /** 本机上的文档文件路径（真实存在才给，取不到就是 null —— 不编 URL） */
  docPath: string | null;
}

export interface EngineSelfCheckFinding {
  id: EngineSelfCheckId;
  title: string;
  status: EngineSelfCheckStatus;
  /** 一句话结论（成功也给：界面要显示「通过」而不是留白） */
  summary: string;
  /** 证据：实际找过的路径 / 子进程原始报错（**原文**，不加工） */
  detail: string | null;
  remedy: EngineSelfCheckRemedy | null;
}

export interface EngineSelfCheckReport {
  /** ISO 时间戳；界面显示「什么时候查的」——旧报告被当成现状是最常见的误判 */
  checkedAt: string;
  /** 三项里没有任何 `failed`（`skipped` 不算失败） */
  ok: boolean;
  findings: EngineSelfCheckFinding[];
  /** 这次自检**到底在找什么**（用户据此判断「是不是找错地方了」） */
  target: {
    bin: string;
    config: string;
    /** 按优先级排列的解释器候选路径（`interpreter` 失败时的证据来源） */
    candidates: string[];
    /** 引擎仓库根（命令里要用到的真实路径） */
    engineRoot: string;
  };
}
