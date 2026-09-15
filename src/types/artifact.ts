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
