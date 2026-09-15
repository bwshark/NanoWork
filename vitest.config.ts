import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

// Vitest 配置（与 vite 构建共享 @→src 别名，使用 jsdom 环境模拟浏览器 API）。
// 测试 setup 中会给 localStorage / crypto 打内存垫片，确保 node 下也能跑 platform.web。
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    clearMocks: true,
  },
});
