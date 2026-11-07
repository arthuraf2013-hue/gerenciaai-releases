const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Impressora da COZINHA -- separada da impressora do caixa.
 *
 * O que sai nela:
 *  - itens novos de uma comanda de MESA (manual, pelo botão "Imprimir
 *    comanda", ou automático: o ciclo abaixo junta o que foi lançado nos
 *    últimos segundos -- PC, celular do garçom, painel de mesas, QR -- e
 *    imprime uma vez por mesa);
 *  - pedido de retirada/"comer aqui" aceito na Separação (com a SENHA);
 *  - venda do balcão com senha (lanchonete), na finalização.
 *
 * Só os itens das categorias marcadas (ex.: bebida da geladeira não vai pra
 * cozinha); sem nenhuma marcada, vai tudo.
 *
 * Garantias:
 *  - um item de comanda sai UMA vez: `sale_items.enviado_cozinha` só vira 1
 *    depois que a impressora aceitou; falhou, fica 0 e tenta de novo (o
 *    automático espera 30 s antes de repetir a mesma mesa);
 *  - toda tentativa fica em `cozinha_impressoes` com o conteúdo exato --
 *    "Reimprimir" sai igual, e falha (impressora desligada) aparece na tela;
 *  - o pedido da Separação sai uma vez só no automático (reimprimir é manual).
 *
 * Impressora: 'windows' (instalada, pelo nome -- HTML como o recibo) ou
 * 'rede' (térmica ESC/POS em IP:porta, ver escposService.js).
 */

const PAPEIS_GESTAO = ['gerente', 'admin', 'suporte'];
const ESPERA_AGRUPAR_MS = 5000; // junta itens lançados em sequência numa folha só
const ESPERA_APOS_FALHA_MS = 30000;

let impressorWindows = null; // trocado nos testes
let enviarRede = null;
function _definirImpressorasParaTeste({ windows, rede } = {}) {
  impressorWindows = windows || null;
  enviarRede = rede || null;
}

function getRow() {
  const db = getDb();
  let row = db.prepare(`SELECT * FROM cozinha_impressao_config WHERE id = 'default'`).get();
  if (!row) {
    db.prepare(`INSERT INTO cozinha_impressao_config (id) VALUES ('default')`).run();
    row = db.prepare(`SELECT * FROM cozinha_impressao_config WHERE id = 'default'`).get();
  }
  return row;
}

function parseCategorias(json) {
  try {
    const lista = JSON.parse(json || '[]');
    return Array.isArray(lista) ? lista.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim()) : [];
  } catch {
    return [];
  }
}

function getConfig() {
  const r = getRow();
  return {
    ativa: r.ativa === 1,
    tipo: r.tipo === 'rede' ? 'rede' : 'windows',
    impressoraWindows: r.impressora_windows || '',
    ip: r.ip || '',
    porta: Number(r.porta) || 9100,
    larguraMm: Number(r.largura_mm) === 58 ? 58 : 80,
    codepage: r.codepage || 'cp860',
    automatica: r.automatica === 1,
    categorias: parseCategorias(r.categorias_json),
    copias: Math.min(3, Math.max(1, Number(r.copias) || 1)),
    cortarPapel: r.cortar_papel !== 0,
  };
}

/** Categorias cadastradas (pra marcar as que vão pra cozinha). */
function listarCategorias() {
  return getDb().prepare(
    `SELECT DISTINCT TRIM(categoria) AS c FROM products WHERE ativo = 1 AND categoria IS NOT NULL AND TRIM(categoria) <> '' ORDER BY 1`
  ).all().map((r) => r.c);
}

function saveConfig(payload = {}) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(payload.requestingUserId);
  if (!user || !PAPEIS_GESTAO.includes(user.role)) return { ok: false, error: 'Apenas um gerente ou administrador pode configurar a impressora da cozinha.' };
  const atual = getConfig();
  const tipo = payload.tipo === 'rede' ? 'rede' : (payload.tipo === 'windows' ? 'windows' : atual.tipo);
  const ativa = payload.ativa !== undefined ? !!payload.ativa : atual.ativa;
  const ip = payload.ip !== undefined ? String(payload.ip || '').trim() : atual.ip;
  const porta = payload.porta !== undefined ? Number(payload.porta) : atual.porta;
  const impressoraWindows = payload.impressoraWindows !== undefined ? String(payload.impressoraWindows || '').trim() : atual.impressoraWindows;
  if (ativa && tipo === 'rede' && !require('./escposService').enderecoValido(ip)) return { ok: false, error: 'Informe o IP da impressora da cozinha (ex.: 192.168.0.50).' };
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) return { ok: false, error: 'Porta inválida (a padrão das térmicas é 9100).' };
  if (ativa && tipo === 'windows' && !impressoraWindows) return { ok: false, error: 'Escolha a impressora da cozinha na lista.' };
  const largura = payload.larguraMm !== undefined ? Number(payload.larguraMm) : atual.larguraMm;
  if (![58, 80].includes(largura)) return { ok: false, error: 'Largura do papel: 58 ou 80 mm.' };
  const codepage = payload.codepage !== undefined ? payload.codepage : atual.codepage;
  if (!['cp860', 'cp850', 'sem_acento'].includes(codepage)) return { ok: false, error: 'Tabela de acentos inválida.' };
  const copias = payload.copias !== undefined ? Number(payload.copias) : atual.copias;
  if (!Number.isInteger(copias) || copias < 1 || copias > 3) return { ok: false, error: 'Cópias: de 1 a 3.' };
  const categorias = Array.isArray(payload.categorias)
    ? [...new Set(payload.categorias.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim().slice(0, 60)))].slice(0, 200)
    : atual.categorias;

  getRow();
  db.prepare(
    `UPDATE cozinha_impressao_config SET ativa = ?, tipo = ?, impressora_windows = ?, ip = ?, porta = ?, largura_mm = ?, codepage = ?,
       automatica = ?, categorias_json = ?, copias = ?, cortar_papel = ?, atualizado_por_id = ?, atualizado_em = NOW_SYNCED() WHERE id = 'default'`
  ).run(
    ativa ? 1 : 0, tipo, impressoraWindows || null, ip || null, porta, largura, codepage,
    (payload.automatica !== undefined ? !!payload.automatica : atual.automatica) ? 1 : 0,
    JSON.stringify(categorias), copias,
    (payload.cortarPapel !== undefined ? !!payload.cortarPapel : atual.cortarPapel) ? 1 : 0,
    payload.requestingUserId,
  );
  require('./authService').registrarEventoAuditoria({
    tipoEvento: 'cozinha_impressora_alterada', solicitanteId: payload.requestingUserId,
    motivo: ativa ? `Impressora da cozinha (${tipo === 'rede' ? `rede ${ip}:${porta}` : impressoraWindows})` : 'Impressora da cozinha desligada',
  });
  return { ok: true, config: getConfig() };
}

/** Item vai pra cozinha? Sem categoria marcada = tudo vai. */
function vaiPraCozinha(categoria, categorias) {
  if (!categorias.length) return true;
  const c = String(categoria || '').trim().toLowerCase();
  return categorias.some((x) => x.toLowerCase() === c);
}

function horaLocal() {
  return new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
}

function rotuloDaMesa(saleId) {
  const mesa = getDb().prepare(
    `SELECT numero, nome FROM restaurant_tables WHERE sale_id = ? AND unida_a_mesa_id IS NULL LIMIT 1`
  ).get(saleId);
  return mesa ? (mesa.nome || `MESA ${mesa.numero}`) : null;
}

function senhaDaVenda(saleId) {
  return getDb().prepare(`SELECT numero, nome FROM chamadas WHERE sale_id = ? AND status <> 'cancelada'`).get(saleId) || null;
}

// ---------- impressão ----------

function escHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** HTML da comanda (impressora do Windows e prévia). */
function montarComandaHtml(comanda, { larguraMm = 80 } = {}) {
  const largura = larguraMm === 58 ? 54 : 74;
  const itens = (comanda.itens || []).map((i) => `
    <div class="item"><span class="qtd">${escHtml(formatarQtd(i.quantidade))}</span> ${escHtml(i.nome)}
      ${i.pessoa ? `<div class="pessoa">para: ${escHtml(i.pessoa)}</div>` : ''}
      ${i.observacao ? `<div class="obs">&gt;&gt; ${escHtml(i.observacao)}</div>` : ''}
    </div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${larguraMm}mm auto; margin: 2mm; }
    body { font-family: Arial, sans-serif; width: ${largura}mm; margin: 0 auto; color: #000; }
    h1 { font-size: ${larguraMm === 58 ? 22 : 28}px; margin: 0; text-align: center; }
    .sub { font-size: 14px; font-weight: bold; text-align: center; margin: 2px 0; }
    .hora { font-size: 12px; text-align: center; margin-bottom: 6px; }
    .item { font-size: ${larguraMm === 58 ? 16 : 19}px; font-weight: bold; padding: 5px 0; border-top: 1px dashed #000; }
    .qtd { display: inline-block; min-width: 34px; }
    .pessoa { font-size: 13px; font-weight: normal; margin-left: 34px; }
    .obs { font-size: 15px; margin-left: 34px; }
    .rodape { border-top: 1px dashed #000; font-size: 12px; text-align: center; padding-top: 4px; }
  </style></head><body>
    <h1>${escHtml(comanda.titulo || 'COMANDA')}</h1>
    ${comanda.subtitulo ? `<p class="sub">${escHtml(comanda.subtitulo)}</p>` : ''}
    <p class="hora">${escHtml(comanda.hora || '')}</p>
    ${itens}
    ${comanda.rodape ? `<p class="rodape">${escHtml(comanda.rodape)}</p>` : ''}
  </body></html>`;
}

function formatarQtd(q) {
  const n = Number(q) || 0;
  return Number.isInteger(n) ? `${n}x` : n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

function imprimirWindowsPadrao(html, { impressora, larguraMm, copias }) {
  return new Promise((resolve, reject) => {
    const { BrowserWindow } = require('electron');
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => {
      win.webContents.print({
        silent: true, deviceName: impressora, copies: copias, printBackground: false,
        pageSize: { width: larguraMm * 1000, height: 1000000 }, margins: { marginType: 'none' },
      }, (ok, motivo) => {
        win.close();
        if (ok) resolve({ ok: true });
        else reject(new Error(`A impressora "${impressora}" não imprimiu${motivo ? ` (${motivo})` : ''}. Confira se está ligada e com papel.`));
      });
    }).catch((err) => { win.close(); reject(err); });
  });
}

/** Manda a comanda pra impressora configurada. Lança Error legível. */
async function enviarParaImpressora(comanda, config = getConfig()) {
  if (config.tipo === 'rede') {
    const escpos = require('./escposService');
    const dados = escpos.montarComandaEscPos(comanda, { largura: config.larguraMm, codepage: config.codepage, cortar: config.cortarPapel });
    const enviar = enviarRede || escpos.enviarParaRede;
    for (let i = 0; i < config.copias; i++) await enviar({ ip: config.ip, porta: config.porta, dados });
    return;
  }
  if (!config.impressoraWindows) throw new Error('Escolha a impressora da cozinha em Configurações → Cozinha.');
  const html = montarComandaHtml(comanda, { larguraMm: config.larguraMm });
  await (impressorWindows || imprimirWindowsPadrao)(html, { impressora: config.impressoraWindows, larguraMm: config.larguraMm, copias: config.copias });
}

function registrar({ saleId = null, botOrderId = null, comanda, itemIds = null, status, erro = null }) {
  const id = randomUUID();
  getDb().prepare(
    `INSERT INTO cozinha_impressoes (id, sale_id, bot_order_id, titulo, conteudo_json, item_ids_json, status, erro, impresso_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'impresso' THEN NOW_SYNCED() END)`
  ).run(id, saleId, botOrderId, String(comanda.titulo || '').slice(0, 80), JSON.stringify(comanda), itemIds ? JSON.stringify(itemIds) : null, status, erro, status);
  return id;
}

const imprimindoVenda = new Set();
const ultimaFalhaVenda = new Map();

/**
 * Itens AINDA NÃO enviados de uma comanda (venda aberta de mesa, ou venda
 * do balcão com senha), das categorias da cozinha. Marca como enviados só
 * depois que a impressora aceitou.
 */
async function imprimirItensDaVenda({ saleId, rotulo, subtitulo } = {}) {
  const config = getConfig();
  if (!config.ativa) return { ok: false, error: 'A impressora da cozinha está desligada (Configurações → Cozinha).', desligada: true };
  if (imprimindoVenda.has(saleId)) return { ok: false, error: 'Essa comanda já está sendo impressa.' };
  imprimindoVenda.add(saleId);
  try {
    const db = getDb();
    const itens = db.prepare(
      `SELECT si.id, si.quantidade, si.observacao, si.pessoa_numero, COALESCE(si.nome_personalizado, p.nome) AS nome, p.categoria,
              sp.nome AS pessoa_nome
       FROM sale_items si JOIN products p ON p.id = si.product_id
       LEFT JOIN sale_people sp ON sp.sale_id = si.sale_id AND sp.numero = si.pessoa_numero
       WHERE si.sale_id = ? AND si.cancelado = 0 AND si.enviado_cozinha = 0
       ORDER BY si.criado_em, si.rowid`
    ).all(saleId).filter((i) => vaiPraCozinha(i.categoria, config.categorias));
    if (!itens.length) return { ok: false, error: 'Nada novo para a cozinha nesta comanda.', nadaNovo: true };

    const senha = senhaDaVenda(saleId);
    const comanda = {
      titulo: rotulo || rotuloDaMesa(saleId) || (senha ? `SENHA ${senha.numero}` : 'BALCÃO'),
      subtitulo: subtitulo || (senha?.nome ? senha.nome : null),
      hora: horaLocal(),
      itens: itens.map((i) => ({
        quantidade: i.quantidade, nome: i.nome, observacao: i.observacao || null,
        pessoa: i.pessoa_nome || (i.pessoa_numero ? `Pessoa ${i.pessoa_numero}` : null),
      })),
    };
    const ids = itens.map((i) => i.id);
    try {
      await enviarParaImpressora(comanda, config);
    } catch (err) {
      ultimaFalhaVenda.set(saleId, Date.now());
      registrar({ saleId, comanda, itemIds: ids, status: 'falhou', erro: String(err.message).slice(0, 300) });
      return { ok: false, error: err.message, falhou: true };
    }
    ultimaFalhaVenda.delete(saleId);
    db.transaction(() => {
      const marcar = db.prepare('UPDATE sale_items SET enviado_cozinha = 1 WHERE id = ? AND enviado_cozinha = 0');
      for (const id of ids) marcar.run(id);
      registrar({ saleId, comanda, itemIds: ids, status: 'impresso' });
    })();
    return { ok: true, totalItens: ids.length };
  } finally {
    imprimindoVenda.delete(saleId);
  }
}

/**
 * Pedido da Separação (retirada / comer aqui / entrega) que a cozinha
 * prepara. Sai uma vez só no automático; `forcar` é o reimprimir manual.
 */
async function imprimirPedido({ botOrderId, forcar = false } = {}) {
  const config = getConfig();
  if (!config.ativa) return { ok: false, error: 'A impressora da cozinha está desligada.', desligada: true };
  const db = getDb();
  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(botOrderId);
  if (!pedido) return { ok: false, error: 'Pedido não encontrado.' };
  if (!forcar && db.prepare(`SELECT 1 FROM cozinha_impressoes WHERE bot_order_id = ? AND status = 'impresso'`).get(botOrderId)) {
    return { ok: true, jaImpresso: true };
  }
  const itens = db.prepare(
    `SELECT i.quantidade, i.observacao, COALESCE(p.nome, i.descricao_livre) AS nome, p.categoria
     FROM bot_order_items i LEFT JOIN products p ON p.id = i.product_id
     WHERE i.bot_order_id = ? AND i.status_separacao <> 'indisponivel'`
  ).all(botOrderId).filter((i) => !i.categoria || vaiPraCozinha(i.categoria, config.categorias));
  if (!itens.length) return { ok: false, error: 'Nenhum item deste pedido vai para a cozinha.', nadaNovo: true };
  const senha = db.prepare(`SELECT numero FROM chamadas WHERE bot_order_id = ? AND status <> 'cancelada'`).get(botOrderId);
  const modo = pedido.mesa_numero ? `Mesa ${pedido.mesa_numero}` : pedido.tipo_entrega === 'entrega' ? 'ENTREGA' : (pedido.consumo_local ? 'COMER AQUI' : 'RETIRADA');
  const comanda = {
    titulo: senha ? `SENHA ${senha.numero}` : (pedido.mesa_numero ? `MESA ${pedido.mesa_numero}` : 'PEDIDO'),
    subtitulo: `${pedido.cliente_nome} · ${modo}`,
    hora: horaLocal(),
    itens: itens.map((i) => ({ quantidade: i.quantidade, nome: i.nome, observacao: i.observacao || null })),
    rodape: pedido.observacoes ? String(pedido.observacoes).slice(0, 200) : null,
  };
  try {
    await enviarParaImpressora(comanda, config);
  } catch (err) {
    registrar({ botOrderId, comanda, status: 'falhou', erro: String(err.message).slice(0, 300) });
    return { ok: false, error: err.message, falhou: true };
  }
  registrar({ botOrderId, comanda, status: 'impresso' });
  return { ok: true, totalItens: itens.length };
}

/** Reimprime exatamente o que saiu (ou falhou) numa impressão anterior. */
async function reimprimir({ id }) {
  const config = getConfig();
  if (!config.ativa) return { ok: false, error: 'A impressora da cozinha está desligada.' };
  const db = getDb();
  const row = db.prepare('SELECT * FROM cozinha_impressoes WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Impressão não encontrada.' };
  let comanda;
  try { comanda = JSON.parse(row.conteudo_json); } catch { return { ok: false, error: 'Conteúdo da impressão ilegível.' }; }
  try {
    await enviarParaImpressora({ ...comanda, titulo: `${comanda.titulo}`, rodape: [comanda.rodape, '(reimpressão)'].filter(Boolean).join(' · ') }, config);
  } catch (err) {
    db.prepare('UPDATE cozinha_impressoes SET tentativas = tentativas + 1, erro = ? WHERE id = ?').run(String(err.message).slice(0, 300), id);
    return { ok: false, error: err.message };
  }
  db.transaction(() => {
    db.prepare(`UPDATE cozinha_impressoes SET status = 'impresso', erro = NULL, tentativas = tentativas + 1, impresso_em = NOW_SYNCED() WHERE id = ?`).run(id);
    // Falha de uma comanda de mesa: os itens não tinham sido marcados.
    if (row.status === 'falhou' && row.item_ids_json) {
      const marcar = db.prepare('UPDATE sale_items SET enviado_cozinha = 1 WHERE id = ?');
      for (const itemId of JSON.parse(row.item_ids_json)) marcar.run(itemId);
    }
  })();
  return { ok: true };
}

/** Página de teste da impressora da cozinha (com acentos, pra conferir a tabela). */
async function imprimirTeste() {
  const config = getConfig();
  if (config.tipo === 'rede' && !require('./escposService').enderecoValido(config.ip)) return { ok: false, error: 'Salve o IP da impressora antes de testar.' };
  try {
    await enviarParaImpressora({
      titulo: 'TESTE COZINHA', subtitulo: 'GerenciaAI', hora: horaLocal(),
      itens: [{ quantidade: 2, nome: 'Pão de queijo', observacao: 'Ação, coração, maçã: acentos OK?' }, { quantidade: 1, nome: 'Suco de laranja', pessoa: 'João' }],
    }, { ...config, copias: 1 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function listarUltimas({ limite = 30 } = {}) {
  return getDb().prepare(
    `SELECT id, sale_id, bot_order_id, titulo, status, erro, tentativas, criado_em, impresso_em, conteudo_json
     FROM cozinha_impressoes ORDER BY criado_em DESC, rowid DESC LIMIT ?`
  ).all(Math.min(100, Math.max(1, Number(limite) || 30))).map((r) => {
    let itens = 0;
    try { itens = (JSON.parse(r.conteudo_json).itens || []).length; } catch { itens = 0; }
    const { conteudo_json: _c, ...resto } = r;
    return { ...resto, itens };
  });
}

// ---------- automático ----------

/** Comandas de MESA com item novo da cozinha parado há alguns segundos. */
function comandasComItensNovos(config = getConfig()) {
  const limite = require('./timeService').utcSqlAtras({ minutos: ESPERA_AGRUPAR_MS / 60000 });
  const linhas = getDb().prepare(
    `SELECT si.sale_id, MAX(si.criado_em) AS ultimo, GROUP_CONCAT(COALESCE(p.categoria, ''), char(31)) AS cats
     FROM sale_items si
     JOIN sales s ON s.id = si.sale_id AND s.status = 'aberta'
     JOIN restaurant_tables rt ON rt.sale_id = s.id AND rt.unida_a_mesa_id IS NULL
     JOIN products p ON p.id = si.product_id
     WHERE si.cancelado = 0 AND si.enviado_cozinha = 0
     GROUP BY si.sale_id`
  ).all();
  return linhas
    .filter((l) => l.ultimo <= limite)
    .filter((l) => String(l.cats || '').split(String.fromCharCode(31)).some((c) => vaiPraCozinha(c, config.categorias)))
    .map((l) => l.sale_id);
}

let rodando = false;
async function cicloAutomatico() {
  if (rodando) return;
  rodando = true;
  try {
    const config = getConfig();
    if (!config.ativa || !config.automatica) return;
    for (const saleId of comandasComItensNovos(config)) {
      const falhou = ultimaFalhaVenda.get(saleId);
      if (falhou && Date.now() - falhou < ESPERA_APOS_FALHA_MS) continue;
      const r = await imprimirItensDaVenda({ saleId });
      if (!r.ok && r.falhou) avisarFalha(r.error);
    }
  } catch (err) {
    console.error('[cozinha] ciclo automático:', err?.message || err);
  } finally {
    rodando = false;
  }
}

let ultimoAviso = 0;
function avisarFalha(mensagem) {
  if (Date.now() - ultimoAviso < 60000) return;
  ultimoAviso = Date.now();
  try {
    const { Notification } = require('electron');
    if (Notification?.isSupported()) new Notification({ title: 'Impressora da cozinha', body: String(mensagem).slice(0, 200) }).show();
  } catch { /* aviso é extra */ }
}

let intervalo = null;
function iniciar() {
  if (intervalo) clearInterval(intervalo);
  intervalo = setInterval(() => { cicloAutomatico().catch(() => {}); }, 3000);
}

module.exports = {
  getConfig, saveConfig, listarCategorias, imprimirItensDaVenda, imprimirPedido, reimprimir, imprimirTeste, listarUltimas,
  montarComandaHtml, vaiPraCozinha, comandasComItensNovos, cicloAutomatico, iniciar, _definirImpressorasParaTeste,
};
