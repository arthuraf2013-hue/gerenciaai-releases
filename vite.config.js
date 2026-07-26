import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // necessário para funcionar com o protocolo app:// em produção
  server: { port: 5173 },
});
