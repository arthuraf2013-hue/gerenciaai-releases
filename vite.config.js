import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// Versão do app no renderer (ex.: integração com o Vértice mostra a versão do caixa).
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  base: './', // necessário para funcionar com o protocolo app:// em produção
  server: { port: 5173 },
  define: { __APP_VERSION__: JSON.stringify(version) },
});
