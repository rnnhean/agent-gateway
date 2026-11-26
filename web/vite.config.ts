import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // 开发时把 API 代理到网关，避免跨域
    proxy: {
      '/health': 'http://127.0.0.1:8794',
      '/metrics': 'http://127.0.0.1:8794',
      '/api': 'http://127.0.0.1:8794',
      '/v1': 'http://127.0.0.1:8794',
    },
  },
});
