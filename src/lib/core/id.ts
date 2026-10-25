/**
 * 唯一 ID 生成，封装 crypto.randomUUID。
 * 在不支持 randomUUID 的旧环境下回退到时间戳 + 随机串。
 */
export function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // ignore
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
