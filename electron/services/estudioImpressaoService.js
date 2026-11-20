// Estúdio de impressão: guarda a aparência da nota e da pré-nota, monta a
// prévia (com venda de exemplo) e os dados da pré-nota de uma conta aberta.
// O desenho em si fica em impressaoLayout.js (função pura, testada).

const QRCode = require('qrcode');
const { getDb } = require('../db/database');
const layout = require('./impressaoLayout');

function getConfig(tipo) {
  if (!layout.TIPOS.includes(tipo)) return layout.normalizarConfig('nota', {});
  let salvo = null;
  try {
    const linha = getDb().prepare('SELECT config_json FROM impressao_estudio WHERE tipo = ?').get(tipo);
    salvo = linha ? JSON.parse(linha.config_json) : null;
  } catch { salvo = null; }
  return layout.normalizarConfig(tipo, salvo || {});
}

function getTudo() {
  const db = getDb();
  const recibo = db.prepare("SELECT largura_mm, rodape_texto FROM receipt_config WHERE id = 'default'").get() || {};
  return {
    ok: true,
    nota: getConfig('nota'),
    prenota: getConfig('prenota'),
    cozinha: getConfig('cozinha'),
    qrmesa: getConfig('qrmesa'),
    padrao: layout.PADRAO,
    // Largura da comanda: a da impressora da cozinha (Configurações -> Cozinha).
    larguraCozinha: (() => { try { return require('./cozinhaService').getConfig().larguraMm; } catch { return 80; } })(),
    larguraMm: recibo.largura_mm || 80,
    rodapeNota: recibo.rodape_texto || '',
    pixConfigurado: !!db.prepare("SELECT pix_chave FROM payment_config WHERE id = 'default'").get()?.pix_chave,
  };
}

/** Salva a aparência de um tipo (e, para a nota, o rodapé que fica em receipt_config). */
function salvar({ tipo, config, rodapeNota }) {
  if (!layout.TIPOS.includes(tipo)) return { ok: false, error: 'Tipo de impressão inválido.' };
  const entrada = config && typeof config === 'object' ? config : {};
  if (entrada.logo && !layout.normalizarConfig(tipo, { logo: entrada.logo }).logo) {
    return { ok: false, error: 'Logo inválida: use uma imagem PNG ou JPG de até 300 KB.' };
  }
  const c = layout.normalizarConfig(tipo, entrada);
  const db = getDb();
  db.prepare(`
    INSERT INTO impressao_estudio (tipo, config_json) VALUES (?, ?)
    ON CONFLICT(tipo) DO UPDATE SET config_json = excluded.config_json, atualizado_em = NOW_SYNCED()`)
    .run(tipo, JSON.stringify(c));
  if (tipo === 'nota' && typeof rodapeNota === 'string') {
    db.prepare("UPDATE receipt_config SET rodape_texto = ? WHERE id = 'default'").run(rodapeNota.slice(0, 300) || null);
  }
  return { ok: true, config: c };
}

function restaurarPadrao({ tipo }) {
  if (!layout.TIPOS.includes(tipo)) return { ok: false, error: 'Tipo de impressão inválido.' };
  getDb().prepare('DELETE FROM impressao_estudio WHERE tipo = ?').run(tipo);
  return { ok: true, config: getConfig(tipo) };
}

/** QR do Pix com o valor (null se não há chave Pix ou valor). */
async function pixDoValor(valor, txid) {
  if (!(valor > 0)) return null;
  try {
    const r = require('./pixService').buildPixPayload({ valor: Math.round(valor * 100) / 100, txid });
    if (!r.ok) return null;
    return { copiaCola: r.payload, qrDataUrl: await QRCode.toDataURL(r.payload, { width: 260, margin: 1 }) };
  } catch (err) {
    console.error('[estudioImpressao] não gerei o QR do Pix:', err.message);
    return null;
  }
}

function lojaAtual(db, locationId) {
  return (locationId && db.prepare('SELECT * FROM locations WHERE id = ?').get(locationId))
    || db.prepare('SELECT * FROM locations LIMIT 1').get() || { nome: '' };
}

/** Prévia do estúdio com venda de exemplo e a configuração que está na tela. */
async function previa({ tipo, config, larguraMm, rodapeNota }) {
  if (!layout.TIPOS.includes(tipo)) return { ok: false, error: 'Tipo de impressão inválido.' };
  const db = getDb();
  const recibo = db.prepare("SELECT largura_mm, rodape_texto FROM receipt_config WHERE id = 'default'").get() || {};
  const largura = [58, 80, 210].includes(Number(larguraMm)) ? Number(larguraMm) : (recibo.largura_mm || 80);
  const dados = layout.exemplo(tipo, {
    larguraMm: largura, loja: lojaAtual(db), rodapeNota: typeof rodapeNota === 'string' ? rodapeNota : (recibo.rodape_texto || ''),
  });
  const c = layout.normalizarConfig(tipo, config || {});
  if (tipo === 'qrmesa') {
    // Mesas de verdade (até uma folha) com QR de exemplo: a prévia não grava token nenhum.
    const QRCode = require('qrcode');
    const porFolha = c.papel === 'termica' || c.papel === 'a6' ? 1 : Number(c.porFolha) || 6;
    let mesas = [];
    try { mesas = db.prepare('SELECT numero, nome FROM restaurant_tables ORDER BY CAST(numero AS INTEGER), numero LIMIT ?').all(porFolha); } catch { mesas = []; }
    if (!mesas.length) mesas = Array.from({ length: porFolha }, (_, i) => ({ numero: String(i + 1).padStart(2, '0'), nome: null }));
    const qr = await QRCode.toDataURL('https://gerenciaai-garcom.web.app/loja.html?s=exemplo&m=EXEMPLOEXEMPLOEXEMPLO000', { margin: 1, width: 240 });
    const html = layout.montarCartoesQr(c, { loja: lojaAtual(db), mesas: mesas.map((m) => ({ rotulo: m.nome || `Mesa ${m.numero}`, qrDataUrl: qr })) });
    // Na tela a folha inteira não cabe: a prévia mostra reduzida (a impressão não muda).
    return { ok: true, html: html.replace('</style>', 'body { zoom: .62; }</style>') };
  }
  if (tipo === 'cozinha') {
    const lc = [58, 80].includes(Number(larguraMm)) ? Number(larguraMm) : (() => { try { return require('./cozinhaService').getConfig().larguraMm; } catch { return 80; } })();
    return { ok: true, html: layout.montarComandaCozinha(c, layout.exemploComanda(), { larguraMm: lc }) };
  }
  if (tipo === 'nota') return { ok: true, html: layout.montarNota(c, dados) };
  if (c.pixQr) {
    dados.pix = await pixDoValor(layout.valoresDaPreNota(dados).falta, 'PRENOTA');
  }
  return { ok: true, html: layout.montarPreNota(c, dados) };
}

/** Dados da conta aberta (balcão ou mesa) para a pré-nota. */
function dadosDaConta(saleId) {
  const db = getDb();
  const venda = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!venda) return { ok: false, error: 'Conta não encontrada.' };
  if (venda.status !== 'aberta') return { ok: false, error: 'Esta conta já foi fechada. Para a venda finalizada, imprima a nota.' };
  const itens = db.prepare(`
    SELECT si.quantidade, si.preco_unitario, si.observacao, si.pessoa_numero, COALESCE(si.nome_personalizado, p.nome) AS nome
    FROM sale_items si JOIN products p ON p.id = si.product_id
    WHERE si.sale_id = ? AND si.cancelado = 0 ORDER BY si.criado_em`).all(saleId)
    .map((i) => ({ nome: i.nome, quantidade: i.quantidade, precoUnitario: i.preco_unitario, observacao: i.observacao || '', pessoaNumero: i.pessoa_numero || null }));
  if (!itens.length) return { ok: false, error: 'A conta ainda não tem itens.' };

  // Mesmas pessoas (vagas 1..N) que a tela da mesa mostra.
  const pessoas = require('./tableService').getTableCart(saleId).pessoas.map((p) => ({ numero: p.numero, nome: p.nome }));
  const pagoPorPessoa = {};
  for (const r of db.prepare(`
    SELECT spp.pessoa_numero AS n, SUM(p.valor) AS v FROM sale_person_payments spp
    JOIN payments p ON p.id = spp.payment_id WHERE spp.sale_id = ? GROUP BY spp.pessoa_numero`).all(saleId)) pagoPorPessoa[r.n] = r.v;
  const totalPago = db.prepare('SELECT COALESCE(SUM(valor), 0) AS t FROM payments WHERE sale_id = ?').get(saleId).t;

  const mesa = db.prepare('SELECT * FROM restaurant_tables WHERE sale_id = ? AND unida_a_mesa_id IS NULL').get(saleId);
  let mesaRotulo = null;
  if (mesa) {
    const unidas = db.prepare('SELECT numero, nome FROM restaurant_tables WHERE unida_a_mesa_id = ? ORDER BY numero').all(mesa.id);
    mesaRotulo = [mesa, ...unidas].map((m) => m.nome || `Mesa ${m.numero}`).join(' + ');
  }
  const operador = db.prepare('SELECT nome FROM users WHERE id = ?').get(venda.operador_id)?.nome || '';
  const cliente = venda.customer_id ? db.prepare('SELECT nome FROM customers WHERE id = ?').get(venda.customer_id)?.nome || '' : '';

  return {
    ok: true,
    dados: {
      venda, itens, pessoas, pagoPorPessoa, totalPago,
      desconto: (venda.desconto || 0) + (venda.desconto_gerente || 0),
      taxaServicoPercentual: venda.taxa_servico_percentual || 0,
      loja: lojaAtual(db, venda.location_id), operador, cliente, mesa: mesaRotulo,
      qtdPessoasMesa: Math.max(mesa?.pessoas || 0, pessoas.length),
      agoraUtc: new Date().toISOString().slice(0, 19).replace('T', ' '),
    },
  };
}

/** HTML da pré-nota da conta (inteira ou só a parte de uma pessoa). */
async function htmlDaPreNota({ saleId, pessoaNumero }) {
  const r = dadosDaConta(saleId);
  if (!r.ok) return r;
  const d = r.dados;
  const db = getDb();
  d.larguraMm = db.prepare("SELECT largura_mm FROM receipt_config WHERE id = 'default'").get()?.largura_mm || 80;
  const n = Number(pessoaNumero);
  if (Number.isInteger(n) && n > 0) {
    if (!d.itens.some((i) => i.pessoaNumero === n)) return { ok: false, error: 'Essa pessoa ainda não tem itens na conta.' };
    d.pessoaNumero = n;
  }
  const c = getConfig('prenota');
  if (c.pixQr) {
    // Pix do que falta pagar (da conta inteira ou da pessoa), o mesmo valor impresso.
    const { falta } = layout.valoresDaPreNota(d);
    d.pix = await pixDoValor(falta, `PRE${String(saleId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}`);
  }
  return { ok: true, html: layout.montarPreNota(c, d), larguraMm: d.larguraMm };
}

module.exports = { getConfig, getTudo, salvar, restaurarPadrao, previa, dadosDaConta, htmlDaPreNota };
