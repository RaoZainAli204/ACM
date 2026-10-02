import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'client', plugins: [react()],
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000', '/health': 'http://127.0.0.1:3000', '/socket.io': { target: 'http://127.0.0.1:3000', ws: true } } }
});
