import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.ATTENTION_WEB_PORT || 5173),
    proxy: {
      '/api': `http://127.0.0.1:${process.env.ATTENTION_API_PORT || 8765}`,
    },
  },
  build: {
    outDir: 'dist',
  },
});
