/**
 * **会话版本引用集**（FR-3.9 ①）：把「建这个会话时生效的插件是哪一版」记成一份
 * 跟着会话走的**声明**，而不是只留在本机磁盘上。
 *
 * ## 为什么需要它
 *
 * 插件副本按 `cache/<market>/<plugin>/<version>/` 归档，`<version>/current` 指针决定
 * 「现在生效哪一版」。指针是**本机事实**：A 机器指着 `0.1.9`、B 机器指着 `0.1.10`
 * 完全正常。于是两个问题在同步之后才会暴露：
 *
 * 1. **GC 误删**：`collectCache` 的引用集原本只由**本机**生效包根给出
 *    （`referencedCopyPaths`）——一台机器把「另一台机器的会话正在用的那一版」
 *    当成无引用旧副本删掉，那条会话换回来就读不到它当初的插件了。
 * 2. **不一致看不见**：用户在 A 上建的会话同步到 B，B 只有 `0.1.10`；
 *    界面上永远「一切正常」，而会话的实际行为已经变了。
 *
 * ## 为什么是「声明」而不是「缓存」
 *
 * 语义上它是**历史事实**：这个会话当初用的是哪一版。所以：
 * - 只在**建会话时**快照一次，之后不随「本机装了什么」漂移；
 * - 参与同步（`SESSION_SYNC_FIELDS` 白名单），因为历史事实跨设备成立；
 * - **不**每轮发送刷新——那会把声明变成「最近一次发送时的磁盘状态」，
 *   既涨 `rev`（同步噪音），又让「这个会话用的哪一版」变成一个永远在变的值。
 *
 * 要换版本 → 新建会话（或后续单列一个显式动作），而不是悄悄改历史。
 *
 * ## 为什么 `intended` 而不是引擎激活态
 *
 * 快照要能在**引擎没起**时也生成（插件页可以不进，会话却天天建），
 * 而引擎激活态那时是空的。且它服务的是「保护引用」，取**更宽**的一侧更安全：
 * 多保护一个不会被用到的版本，代价只是多留一份副本；少保护一个，
 * 就是「用户回滚回去发现插件没了」。
 */

import type { PluginView } from '@/types/plugin';

/** 会话版本引用集：`{ 插件名: 版本 }` */
export type SessionPluginVersions = Record<string, string>;

/** 引用集里某一项在本机的解析结果 */
export interface SessionPluginRefResolution {
  name: string;
  /** 会话声明要用的版本 */
  version: string;
  /** 本机该版本的副本根；未装时为 `null` */
  path: string | null;
  /**
   * - `matched`：本机装了这个版本；
   * - `missing`：本机**没有**这一版（会话行为可能与当初不一致）。
   *
   * 刻意不区分「没装这个插件」与「装了别的版本」：对调用方而言处置相同
   * （要么装回来，要么接受差异），而分开会让界面多出一种没人会行动的文案。
   */
  state: 'matched' | 'missing';
}

/**
 * 建会话时的版本快照。
 *
 * 取「本地意图为启用 + 有市场来源 + 版本可读」的插件。版本读 `source.version`
 * （引擎上报优先、路径反推兜底），再退包自己声明的版本——本地直接安装的包
 * 没有市场来源，但那不属于「会被 GC 的副本」，故 `market === null` 的一律不收。
 *
 * 全空时返回 `undefined` 而不是 `{}`：空对象会让每份 meta 都多一行噪音，
 * 且 `undefined` 与 `{}` 在「有没有引用集」上语义相同，没必要多一种形态。
 */
export function snapshotSessionPluginVersions(
  views: readonly PluginView[],
): SessionPluginVersions | undefined {
  const out: SessionPluginVersions = {};
  for (const view of views) {
    if (!view.intended) continue;
    if (view.source.market === null) continue;
    const name = view.plugin.manifest.name;
    if (name === '') continue;
    const version = view.source.version ?? view.plugin.manifest.version;
    if (!version) continue;
    out[name] = version;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 用**本机**已安装的副本解析引用集。
 *
 * 结果按插件名升序，便于界面稳定展示与断言（对象键序不参与语义）。
 */
export function resolveSessionPluginRefs(
  refs: SessionPluginVersions | undefined,
  views: readonly PluginView[],
): SessionPluginRefResolution[] {
  if (!refs) return [];
  const rows: SessionPluginRefResolution[] = [];
  for (const name of Object.keys(refs).sort()) {
    const version = refs[name];
    const view = views.find(
      (v) =>
        v.plugin.manifest.name === name &&
        (v.source.version ?? v.plugin.manifest.version) === version,
    );
    rows.push({
      name,
      version,
      path: view ? view.plugin.root : null,
      state: view ? 'matched' : 'missing',
    });
  }
  return rows;
}

/**
 * 把所有会话的引用集与本机副本对账，挑出**缺失**项。
 *
 * 这就是模块开头说的第 2 个问题（「不一致看不见」）的界面侧答案：数据层早就算得出来，
 * 但没人调它，界面就永远「一切正常」。调用方据此提示用户即可。
 *
 * 规模上它是「会话 × 引用项」，但缺失本就是罕见的例外，先取会话再对账比
 * 先建倒排索引直白得多——可读性优先，这个量级不涉及性能。
 *
 * 排序为了界面稳定展示：按会话标题、再按插件名。
 */
export interface MissingSessionPluginRef {
  sessionId: string;
  sessionTitle: string;
  plugin: string;
  version: string;
}

export function collectMissingSessionPluginRefs(
  sessions: readonly {
    id: string;
    title: string;
    pluginVersions?: SessionPluginVersions | null;
  }[],
  views: readonly PluginView[],
): MissingSessionPluginRef[] {
  const out: MissingSessionPluginRef[] = [];
  for (const session of sessions) {
    for (const row of resolveSessionPluginRefs(session.pluginVersions ?? undefined, views)) {
      if (row.state !== 'missing') continue;
      out.push({
        sessionId: session.id,
        sessionTitle: session.title,
        plugin: row.name,
        version: row.version,
      });
    }
  }
  return out.sort(
    (a, b) => a.sessionTitle.localeCompare(b.sessionTitle) || a.plugin.localeCompare(b.plugin),
  );
}

/**
 * 被**会话引用集**要求保留的副本路径（GC 保护用）。
 *
 * 与 `referencedCopyPaths(views)`（本机生效副本）取**并集**：前者回答「我本地正在用
 * 哪一版」，本函数回答「别的设备上的会话要哪一版」。两者都满足才能回收。
 *
 * 只收市场来源的副本：本地直装的插件不在 `cache/<market>/` 下，GC 也不会碰它。
 */
export function referencedCopyPathsForSessions(
  views: readonly PluginView[],
  refSets: readonly (SessionPluginVersions | undefined)[],
): string[] {
  const wanted = new Set<string>();
  for (const refs of refSets) {
    if (!refs) continue;
    for (const name of Object.keys(refs)) wanted.add(`${name}@${refs[name]}`);
  }
  if (wanted.size === 0) return [];
  const paths = new Set<string>();
  for (const view of views) {
    if (view.source.market === null) continue;
    const name = view.plugin.manifest.name;
    const version = view.source.version ?? view.plugin.manifest.version;
    if (!version) continue;
    if (!wanted.has(`${name}@${version}`)) continue;
    if (view.plugin.root === '') continue;
    paths.add(view.plugin.root);
  }
  return [...paths].sort();
}
