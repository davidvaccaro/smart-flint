import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 4100, strictPort: true,
    // Workspace edits can arrive through a mounted filesystem without native events.
    watch: { usePolling: true, interval: 500 },
  },
});
