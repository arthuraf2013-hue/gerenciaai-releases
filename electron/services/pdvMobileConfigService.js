const { getDb } = require('../db/database');

/**
 * Configuração do PDV móvel (celular pareado com tipo 'pdv') -- o que o
 * app do celular pode fazer nesta loja. Mora numa linha única de
 * `pdv_mobile_config` (ver schema.sql) e é publicada pro celular em
 * installations/{installId}/config_mobile/pdv (ver publicarConfig, chamada
 * ao salvar e pelo ciclo periódico de pdvMobileSyncService).
 *
 * O celular usa esse documento só pra MONTAR a tela (quais métodos de
 * pagamento mostrar, até quanto de desconto deixar digitar, se o caixa
 * está aberto). Quem decide de verdade é sempre o desktop, na hora de
 * processar a venda (pdvMobileSyncService.criarVendaLocal) -- um celular
 * com config velha em cache, ou adulterado, nunca passa por cima disto.
 */

// Subconjunto do CHECK de payments.metodo que faz sentido no celular
// ('outro' fica de fora: sem campo de descrição, viraria um buraco no
// fechamento de caixa).
const METODOS_PAGAMENTO_VALIDOS = ['dinheiro', 'cartao_credito', 'cartao_debito', 'pix', 'fiado'];
const PAPEIS_GESTAO = ['gerente', 'admin', 'suporte'];
// Quem vê o painel da loja (faturamento, histórico, mais vendidos, por
// operador) no app do PDV móvel -- igual à "Consulta remota".
const METRICAS_LOJA_VALIDAS = ['desligado', 'gestao', 'todos'];
// Alterar preço, ajustar estoque, cadastrar produto e ver custo/margem pelo
// celular (pdvMobileGestaoService.js) -- nunca 'todos': operador de caixa
// não mexe em produto nem no computador.
const GESTAO_PRODUTOS_VALIDAS = ['desligado', 'gestao'];

function getRow() {
  const db = getDb();
  let row = db.prepare('SELECT * FROM pdv_mobile_config WHERE id = ?').get('default');
  if (!row) {
    db.prepare(`INSERT INTO pdv_mobile_config (id) VALUES ('default')`).run();
    row = db.prepare('SELECT * FROM pdv_mobile_config WHERE id = ?').get('default');
  }
  return row;
}

function parseMetodos(json) {
  try {
    const lista = JSON.parse(json || '[]');
    return Array.isArray(lista) ? lista.filter((m) => METODOS_PAGAMENTO_VALIDOS.includes(m)) : [];
  } catch {
    return [];
  }
}

function getConfig() {
  const row = getRow();
  return {
    permitirVenda: row.permitir_venda === 1,
    permitirMesas: row.permitir_mesas === 1,
    permitirCliente: row.permitir_cliente === 1,
    metodosPagamento: parseMetodos(row.metodos_pagamento),
    descontoMaximoPercentual: Number(row.desconto_maximo_percentual) || 0,
    imprimirReciboNoComputador: row.imprimir_recibo_no_computador === 1,
    metricasLoja: METRICAS_LOJA_VALIDAS.includes(row.metricas_loja) ? row.metricas_loja : 'gestao',
    gestaoProdutos: GESTAO_PRODUTOS_VALIDAS.includes(row.gestao_produtos) ? row.gestao_produtos : 'gestao',
    atualizadoPorId: row.atualizado_por_id || null,
    atualizadoEm: row.atualizado_em || null,
  };
}

/** Só gerente/admin/suporte mudam o que o celular pode fazer (mesmo
 * critério das outras configurações de pareamento -- ver
 * pairingService.requireGerenteOuAdmin). */
function saveConfig({
  permitirVenda, permitirMesas, permitirCliente, metodosPagamento, descontoMaximoPercentual,
  imprimirReciboNoComputador, metricasLoja, gestaoProdutos, requestingUserId,
}) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND ativo = 1').get(requestingUserId);
  if (!user || !PAPEIS_GESTAO.includes(user.role)) {
    return { ok: false, error: 'Apenas um gerente ou administrador pode alterar a configuração do PDV móvel.' };
  }

  const metodos = Array.isArray(metodosPagamento)
    ? [...new Set(metodosPagamento)].filter((m) => METODOS_PAGAMENTO_VALIDOS.includes(m))
    : [];
  if (permitirVenda && metodos.length === 0) {
    return { ok: false, error: 'Escolha pelo menos uma forma de pagamento pro celular (ou desligue a venda pelo celular).' };
  }
  const desconto = Number(descontoMaximoPercentual);
  if (!Number.isFinite(desconto) || desconto < 0 || desconto > 100) {
    return { ok: false, error: 'Desconto máximo precisa ser um percentual entre 0 e 100.' };
  }
  const metricas = metricasLoja === undefined ? getConfig().metricasLoja : metricasLoja;
  if (!METRICAS_LOJA_VALIDAS.includes(metricas)) {
    return { ok: false, error: 'Opção inválida para o painel da loja no celular.' };
  }
  const gestao = gestaoProdutos === undefined ? getConfig().gestaoProdutos : gestaoProdutos;
  if (!GESTAO_PRODUTOS_VALIDAS.includes(gestao)) {
    return { ok: false, error: 'Opção inválida para mexer em produtos pelo celular.' };
  }
  if (!permitirVenda && !permitirMesas) {
    return { ok: false, error: 'Deixe pelo menos uma função ligada (vender ou lançar pedido em mesa) -- senão o celular não tem o que fazer.' };
  }

  getRow(); // garante a linha 'default'
  db.prepare(
    `UPDATE pdv_mobile_config SET permitir_venda = ?, permitir_mesas = ?, permitir_cliente = ?, metodos_pagamento = ?,
       desconto_maximo_percentual = ?, imprimir_recibo_no_computador = ?, metricas_loja = ?, gestao_produtos = ?, atualizado_por_id = ?, atualizado_em = NOW_SYNCED()
     WHERE id = 'default'`
  ).run(
    permitirVenda ? 1 : 0, permitirMesas ? 1 : 0, permitirCliente ? 1 : 0, JSON.stringify(metodos),
    desconto, imprimirReciboNoComputador ? 1 : 0, metricas, gestao, requestingUserId,
  );

  // Best-effort: o ciclo periódico republica de qualquer jeito se isto
  // falhar por rede.
  publicarConfig().catch(() => {});
  return { ok: true, config: getConfig() };
}

/**
 * Celulares PDV móvel (uid do Firebase) que podem ver o painel da loja,
 * conforme `metricas_loja` e o papel ATUAL do usuário vinculado (mudou o
 * papel ou desconectou o celular aqui -> some da lista na próxima
 * publicação, ~25 s). Vai publicado em config_mobile/pdv e é o que a
 * regra do Firestore confere pra liberar historico_vendas -- quem decide
 * é este computador, não o celular.
 */
function dispositivosComMetricas() {
  const { metricasLoja } = getConfig();
  if (metricasLoja === 'desligado') return [];
  const linhas = getDb().prepare(
    `SELECT pd.id, u.role FROM paired_devices pd JOIN users u ON u.id = pd.vinculo_user_id
     WHERE pd.tipo = 'pdv' AND pd.ativo = 1 AND u.ativo = 1`,
  ).all();
  return linhas.filter((l) => metricasLoja === 'todos' || PAPEIS_GESTAO.includes(l.role)).map((l) => l.id).sort();
}

/**
 * Celulares PDV móvel (uid) que podem mexer em produtos: vinculados a
 * gerente/admin/suporte ativo, com a opção ligada. Mesma ideia de
 * dispositivosComMetricas -- vai em config_mobile/pdv.gestaoLiberadaPara,
 * que a regra de gestao_pdv confere; pdvMobileGestaoService confere de
 * novo, com o papel do momento, antes de mudar qualquer coisa.
 */
function dispositivosComGestao() {
  if (getConfig().gestaoProdutos !== 'gestao') return [];
  return getDb().prepare(
    `SELECT pd.id, u.role FROM paired_devices pd JOIN users u ON u.id = pd.vinculo_user_id
     WHERE pd.tipo = 'pdv' AND pd.ativo = 1 AND u.ativo = 1`,
  ).all().filter((l) => PAPEIS_GESTAO.includes(l.role)).map((l) => l.id).sort();
}

/** Documento publicado pro celular -- inclui o estado vivo que o celular
 * precisa pra não deixar o operador montar uma venda que vai ser
 * recusada de cara (caixa fechado, Pix sem chave configurada). */
function montarDocumentoPublico() {
  const db = getDb();
  const config = getConfig();
  const location = db.prepare('SELECT id FROM locations LIMIT 1').get();
  const caixaAberto = location ? !!require('./cashService').getOpenSession(location.id) : false;
  const security = require('./authService').getSecurityConfig();
  const pagamento = require('./pixService').getPaymentConfig();
  const profile = require('./profileService').getActiveProfile();

  return {
    permitirVenda: config.permitirVenda,
    permitirMesas: config.permitirMesas,
    permitirCliente: config.permitirCliente,
    metodosPagamento: config.metodosPagamento,
    descontoMaximoPercentual: config.descontoMaximoPercentual,
    exigeAutorizacaoDesconto: security?.exigir_autorizacao_desconto === 1,
    caixaAberto,
    pixConfigurado: !!pagamento?.pix_chave,
    nomeNegocio: require('./fiscalService').getNomeNegocio() || 'Sua loja',
    perfilAtivo: profile?.id || null,
    metricasLoja: config.metricasLoja,
    metricasLiberadasPara: dispositivosComMetricas(),
    gestaoProdutos: config.gestaoProdutos,
    gestaoLiberadaPara: dispositivosComGestao(),
  };
}

async function publicarConfig() {
  const licenseService = require('./licenseService');
  const pdvRegistryService = require('./pdvRegistryService');
  const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
  const firestore = licenseService.getLicenseFirestore();
  const installId = pdvRegistryService.getOrCreateDeviceUid();
  await setDoc(doc(firestore, 'installations', installId, 'config_mobile', 'pdv'), {
    ...montarDocumentoPublico(),
    // Também funciona como "sinal de vida" do servidor: o celular recusa
    // finalizar venda se isto estiver velho demais (computador da loja
    // desligado/sem internet), em vez de mandar uma venda que ninguém vai
    // processar.
    atualizadoEm: serverTimestamp(),
  });
}

module.exports = {
  METODOS_PAGAMENTO_VALIDOS, METRICAS_LOJA_VALIDAS, GESTAO_PRODUTOS_VALIDAS, getConfig, saveConfig, montarDocumentoPublico, publicarConfig,
  dispositivosComMetricas, dispositivosComGestao,
};
