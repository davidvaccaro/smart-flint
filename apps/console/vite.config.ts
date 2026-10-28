import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    strictPort: true,
    watch: { usePolling: true, interval: 500 },
    proxy: Object.fromEntries(['/api', '/launch', '/oauth', '/fhir', '/cds-services'].map(path => [path, { target: 'http://127.0.0.1:3001', changeOrigin: false }]))
  },
  build: { outDir: 'dist', sourcemap: true }
});
