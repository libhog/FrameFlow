import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  clearScreen: false,
  build: {
    rollupOptions: {
      input: {
        app: resolve(rootDir, 'index.html'),
        review: resolve(rootDir, 'ui-review.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/target/**'],
    },
  },
});
