const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Gestão de produtos pelo PDV móvel -- celular vinculado a GERENTE,
 * ADMINISTRADOR ou SUPORTE (o mesmo grupo que no computador mexe em
 * Produtos e em estoque: PAPEIS_GESTAO de ipc/handlers.js) pode:
 *   'detalhe'      ver preço, custo, margem e estoque de um produto
 *   'preco'        alterar o preço de venda
 *   'estoque'      entrada, perda ou correção por contagem
 *   'produto_novo' cadastrar um produto (ex: bipou e não achou)
 *
 * Mesmo pedido/resposta das consultas (pdvMobileConsultaService.js), numa
 * coleção separada porque aqui MUDA dado:
 *
 *   celular cria  installations/{installId}/gestao_pdv/{id}
 *                 { dispositivoUid, tipo, ..., status: 'novo' }
 *   computador responde no mesmo doc { status: 'respondida', resultado }
 *                 ou { status: 'erro', erro }
 *
 * Quem decide é sempre este computador, com o papel ATUAL do usuário
 * vinculado ao celular (não o que o celular diz, nem a lista publicada em
 * config_mobile/pdv.gestaoLiberadaPara -- essa lista é só a segunda trava,
 * conferida pela regra do Firestore). Toda mudança passa pelos mesmos
 * serviços da tela do computador (productService.upsert, stockService.adjustStock),
 * em nome do usuário vinculado, e fica na Auditoria.
 *
 * Cada mudança vale UMA vez: o resultado fica em `mobile_gestao_pedidos`
 * (id = id do documento) dentro da mesma transação da mudança. Se a
 * resposta não chegar no celular (rede), o próximo aviso do mesmo
 * documento devolve o resultado guardado em vez de aplicar de novo.
 * Pedido com mais de 10 min é recusado: o celular já desistiu de esperar
 * e avisou a pessoa (ver pwa-mobile/pdv-servidor.js, pedirGestao).
 */

const PAPEIS_GESTAO = ['gerente', 'admin', 'suporte'];
const TIPOS = ['detalhe', 'preco', 'estoque', 'produto_novo'];
const TIPOS_QUE_MUDAM = ['preco', 'estoque', 'produto_novo'];
const VALIDADE_PEDIDO_MS = 10 * 60 * 1000;
const PRECO_MAXIMO = 1000000;
const QUANTIDADE_MAXIMA = 1000000;
const UNIDADES = ['un', 'kg', 'g', 'l', 'ml', 'm', 'cx', 'pct', 'dz', 'par'];
const MOVIMENTOS = {
  entrada: { tipo: 'entrada', rotulo: 'Entrada' },
  perda: { tipo: 'perda', rotulo: 'Perda' },
  contagem: { tipo: 'ajuste', rotulo: 'Correção por contagem' },
};

class ErroGestao extends Error {}

function arred2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}
function arred3(v) {
  return Math.round((Number(v) + Number.EPSILON) * 1000) / 1000;
}

function locationIdAtual() {
  const location = getDb().prepare('SELECT id FROM locations LIMIT 1').get();
  if (!location) throw new ErroGestao('Nenhum local cadastrado neste computador.');
  return location.id;
}

function texto(valor, max) {
  return String(valor ?? '').trim().slice(0, max);
}

function numero(valor, { campo, min = 0, max }) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < min || n > max) throw new ErroGestao(`${campo} inválido.`);
  return n;
}

/**
 * Celular PDV ativo + usuário vinculado ativo e de gestão + opção ligada
 * nesta loja. Devolve { dispositivo, usuario } ou lança ErroGestao.
 */
function autorizar(uid) {
  const dispositivo = require('./pdvMobileSyncService').buscarDispositivoPdv(uid);
  if (!dispositivo) throw new ErroGestao('Celular não reconhecido ou desconectado desta loja.');
  if (dispositivo.vinculo_ativo !== 1) throw new ErroGestao('O usuário vinculado a este celular está desativado.');
  if (!PAPEIS_GESTAO.includes(dispositivo.vinculo_role)) {
    throw new ErroGestao('Só o celular de um gerente ou administrador pode mexer em produtos.');
  }
  if (require('./pdvMobileConfigService').getConfig().gestaoProdutos !== 'gestao') {
    throw new ErroGestao('Mexer em produtos pelo celular está desligado nesta loja (Configurações → Celular).');
  }
  return { dispositivo, usuario: { id: dispositivo.vinculo_user_id, nome: dispositivo.vinculo_nome, role: dispositivo.vinculo_role } };
}

function produtoAtivo(produtoId) {
  const id = texto(produtoId, 80);
  const p = id ? getDb().prepare('SELECT * FROM products WHERE id = ? AND ativo = 1').get(id) : null;
  if (!p) throw new ErroGestao('Produto não encontrado (pode ter sido excluído no computador).');
  return p;
}

/** O que o celular de gestão vê de um produto. Custo e margem só saem
 * por aqui -- nunca no catálogo publicado em status_ao_vivo, que todo
 * celular da loja lê. */
function detalheDoProduto(produtoId) {
  const db = getDb();
  const productService = require('./productService');
  const p = produtoAtivo(produtoId);
  const ehServico = p.tipo === 'servico';
  const precoVenda = productService.precoEfetivo(p);
  const custo = Number(p.custo) || 0;
  const ultima = db.prepare(
    `SELECT h.preco_antigo, h.preco_novo, h.criado_em, u.nome as operador_nome FROM product_price_history h
     LEFT JOIN users u ON u.id = h.operador_id WHERE h.product_id = ? ORDER BY h.criado_em DESC LIMIT 1`
  ).get(p.id);
  return {
    id: p.id,
    nome: p.nome,
    categoria: p.categoria || null,
    unidade: p.unidade || 'un',
    tipo: p.tipo || 'produto',
    codigoBarras: p.codigo_barras || null,
    preco: Number(p.preco) || 0,
    precoVenda,
    emPromocao: precoVenda !== (Number(p.preco) || 0),
    promocaoValidaAte: precoVenda !== (Number(p.preco) || 0) ? p.promocao_valida_ate : null,
    custo,
    margem: custo > 0 && precoVenda > 0 ? Number((((precoVenda - custo) / precoVenda) * 100).toFixed(1)) : null,
    estoque: ehServico ? null : require('./stockService').getCurrentStock(p.id, locationIdAtual()),
    estoqueMinimo: Number(p.estoque_minimo) || 0,
    ultimaAlteracaoPreco: ultima
      ? { de: ultima.preco_antigo, para: ultima.preco_novo, em: ultima.criado_em, por: ultima.operador_nome || null }
      : null,
  };
}

/** Linha do banco -> formato de productService.upsert, sem perder nenhum
 * campo (o upsert regrava a linha inteira). */
function paraUpsert(p) {
  let customFields = {};
  try { customFields = JSON.parse(p.custom_fields || '{}') || {}; } catch { customFields = {}; }
  return {
    id: p.id, sku: p.sku, codigoBarras: p.codigo_barras, nome: p.nome, categoria: p.categoria, preco: p.preco,
    custo: p.custo, unidade: p.unidade, estoqueMinimo: p.estoque_minimo, ncm: p.ncm, cest: p.cest, cfop: p.cfop,
    cstCsosn: p.cst_csosn, origemMercadoria: p.origem_mercadoria, customFields, codigoBalanca: p.codigo_balanca,
    tipo: p.tipo, fornecedorId: p.fornecedor_id,
  };
}

function auditar(usuario, dispositivo, tipoEvento, motivo) {
  const celular = dispositivo.nome_dispositivo || 'celular';
  require('./authService').registrarEventoAuditoria({
    tipoEvento, solicitanteId: usuario.id, motivo: `${motivo} (pelo celular "${celular}")`,
  });
}

function alterarPreco(dados, { usuario, dispositivo }) {
  const p = produtoAtivo(dados.produtoId);
  const precoNovo = arred2(numero(dados.preco, { campo: 'Preço', max: PRECO_MAXIMO }));
  if (precoNovo <= 0) throw new ErroGestao('O preço precisa ser maior que zero.');
  // O celular manda o preço que estava vendo. Se alguém mudou no
  // computador (ou em outro celular) nesse meio tempo, não passa por cima
  // sem a pessoa ver o valor novo.
  if (dados.precoAnterior != null && Math.abs(arred2(dados.precoAnterior) - arred2(p.preco)) > 0.004) {
    throw new ErroGestao(`O preço deste produto mudou para R$ ${arred2(p.preco).toFixed(2).replace('.', ',')} enquanto você editava. Confira e tente de novo.`);
  }
  if (Math.abs(precoNovo - arred2(p.preco)) < 0.005) throw new ErroGestao('O preço novo é igual ao atual.');

  const r = require('./productService').upsert({ ...paraUpsert(p), preco: precoNovo, operadorId: usuario.id });
  if (!r.ok) throw new ErroGestao(r.error);
  const fmt = (v) => `R$ ${arred2(v).toFixed(2).replace('.', ',')}`;
  auditar(usuario, dispositivo, 'preco_alterado_celular', `Preço de "${p.nome}": ${fmt(p.preco)} → ${fmt(precoNovo)}`);
  return { mensagem: `Preço de ${p.nome} agora é ${fmt(precoNovo)}.`, produto: detalheDoProduto(p.id) };
}

function ajustarEstoque(dados, { usuario, dispositivo }) {
  const p = produtoAtivo(dados.produtoId);
  if (p.tipo === 'servico') throw new ErroGestao('Serviço não tem estoque.');
  const mov = MOVIMENTOS[dados.movimento];
  if (!mov) throw new ErroGestao('Tipo de ajuste inválido.');
  const motivo = texto(dados.motivo, 120);
  if (!motivo) throw new ErroGestao('Informe o motivo do ajuste.');
  const quantidade = arred3(numero(dados.quantidade, { campo: 'Quantidade', max: QUANTIDADE_MAXIMA }));
  const locationId = locationIdAtual();
  const atual = require('./stockService').getCurrentStock(p.id, locationId);

  let variacao;
  if (dados.movimento === 'contagem') {
    // Contagem = "contei X agora". A diferença é calculada AQUI, com o
    // estoque do momento em que o pedido chega -- uma venda feita enquanto
    // a pessoa digitava não vira estoque fantasma.
    variacao = arred3(quantidade - atual);
    if (Math.abs(variacao) < 0.0005) throw new ErroGestao(`O estoque já está em ${quantidade} — nada a corrigir.`);
  } else {
    if (quantidade <= 0) throw new ErroGestao('Informe uma quantidade maior que zero.');
    variacao = dados.movimento === 'perda' ? -quantidade : quantidade;
  }

  const textoMotivo = dados.movimento === 'contagem' ? `Contagem pelo celular: ${quantidade} (antes ${atual}). ${motivo}` : `${motivo} (celular)`;
  const r = require('./stockService').adjustStock({
    productId: p.id, locationId, quantidade: variacao, tipo: mov.tipo, motivo: textoMotivo.slice(0, 200),
    operadorId: usuario.id, deviceId: dispositivo.id,
  });
  if (!r.ok) throw new ErroGestao(r.error);
  const sinal = variacao > 0 ? '+' : '';
  auditar(usuario, dispositivo, 'estoque_ajustado_celular', `${mov.rotulo} em "${p.nome}": ${sinal}${variacao} (${atual} → ${arred3(r.estoqueAtual)}). ${motivo}`);
  return { mensagem: `Estoque de ${p.nome}: ${arred3(r.estoqueAtual)} ${p.unidade || 'un'}.`, produto: detalheDoProduto(p.id) };
}

function cadastrarProduto(dados, { usuario, dispositivo }) {
  const nome = texto(dados.nome, 120);
  if (nome.length < 2) throw new ErroGestao('Informe o nome do produto.');
  const preco = arred2(numero(dados.preco, { campo: 'Preço', max: PRECO_MAXIMO }));
  if (preco <= 0) throw new ErroGestao('O preço precisa ser maior que zero.');
  const custo = dados.custo == null || dados.custo === '' ? 0 : arred2(numero(dados.custo, { campo: 'Custo', max: PRECO_MAXIMO }));
  const unidade = UNIDADES.includes(dados.unidade) ? dados.unidade : 'un';
  const codigoBarras = texto(dados.codigoBarras, 60).replace(/\s/g, '') || null;
  const estoqueInicial = dados.estoqueInicial == null || dados.estoqueInicial === ''
    ? 0 : arred3(numero(dados.estoqueInicial, { campo: 'Estoque inicial', max: QUANTIDADE_MAXIMA }));

  const productService = require('./productService');
  const r = productService.upsert({
    nome, preco, custo, unidade, codigoBarras, categoria: texto(dados.categoria, 60) || null, operadorId: usuario.id,
  });
  if (!r.ok) throw new ErroGestao(r.error);
  if (estoqueInicial > 0) {
    const e = require('./stockService').adjustStock({
      productId: r.id, locationId: locationIdAtual(), quantidade: estoqueInicial, tipo: 'entrada',
      motivo: 'Cadastro inicial pelo celular', operadorId: usuario.id, deviceId: dispositivo.id,
    });
    if (!e.ok) throw new ErroGestao(e.error);
  }
  auditar(usuario, dispositivo, 'produto_cadastrado_celular',
    `Produto "${nome}" cadastrado: R$ ${preco.toFixed(2).replace('.', ',')}${codigoBarras ? `, código ${codigoBarras}` : ''}${estoqueInicial ? `, estoque inicial ${estoqueInicial}` : ''}`);
  return { mensagem: `${nome} cadastrado.`, produto: detalheDoProduto(r.id) };
}

const ACOES = { preco: alterarPreco, estoque: ajustarEstoque, produto_novo: cadastrarProduto };

/**
 * Executa um pedido já lido do Firestore. Não toca rede -- exportada pra
 * teste. Devolve { resultado } ou { erro }.
 */
function executarPedido(pedidoId, dados, { agoraMs = require('./timeService').nowMs() } = {}) {
  if (!TIPOS.includes(dados?.tipo)) return { erro: 'Tipo de pedido desconhecido.' };
  const db = getDb();

  if (TIPOS_QUE_MUDAM.includes(dados.tipo)) {
    const feito = db.prepare('SELECT ok, resultado, erro FROM mobile_gestao_pedidos WHERE id = ?').get(pedidoId);
    if (feito) return feito.ok ? { resultado: JSON.parse(feito.resultado) } : { erro: feito.erro };
  }

  let ctx;
  try {
    ctx = autorizar(dados.dispositivoUid);
  } catch (err) {
    if (err instanceof ErroGestao) return { erro: err.message };
    throw err;
  }

  if (dados.tipo === 'detalhe') {
    try {
      return { resultado: detalheDoProduto(dados.produtoId) };
    } catch (err) {
      if (err instanceof ErroGestao) return { erro: err.message };
      throw err;
    }
  }

  const criadoMs = typeof dados.criadoEm?.toMillis === 'function' ? dados.criadoEm.toMillis() : null;
  const expirado = criadoMs != null && agoraMs - criadoMs > VALIDADE_PEDIDO_MS;

  // Mudança + registro do resultado na mesma transação: ou as duas coisas
  // acontecem, ou nenhuma. Erro de validação também fica registrado (o
  // mesmo pedido nunca é reavaliado depois com outro resultado).
  const aplicar = db.transaction(() => {
    let saida;
    try {
      if (expirado) throw new ErroGestao('Este pedido chegou depois de 10 minutos e foi descartado. Confira o produto e faça de novo, se ainda precisar.');
      saida = { resultado: ACOES[dados.tipo](dados, ctx) };
    } catch (err) {
      if (!(err instanceof ErroGestao)) throw err;
      saida = { erro: err.message };
    }
    db.prepare(
      `INSERT INTO mobile_gestao_pedidos (id, device_id, usuario_id, tipo, ok, resultado, erro) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(pedidoId, ctx.dispositivo.id, ctx.usuario.id, dados.tipo, saida.erro ? 0 : 1,
      saida.erro ? null : JSON.stringify(saida.resultado), saida.erro || null);
    return saida;
  });
  return aplicar();
}

async function processarPedido(docSnap, { firestore, installId }) {
  const dados = docSnap.data();
  if (dados.status !== 'novo') return;
  const { doc, updateDoc, serverTimestamp } = require('firebase/firestore');
  const ref = doc(firestore, 'installations', installId, 'gestao_pdv', docSnap.id);

  let resposta;
  try {
    resposta = executarPedido(docSnap.id, dados);
  } catch (err) {
    console.error('[pdvMobileGestaoService] falha ao processar pedido:', err);
    resposta = { erro: 'Erro no computador da loja ao fazer a alteração. Nada foi mudado.' };
  }

  await updateDoc(ref, resposta.erro
    ? { status: 'erro', erro: resposta.erro, respondidoEm: serverTimestamp() }
    : { status: 'respondida', resultado: resposta.resultado ?? null, respondidoEm: serverTimestamp() }
  ).catch((err) => console.error('[pdvMobileGestaoService] não consegui responder o pedido:', err.message));
}

/** Pedidos são descartáveis no Firestore (o registro de verdade fica na
 * Auditoria e em mobile_gestao_pedidos) -- apaga os com mais de 1 h. */
async function limparPedidosAntigos({ firestore, installId }) {
  const { collection, query, where, getDocs, deleteDoc, limit, Timestamp } = require('firebase/firestore');
  const corte = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
  const snap = await getDocs(query(
    collection(firestore, 'installations', installId, 'gestao_pdv'), where('criadoEm', '<', corte), limit(200)
  ));
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
}

// Uma mudança por vez, na ordem de chegada (duas contagens do mesmo
// produto chegando juntas não podem ler o mesmo "estoque atual").
let fila = Promise.resolve();
function enfileirar(tarefa) {
  fila = fila.then(tarefa).catch((err) => console.error('[pdvMobileGestaoService] tarefa falhou:', err));
  return fila;
}

let pararEscuta = null;
let intervaloLimpeza = null;

function iniciarEscutaGestao() {
  try {
    if (pararEscuta) { pararEscuta(); pararEscuta = null; }
    const licenseService = require('./licenseService');
    const pdvRegistryService = require('./pdvRegistryService');
    const { collection, query, where, onSnapshot } = require('firebase/firestore');
    const firestore = licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();

    pararEscuta = onSnapshot(
      query(collection(firestore, 'installations', installId, 'gestao_pdv'), where('status', '==', 'novo')),
      (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'removed') return;
          const docSnap = change.doc;
          enfileirar(() => processarPedido(docSnap, { firestore, installId }));
        });
      },
      (err) => console.error('[pdvMobileGestaoService] escuta de pedidos falhou:', err)
    );

    if (intervaloLimpeza) clearInterval(intervaloLimpeza);
    intervaloLimpeza = setInterval(() => { limparPedidosAntigos({ firestore, installId }).catch(() => {}); }, 30 * 60 * 1000);
  } catch (err) {
    console.error('[pdvMobileGestaoService] não foi possível iniciar a escuta:', err);
  }
}

module.exports = {
  PAPEIS_GESTAO, TIPOS, VALIDADE_PEDIDO_MS, UNIDADES,
  iniciarEscutaGestao, executarPedido, detalheDoProduto,
};
