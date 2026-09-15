import { webcrypto } from 'node:crypto';
import { beforeEach } from 'vitest';

// —— 内存垫片：保证在纯 node 环境下也能加载 platform.web（依赖 localStorage / crypto）——
// jsdom 环境已原生提供 window.localStorage 与 crypto，此垫片仅在缺失时兜底。
const g = globalThis as unknown as Record<string, unknown>;

if (typeof g.crypto === 'undefined') {
  g.crypto = webcrypto;
}

if (typeof g.localStorage === 'undefined') {
  const mem = new Map<string, string>();
  const storage = {
    get length() {
      return mem.size;
    },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => void mem.delete(k),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
  };
  g.localStorage = storage;
  if (typeof g.window === 'undefined') {
    g.window = globalThis;
  }
}

// 每个测试文件执行前清空持久化状态，避免 zustand persist 的跨用例串扰。
beforeEach(() => {
  try {
    (globalThis as unknown as { localStorage: Storage }).localStorage.clear();
  } catch {
    /* ignore */
  }
});
