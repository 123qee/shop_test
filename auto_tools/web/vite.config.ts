import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': path.resolve(__dirname, '../shared') },
  },
  server: {
    port: 5173,
    // 开发期把 /api 代理到本地后端,避免跨域
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
