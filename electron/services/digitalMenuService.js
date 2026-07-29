const { getDb } = require('../db/database');
const productService = require('./productService');

function getConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM digital_menu_config WHERE id = ?').get('default');
}

function updateConfig({ titulo, subtitulo, corTema, mostrarPrecos, rodapeTexto }) {
  const db = getDb();
  const current = getConfig();
  db.prepare(
    `UPDATE digital_menu_config SET titulo = ?, subtitulo = ?, cor_tema = ?, mostrar_precos = ?, rodape_texto = ? WHERE id = 'default'`
  ).run(
    titulo !== undefined ? titulo : current.titulo,
    subtitulo !== undefined ? (subtitulo || null) : current.subtitulo,
    corTema !== undefined ? corTema : current.cor_tema,
    mostrarPrecos !== undefined ? (mostrarPrecos ? 1 : 0) : current.mostrar_precos,
    rodapeTexto !== undefined ? (rodapeTexto || null) : current.rodape_texto,
  );
  return { ok: true };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Monta a página HTML final do cardápio digital — arquivo único,
 * autocontido (CSS embutido), pra abrir em qualquer navegador, exibir
 * num tablet/TV, ou mandar por link/arquivo pro cliente. */
function generateHtml() {
  const config = getConfig();
  const itens = productService.listFullMenu();

  const grupos = {};
  for (const item of itens) {
    const chave = item.tipo || 'Cardápio';
    if (!grupos[chave]) grupos[chave] = [];
    grupos[chave].push(item);
  }

  const gruposHtml = Object.entries(grupos).map(([tipo, pratos]) => `
    <section class="grupo">
      <h2>${escapeHtml(tipo)}</h2>
      <div class="itens">
        ${pratos.map((p) => `
          <div class="item">
            <span class="nome">${escapeHtml(p.nome)}</span>
            ${config.mostrar_precos ? `<span class="preco">R$ ${p.preco.toFixed(2)}</span>` : ''}
          </div>
        `).join('')}
      </div>
    </section>
  `).join('');

  return `<!doctype html>
  <html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(config.titulo)}</title>
  <style>
    :root { --cor-tema: ${config.cor_tema || '#0f6e63'}; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: 'Segoe UI', system-ui, sans-serif; background: #faf8f5; color: #2b2b2b; }
    header { background: var(--cor-tema); color: white; padding: 40px 24px; text-align: center; }
    header h1 { margin: 0 0 6px; font-size: 32px; }
    header p { margin: 0; opacity: 0.9; font-size: 16px; }
    main { max-width: 720px; margin: 0 auto; padding: 32px 20px 60px; }
    .grupo { margin-bottom: 32px; }
    .grupo h2 { color: var(--cor-tema); font-size: 20px; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 2px solid var(--cor-tema); padding-bottom: 8px; margin-bottom: 16px; }
    .item { display: flex; justify-content: space-between; align-items: baseline; padding: 10px 0; border-bottom: 1px dashed #ddd; font-size: 17px; }
    .nome { flex: 1; }
    .preco { font-weight: 700; color: var(--cor-tema); margin-left: 16px; white-space: nowrap; }
    footer { text-align: center; padding: 24px; color: #888; font-size: 13px; }
  </style>
  </head>
  <body>
    <header>
      <h1>${escapeHtml(config.titulo)}</h1>
      ${config.subtitulo ? `<p>${escapeHtml(config.subtitulo)}</p>` : ''}
    </header>
    <main>
      ${gruposHtml || '<p style="text-align:center;color:#888">Nenhum prato cadastrado ainda — marque o "Tipo" no cadastro do produto pra ele aparecer aqui.</p>'}
    </main>
    ${config.rodape_texto ? `<footer>${escapeHtml(config.rodape_texto)}</footer>` : ''}
  </body></html>`;
}

module.exports = { getConfig, updateConfig, generateHtml };
