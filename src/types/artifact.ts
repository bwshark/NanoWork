/**
 * 富产物类型（FR-007 + 文件产物）。
 *
 * `file` 与其余 7 种**来源不同**：其余 7 种由回复文本里的围栏代码块启发式提取
 * （内容即产物），`file` 由**工具调用**推导（`write_file` / `edit` / `apply_patch`
 * 真正落到磁盘的文件）——它的身份是**路径**而不是内容。
 */
export type ArtifactType =
  | 'html'
  | 'svg'
  | 'image'
  | 'mermaid'
  | 'code'
  | 'markdown'
  | 'video'
  | 'file';

/** 文件产物的变更性质：本会话新建 / 改写既有文件 */
export type ArtifactChange = 'created' | 'modified';

/** 富产物（可被 ArtifactRenderer 渲染） */
export interface Artifact {
  id: string;
  type: ArtifactType;
  title?: string;
  /** 文本类内容；video 为外链 url；file 为写入时的正文快照（改写类工具拿不到全文则为空串） */
  content: string;
  /** code 高亮语言（file 由扩展名推断） */
  language?: string;
  /** image / video 外链 url */
  url?: string;
  /** 创建时间 ISO 8601 UTC */
  createdAt: string;
  /**
   * 文件产物的绝对路径（**幂等身份**：同路径再次写入 = 同一产物升一版）。
   *
   * 以分隔符归一后的原文为准，展示与「在资源管理器打开」都用它。
   */
  path?: string;
  /** 文件产物的字节数（正文快照可得时算 UTF-8 字节长；`edit` 拿不到全文时为 undefined） */
  size?: number;
  /** 文件产物的变更性质（created=本会话新建 / modified=改写既有文件） */
  change?: ArtifactChange;
  /**
   * 文件产物的**事件级内容指纹**（仅正文不可得的改写类工具设置，值取工具事件 id）。
   *
   * 存在的唯一理由：`edit` / `apply_patch` 只能看到改动片段、看不到改写后的全文，
   * 若以空正文参与内容寻址，多次改写会算出同一个 hash 而被误判为「内容没变」
   * ——变更链就断了。用事件 id 兜底后，每次改写都稳定推进一版。
   */
  fingerprint?: string;
}

/**
 * 产物索引条目（FR-7.2 + 产物同步 + FR-7.4 版本链，M6 批次 6）。
 *
 * **刻意不含 `content`**：内容本体仍随消息 / `bySession` 存（见规格 D1），索引只承载
 * 检索与去重需要的元数据。内容池（`bodies`）按 `contentHash` 跨端去重，见 `artifactsStore`。
 *
 * **含 LWW 四元数据**（`rev` / `updatedAt` / `updatedBy` / `deletedAt`）：索引条目作为
 * LWW 实体跨端传播（走同步层的 `ArtifactsAdapter`，与 8 个可同步实体同款裁决），`title`
 * 演进由 `updatedAt` 三级 tie-break 决定胜负。`deletedAt` 非空 = 墓碑（跨端删除传播）。
 *
 * **FR-7.4 版本链**：`version` 是当前版本号（1 起），`previousVersion` 指向上一版本的
 * `contentHash`（沿 `bodies` 回溯旧正文），`versions` 是完整版本历史（供 UI 对比 / 回退）。
 * 三者随 LWW 条目一起跨端传播；LWW 裁决只看 `rev` / `updatedAt`，版本元数据不参与胜负判定。
 *
 * 落点两处：store 索引切片（两端权威）+ Electron 镜像 `<userData>/artifact-index/<id>.json`。
 */
export interface ArtifactIndexEntry {
  /** 产物 id（与 `Artifact.id` 一致，也是索引文件名 `<id>.json`） */
  id: string;
  sessionId: string;
  messageId?: string;
  type: ArtifactType;
  title?: string;
  /** 内容寻址：`sha256:<hex>`（UTF-8），见 `src/lib/core/contentHash.ts` */
  contentHash: string;
  /** 创建时间 ISO 8601 UTC */
  createdAt: string;
  /** LWW 版本号：新建 1，每次改写 +1 */
  rev: number;
  /** 最后修改时间 ISO 8601 UTC（服务端接收时归一，见 sync 设计 §5.3） */
  updatedAt: string;
  /**
   * 最后修改设备 id（`platform.appInfo().deviceId`）。
   *
   * store 的同步写入动作（`recordArtifact` / `clearSession` / `clearAll` / 版本动作）
   * 无法拿到异步的 `deviceId`，故此处写空串 `''`，由同步适配器 `collect()` 阶段补成
   * 真实 `deviceId`（与 `fileAssets` 同款策略）。
   */
  updatedBy: string;
  /** 删除时间；非空 = 墓碑（跨端删除传播，与 8 个实体同款语义） */
  deletedAt: string | null;
  /** FR-7.4：当前版本号（1 起，每次同 id 内容变化 +1） */
  version: number;
  /** FR-7.4：上一版本的 `contentHash`（沿 `bodies` 回溯旧正文）；version 1 时无 */
  previousVersion?: string;
  /** FR-7.4：完整版本历史（供 UI 对比 / 回退）；`contentHash` 指向 `bodies` 里的正文 */
  versions?: ArtifactVersionMeta[];
}

/** FR-7.4 单条版本元数据（挂在 `ArtifactIndexEntry.versions` 上，随条目同步）。 */
export interface ArtifactVersionMeta {
  /** 版本号，从 1 递增 */
  version: number;
  /** 该版本正文的 `contentHash`（指向 `bodies` 池里的唯一正本） */
  contentHash: string;
  /** 该版本创建时间 ISO 8601 UTC */
  createdAt: string;
  /** 该版本标题（可空） */
  title?: string;
}
