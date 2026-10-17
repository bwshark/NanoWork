import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Vite 构建配置（Web 与 Electron 共用同一份渲染层 src/）
// 别名 @ -> src，供 TS（tsconfig paths）与 Vite 共用。
export default defineConfig(({ command }) => ({
  // Electron 用 loadFile(file://) 加载 dist/index.html 时，资源必须用相对路径，
  // 否则 /assets/* 会指向磁盘根目录导致 404、页面空白。
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5176,
    host: true,
    proxy: {
      // 开发模式下把 /api/nanobot 代理到本地 nanobot serve，避免浏览器跨域导致网关显示离线。
      // 端口是**首选值**：主进程默认用 18900（8900 落在 Windows 保留端口区间，绑不上，
      // 见 src/lib/constants.ts 的说明）。若主进程自动顺延了端口，这里的代理会失效——
      // 代理只作用于 `npm run dev` 的浏览器调试，Electron 走 webSecurity:false 直连。
      '/api/nanobot': {
        target: 'http://127.0.0.1:18900',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nanobot/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // 分包策略（FR-13.5）。
        //
        // ⚠️ 踩过两次的坑，写在这里免得再犯：**Vite 的 `__vitePreload` 助手必须单独
        // 成 chunk**。它被每个含动态 `import()` 的 chunk 副作用导入（`import
        // "./x.js"`），所以**它落在哪个 chunk，那个 chunk 就必然进入入口的静态依赖
        // 图**，进而被 `modulepreload`。实测两次「同块」形态都中了：
        //
        // 1. 原先手工写 `markdown: ['react-markdown', ...]` —— 助手下沉进 `markdown`
        //    chunk，772 KB 被 preload（本意明明是「拆出来好懒加载」，结果相反）；
        // 2. 把 markdown 摘掉后，助手又落进 `mermaid` chunk，665 KB 被 preload。
        //
        // 结论：**手工分包只影响缓存粒度，不产生懒加载**；而大依赖与助手同块会
        // 反向把整个大依赖搬上首屏。所以这里只保留「本来就该在首屏」的依赖，
        // 其余（mermaid / react-markdown 等）一律交给 Rollup 按动态导入自动分块。
        // 判据：`node tasks/verify-b5-first-paint.mjs`（卡 1.2 MB）。
        manualChunks(id) {
          if (id.includes('vite/preload-helper')) return 'preload-helper';
          if (/node_modules\/(react|react-dom|react-router|react-router-dom)\//.test(id)) {
            return 'react';
          }
          if (/node_modules\/@(mui|emotion)\//.test(id)) return 'mui';
          if (/node_modules\/zustand\//.test(id)) return 'zustand';
          return undefined;
        },
      },
    },
  },
}));
