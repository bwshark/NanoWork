/** 富产物类型（FR-007） */
export type ArtifactType =
  | 'html'
  | 'svg'
  | 'image'
  | 'mermaid'
  | 'code'
  | 'markdown'
  | 'video';

/** 富产物（可被 ArtifactRenderer 渲染） */
export interface Artifact {
  id: string;
  type: ArtifactType;
  title?: string;
  /** 文本类内容；video 为外链 url */
  content: string;
  /** code 高亮语言 */
  language?: string;
  /** image / video 外链 url */
  url?: string;
  /** 创建时间 ISO 8601 UTC */
  createdAt: string;
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
  /** 内容寻址：`sha256:<hex>`（UTF-8），见 `src/lib/contentHash.ts` */
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
