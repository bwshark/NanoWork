/** 模型信息（用于模型选择器与 listModels） */
export interface ModelInfo {
  /** 预设 key（如 default / qwen3-max），请求 model 字段使用该值 */
  id: string;
  /** 展示名（预设 label，缺省回退 id） */
  label?: string;
  /** 预设实际对应的底层模型名 */
  model?: string;
}
