import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

// O sql.js (SQLite em WebAssembly) só é usado no modo navegador; o .wasm
// precisa ficar servido na raiz. O pacote resolve pro build "browser" no
// Vite, que pede `sql-wasm-browser.wasm` (o `sql-wasm.wasm` é do build
// Node, usado nos testes direto do node_modules). Copiado a cada build/dev.
mkdirSync(new URL('./public', import.meta.url), { recursive: true });
copyFileSync(new URL('./node_modules/sql.js/dist/sql-wasm-browser.wasm', import.meta.url), new URL('./public/sql-wasm-browser.wasm', import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: './',
  define: { __VERSAO_APP__: JSON.stringify(pkg.version) },
  build: {
    target: 'chrome89', // WebView do Android 7+ atualizado pela Play Store
    outDir: 'dist',
    chunkSizeWarningLimit: 900,
  },
  server: { port: 5180 },
});
