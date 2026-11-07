import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));

/**
 * Build do app do celular (ver README.md). Três páginas:
 *   index.html  -- garçom, PDV móvel e consulta remota (instalável, offline)
 *   loja.html   -- vitrine online pública (não registra service worker)
 *   painel.html -- painel de senhas para TV / Vértice (não registra service worker)
 *
 * `base: './'`: os caminhos saem relativos, então a pasta dist/ funciona em
 * qualquer hospedagem estática, na raiz ou numa subpasta.
 *
 * O service worker (sw.js) é gerado DEPOIS do build, com a lista exata dos
 * arquivos de dist/ e uma versão tirada do conteúdo deles: mudou qualquer
 * arquivo, muda a versão, e o celular baixa a nova -- sem número à mão.
 */

function listarArquivos(dir) {
  const saida = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida.push(...listarArquivos(caminho));
    else saida.push(caminho);
  }
  return saida;
}

function gerarServiceWorker() {
  let dirSaida;
  return {
    name: 'gerenciaai-service-worker',
    apply: 'build',
    configResolved(config) {
      dirSaida = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const arquivos = listarArquivos(dirSaida)
        .map((f) => relative(dirSaida, f).split(sep).join('/'))
        .filter((f) => f !== 'sw.js' && !f.endsWith('.map'))
        .sort();
      const hash = createHash('sha256');
      for (const f of arquivos) {
        hash.update(f);
        hash.update(readFileSync(join(dirSaida, f)));
      }
      const versao = hash.digest('hex').slice(0, 12);
      const modelo = readFileSync(resolve(dirSaida, '..', 'sw.js'), 'utf8');
      const MARCA_ARQUIVOS = 'const ARQUIVOS = __ARQUIVOS__;';
      const MARCA_VERSAO = "const VERSAO = '__VERSAO__';";
      if (!modelo.includes(MARCA_ARQUIVOS) || !modelo.includes(MARCA_VERSAO)) {
        throw new Error('sw.js sem as linhas marcadoras de ARQUIVOS/VERSAO -- o service worker não seria gerado direito.');
      }
      const lista = ['./', ...arquivos.map((f) => `./${f}`)];
      const sw = modelo
        .replace(MARCA_ARQUIVOS, `const ARQUIVOS = ${JSON.stringify(lista)};`)
        .replace(MARCA_VERSAO, `const VERSAO = '${versao}';`);
      writeFileSync(join(dirSaida, 'sw.js'), sw);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), gerarServiceWorker()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    // O app inteiro fica guardado no aparelho (service worker); um arquivo
    // grande só pesa na primeira instalação.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        index: resolve(AQUI, 'index.html'),
        loja: resolve(AQUI, 'loja.html'),
        painel: resolve(AQUI, 'painel.html'),
      },
    },
  },
});
