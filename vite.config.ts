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
      // 开发模式下把 /api/nanobot 代理到本地 nanobot serve，避免浏览器跨域导致网关显示离线
      '/api/nanobot': {
        target: 'http://127.0.0.1:8900',
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
        // 将大依赖独立分包，避免单一 chunk 过大、提升首屏加载。
        // 尤其 mermaid 体积大且非首屏必需，单独拆包可走懒加载。
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          mui: ['@mui/material', '@mui/icons-material', '@emotion/react', '@emotion/styled'],
          markdown: [
            'react-markdown',
            'remark-gfm',
            'react-syntax-highlighter',
          ],
          mermaid: ['mermaid'],
          zustand: ['zustand'],
        },
      },
    },
  },
}));
