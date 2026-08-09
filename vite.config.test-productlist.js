import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: './',
  root: './test-productlist-tmp',
  build: { outDir: '../test-productlist-tmp-dist', emptyOutDir: true },
});
