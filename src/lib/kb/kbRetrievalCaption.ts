/**
 * 知识库页顶部那句说明文字（FR-4.7 向量检索）。
 *
 * ## 为什么单独抽出来
 *
 * 这句话原来是**写死**的（「当前为词法检索，向量检索未接入」）。只要有人把
 * `NANOWORK_KB_EMBEDDER` 打开，它就立刻变成假话 —— 而界面上说假话的代价是：
 * 用户拿「明明该语义命中却搜不到」来报 bug，排查的人先去翻检索代码。
 *
 * 现在它由服务端的 `GET /api/kb/retrieval` 决定，并且**必须区分三件事**：
 * 1. 引擎是什么（词法 / 哈希向量 / 远程模型）；
 * 2. 索引覆盖率（N/M 块）—— 有块没建索引时排序结果会「一半新一半旧」；
 * 3. 配置是否真的生效（选了 openai 却缺地址时，服务端已退回词法）。
 *
 * `hash` 那一档要明写「非语义」：它走的是同一条链路，但只认字面重合，
 * 不写清楚就会被当成语义检索用。
 */

import type { KbRetrievalInfo } from '@/lib/kb/kbClient';

export interface RetrievalCaption {
  text: string;
  /** 需要引起注意（配置有误 / 有块没建索引） */
  warning: boolean;
}

/** 说明文字的前半句（与检索实现无关的部分）。 */
export const KB_CAPTION_BASE = '团队共享资料 · 按角色可见 · 检索在服务端先过滤再打分';

/**
 * 个人知识库的前半句。
 *
 * 为什么不能沿用上面那句：它写着「团队共享资料 · 按角色可见」，而个人库里
 * **没有任何别人**。同一条说明贴在两种库上，就等于在个人库里说一句假话 ——
 * 而这句话还是关于权限的，用户会据此决定敢不敢往里放私人资料。
 */
export const KB_CAPTION_PERSONAL = '仅自己可见 · 检索在服务端先过滤再打分';

function coverage(info: KbRetrievalInfo): string {
  const pending = Math.max(0, info.chunks - info.indexed);
  const base = `已索引 ${info.indexed}/${info.chunks} 块`;
  return pending > 0 ? `${base}，有 ${pending} 块待建索引` : base;
}

export function describeRetrieval(
  info: KbRetrievalInfo | null | undefined,
  base: string = KB_CAPTION_BASE,
): RetrievalCaption {
  if (!info) {
    // 还没拿到状态：只说与实现无关的部分，不猜引擎
    return { text: base, warning: false };
  }
  if (info.error.trim() !== '') {
    return {
      text: `检索配置有误：${info.error}（当前退回词法检索）`,
      warning: true,
    };
  }
  if (info.embedder === 'off') {
    return { text: `${base}（当前词法检索，向量检索未启用）`, warning: false };
  }

  const engine =
    info.embedder === 'hash'
      ? '本地哈希向量（非语义，只认字面重合）'
      : info.model.trim() !== ''
        ? info.model
        : info.embedder;
  return {
    text: `${base}（向量检索：${engine}；${coverage(info)}）`,
    // 有块没建索引：排序会「一半新一半旧」，值得提示但不阻断使用
    warning: info.stale,
  };
}
