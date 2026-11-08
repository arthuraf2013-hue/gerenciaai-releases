// Gera os treinamentos em PDF (public/treinamento-<perfil>.pdf) com o
// Electron do próprio projeto: `npm run treinamentos` (todos) ou
// `npm run treinamentos -- restaurante farmacia` (só esses).
// Conteúdo em conteudo.cjs, visual em modelo.cjs.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PERFIS, montarDeck } = require('./conteudo.cjs');
const { montarHtml } = require('./modelo.cjs');

const SAIDA = path.join(__dirname, '..', '..', 'public');
const ARQUIVO = (id) => path.join(SAIDA, `treinamento-${id}.pdf`);

app.disableHardwareAcceleration();

let janela = null;

async function carregar(arquivo) {
  // Uma tentativa a mais: logo depois de imprimir um PDF o Chromium às vezes
  // recusa o próximo arquivo (ERR_FAILED/ERR_ABORTED).
  for (let tentativa = 1; ; tentativa++) {
    try {
      await janela.loadFile(arquivo);
      return;
    } catch (err) {
      if (tentativa >= 3) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

async function gerar(id) {
  const deck = montarDeck(id);
  const html = montarHtml(deck);
  // Arquivo temporário (não data:): o HTML usa fontes e imagens por file://.
  const tmp = path.join(os.tmpdir(), `gerenciaai-treinamento-${id}.html`);
  fs.writeFileSync(tmp, html);
  try {
    await carregar(tmp);
    await janela.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true).catch(() => true);
    const pdf = await janela.webContents.printToPDF({
      printBackground: true, preferCSSPageSize: true, margins: { marginType: 'none' },
    });
    fs.writeFileSync(ARQUIVO(id), pdf);
    console.log(`  ${path.relative(process.cwd(), ARQUIVO(id))}  (${deck.slides.length} slides, ${Math.round(pdf.length / 1024)} KB)`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

app.whenReady().then(async () => {
  const pedidos = process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('.cjs') && a !== '.');
  const ids = pedidos.length ? pedidos : Object.keys(PERFIS);
  const desconhecidos = ids.filter((id) => !PERFIS[id]);
  if (desconhecidos.length) {
    console.error(`Perfil desconhecido: ${desconhecidos.join(', ')}. Use: ${Object.keys(PERFIS).join(', ')}`);
    app.exit(1);
    return;
  }
  console.log('Gerando treinamentos…');
  janela = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { offscreen: true } });
  try {
    for (const id of ids) await gerar(id);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
