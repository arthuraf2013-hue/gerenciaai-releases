// Roda entre o `vite build` e o `cap sync android`: tira do pacote o que
// só serve pro modo navegador (o SQLite em WebAssembly -- no celular o
// banco é o SQLite nativo). Em Node puro pra funcionar igual no Windows.
import { rmSync } from 'node:fs';

for (const arquivo of ['dist/sql-wasm-browser.wasm']) {
  rmSync(new URL(`../${arquivo}`, import.meta.url), { force: true });
}
console.log('[prepararAndroid] arquivos só-navegador removidos do pacote');
