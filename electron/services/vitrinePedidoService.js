const { getDb } = require('../db/database');

/**
 * PEDIDO PELA VITRINE / QR DA MESA, direto no sistema.
 *
 * Com "Receber os pedidos direto no sistema" ligado (Configurações →
 * Vitrine online), a página pública (pwa-mobile/loja.html) GRAVA o pedido em
 * installations/{id}/pedidos_vitrine em vez de abrir o WhatsApp. O cliente
 * informa o nome e escolhe:
 *   - retirada                    -> Separação; aceito, ganha SENHA;
 *   - consumir no local SEM mesa  -> igual (retira no balcão pela senha);
 *   - consumir no local PELO QR DA MESA -> pedido da mesa: aceito, entra na
 *     comanda da mesa, na PESSOA com o nome dele (botOrderService.lancarPedidoNaMesa);
 *   - entrega (se a loja oferece) -> Separação, como o pedido do WhatsApp.
 * Nada vai para a cozinha nem para a conta sem o ATENDENTE aceitar na
 * Separação (evita trote). Aceito, a comanda sai na impressora da cozinha.
 *
 * Esta máquina escuta a coleção (uma escuta só, também para a vitrine de
 * DEMONSTRAÇÃO -- vitrineDemoService), confere tudo de novo (endereço é o
 * desta loja, vitrine ligada, recebe pedidos, modo oferecido, mesa pelo
 * segredo do QR, produto ativo com preço) e cria o bot_orders com
 * `canal = 'vitrine'` (índice único canal+canal_ref: o mesmo pedido não entra
 * duas vezes). Preço é SEMPRE o do cadastro daqui.
 *
 * Acompanhamento: cada mudança do pedido (aceito, pronto, entregue, na
 * mesa, cancelado) vai para installations/{id}/pedidos_vitrine_status/{id do pedido}
 * -- a página mostra a senha e avisa quando está pronto.
 */

const CANAL = 'vitrine';
const TELEFONE_PEDIDO = 'vitrine'; // bot_orders.cliente_telefone é obrigatório
const LIMITE_ITENS_PEDIDO = 40;
const QTD_MAXIMA_ITEM = 99;
const LIMITE_NOVOS_NA_FILA = 60; // pedidos esperando o atendente, de todo o site
const LIMITE_NOVOS_POR_MESA = 6;
const FRACIONADAS = ['kg', 'l', 'm'];
const PAGAMENTOS = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão' };
// 'pix_online' = paga agora pelo Pix na própria página (vitrinePixService);
// 'mesa' = pedido pelo QR da mesa, paga na conta da mesa.
const PAGAMENTOS_ACEITOS = ['pix', 'dinheiro', 'cartao', 'pix_online', 'mesa'];
const SLUG_VALIDO = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

const estado = {
  pararEscuta: null, processando: new Set(), escutando: false,
  // Reconexão: a escuta do Firestore que dá erro (login vencido, permissão,
  // cota) MORRE e não volta sozinha. Antes o app só anotava no log e seguia
  // achando que escutava: os pedidos paravam de chegar até reiniciar.
  tentativas: 0, timerReconexao: null, ultimoErro: null, ultimaRespostaEm: null,
};
const ESPERA_RECONEXAO_MIN_MS = 15000;
const ESPERA_RECONEXAO_MAX_MS = 5 * 60 * 1000;
let nuvemDeTeste = null; // { firestore, installId, collection, query, where, onSnapshot } falsos nos testes
function _definirNuvemParaTeste(n) { nuvemDeTeste = n || null; }

const arred = (v, casas = 2) => { const f = 10 ** casas; return Math.round((Number(v) + Number.EPSILON) * f) / f; };
const moeda = (v) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;

/** Celular informado na página: só DDD + número (10 ou 11 dígitos), ou null. */
function telefoneValido(valor) {
  let d = String(valor ?? '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  return /^[1-9][0-9]{9,10}$/.test(d) ? d : null;
}

/**
 * Pedido do QR de uma mesa que JÁ ESTÁ ABERTA (o atendente aceitou o primeiro
 * pedido ou abriu a mesa): entra direto na comanda e na cozinha, sem esperar
 * aceite -- a mesa aberta é a prova de que tem gente lá. Desligável em
 * Configurações -> Vitrine ("Aceitar sozinho os pedidos de mesa já aberta").
 */
function aceitarSozinhoSeMesaAberta(orderId) {
  const db = getDb();
  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(orderId);
  if (!pedido || ![CANAL, 'mesa_local'].includes(pedido.canal) || pedido.status !== 'novo' || !pedido.mesa_numero) return { aceito: false };
  if (!require('./vitrineService').getConfig().aceitarMesaAberta) return { aceito: false };
  // Mesa transferida depois do QR lido: vale a mesa para onde a comanda foi.
  let numero = pedido.mesa_numero;
  const lida = db.prepare('SELECT * FROM restaurant_tables WHERE location_id = ? AND numero = ?').get(pedido.location_id, numero);
  if (lida && lida.status === 'aguardando_limpeza') {
    const foi = require('./tableService').destinoDaTransferencia(db, lida);
    if (foi) numero = foi.numero;
  }
  const mesa = db.prepare(`
    SELECT t.id, t.sale_id, s.operador_id FROM restaurant_tables t JOIN sales s ON s.id = t.sale_id
    WHERE t.location_id = ? AND t.numero = ? AND t.status = 'ocupada' AND s.status = 'aberta'`).get(pedido.location_id, numero);
  if (!mesa) return { aceito: false };
  const r = require('./botOrderService').lancarPedidoNaMesa({ orderId, operadorId: mesa.operador_id, deviceId: 'vitrine-qr' });
  if (!r.ok) return { aceito: false, erro: r.error };
  try {
    require('./authService').registrarEventoAuditoria({
      tipoEvento: 'pedido_qr_aceito_sozinho', solicitanteId: mesa.operador_id,
      motivo: `Pedido do QR da Mesa ${pedido.mesa_numero} (${pedido.cliente_nome}) entrou direto: a mesa já estava aberta.`,
    });
  } catch { /* auditoria é extra */ }
  return { aceito: true, saleId: r.saleId, itensNaoLancados: r.itensNaoLancados || [] };
}

function limparTexto(valor, max) {
  return String(valor ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Itens válidos: produto ativo com preço, quantidade inteira (ou 3 casas em
 * kg/l/m) entre 0 e 99, repetidos somados, no máximo 40 linhas. */
function itensValidos(itensBrutos) {
  if (!Array.isArray(itensBrutos)) return [];
  const buscar = getDb().prepare('SELECT * FROM products WHERE id = ? AND ativo = 1');
  const { precoEfetivo } = require('./productService');
  const porProduto = new Map();
  const observacoes = new Map();
  for (const bruto of itensBrutos.slice(0, LIMITE_ITENS_PEDIDO)) {
    const id = typeof bruto?.produtoId === 'string' ? bruto.produtoId.slice(0, 64) : null;
    const q = Number(bruto?.quantidade);
    if (!id || !Number.isFinite(q) || q <= 0) continue;
    const produto = buscar.get(id);
    if (!produto || !(precoEfetivo(produto) > 0)) continue;
    const fracionada = FRACIONADAS.includes(String(produto.unidade || '').toLowerCase());
    const quantidade = fracionada ? arred(q, 3) : Math.round(q);
    if (quantidade <= 0 || quantidade > QTD_MAXIMA_ITEM) continue;
    const somado = arred((porProduto.get(id) || 0) + quantidade, 3);
    if (somado > QTD_MAXIMA_ITEM) continue;
    porProduto.set(id, somado);
    const obs = limparTexto(bruto?.observacao, 120);
    if (obs) observacoes.set(id, obs);
  }
  return [...porProduto.entries()].map(([productId, quantidade]) => ({ productId, quantidade, observacao: observacoes.get(productId) || null }));
}

function observacoesDoPedido({ pagamento, trocoPara, observacao, modo, mesaRotulo }) {
  const partes = [`Pedido pelo site${mesaRotulo ? ` (QR da ${mesaRotulo})` : ''}.`];
  if (modo === 'local' && !mesaRotulo) partes.push('Vai comer no local (retira no balcão pela senha).');
  const forma = PAGAMENTOS[pagamento];
  if (pagamento === 'pix_online' && !mesaRotulo) partes.push('Pagamento: Pix pelo site (antecipado).');
  else if (forma && !mesaRotulo) {
    const troco = pagamento === 'dinheiro' && Number(trocoPara) > 0 && Number(trocoPara) <= 10000 ? ` (troco para ${moeda(trocoPara)})` : '';
    partes.push(`Pagamento: ${forma}${troco}.`);
  }
  const obs = limparTexto(observacao, 200);
  if (obs) partes.push(`Obs.: ${obs}`);
  return partes.join(' ');
}

/**
 * Cria o pedido local (bot_orders). Sem rede -- exportada pra teste.
 * Idempotente pelo id do documento (`pedidoId`).
 */
function criarPedidoVitrine({ pedidoId, slug, nome, telefone, modo, mesa, endereco, pagamento, trocoPara, observacao, itens, aparelho }) {
  const db = getDb();
  if (typeof pedidoId !== 'string' || !/^[A-Za-z0-9]{10,40}$/.test(pedidoId)) return { ok: false, error: 'Pedido inválido.' };
  const ja = db.prepare('SELECT id FROM bot_orders WHERE canal = ? AND canal_ref = ?').get(CANAL, pedidoId);
  if (ja) return { ok: true, id: ja.id, jaExistia: true };

  const vitrine = require('./vitrineService');
  const config = vitrine.getConfig();
  if (!config.slug || slug !== config.slug) return { ok: false, error: 'Este endereço não é desta loja.' };
  if (!config.ativa) return { ok: false, error: 'A vitrine da loja está fechada agora.' };
  if (!config.pedidosOnline) return { ok: false, error: 'A loja não está recebendo pedidos pelo site agora.' };

  const nomeLimpo = limparTexto(nome, 60);
  if (nomeLimpo.length < 2) return { ok: false, error: 'Informe o seu nome.' };

  let mesaRow = null;
  if (mesa != null && mesa !== '') {
    mesaRow = vitrine.mesaPeloToken(mesa);
    if (!mesaRow) return { ok: false, error: 'Este QR de mesa não vale mais. Peça ajuda a um atendente.' };
  }
  // Leu o QR da mesa mas escolheu "retirar no balcão": vale a retirada.
  if (mesaRow && modo === 'retirada' && config.modos.includes('retirada')) mesaRow = null;
  const modoFinal = mesaRow ? 'local' : (['retirada', 'entrega', 'local'].includes(modo) ? modo : 'retirada');
  if (!mesaRow && !config.modos.includes(modoFinal)) return { ok: false, error: 'A loja não oferece essa forma de receber o pedido.' };
  const tipo = modoFinal === 'entrega' && !mesaRow ? 'entrega' : 'retirada';
  if (pagamento != null && !PAGAMENTOS_ACEITOS.includes(pagamento)) return { ok: false, error: 'Forma de pagamento inválida.' };
  // Pelo QR da mesa paga na conta da mesa; o Pix antecipado é só para quem
  // retira/recebe. Sem forma informada: paga na retirada (Pix na loja).
  const pagamentoFinal = mesaRow ? 'mesa' : (!pagamento || pagamento === 'mesa' ? 'pix' : pagamento);
  if (pagamentoFinal === 'pix_online' && !(config.pixOnline && require('./vitrinePixService').disponivel())) {
    return { ok: false, error: 'A loja não está aceitando Pix pelo site agora. Escolha pagar na retirada.' };
  }
  const enderecoLimpo = limparTexto(endereco, 200);
  if (tipo === 'entrega' && enderecoLimpo.length < 6) return { ok: false, error: 'Informe o endereço de entrega.' };

  const validos = itensValidos(itens);
  if (!validos.length) return { ok: false, error: 'Nenhum produto do pedido está disponível na loja.' };

  const naFila = db.prepare(`SELECT COUNT(*) AS n FROM bot_orders WHERE canal = ? AND status = 'novo'`).get(CANAL).n;
  if (naFila >= LIMITE_NOVOS_NA_FILA) return { ok: false, error: 'A loja está com muitos pedidos esperando confirmação. Tente de novo em alguns minutos.' };
  if (mesaRow) {
    const daMesa = db.prepare(`SELECT COUNT(*) AS n FROM bot_orders WHERE canal = ? AND status = 'novo' AND mesa_numero = ?`).get(CANAL, mesaRow.numero).n;
    if (daMesa >= LIMITE_NOVOS_POR_MESA) return { ok: false, error: 'Esta mesa já tem pedidos esperando o atendente confirmar.' };
  }

  const location = db.prepare('SELECT id FROM locations LIMIT 1').get();
  if (!location) return { ok: false, error: 'Nenhum local cadastrado nesta instalação.' };

  const botOrderService = require('./botOrderService');
  const mesaRotulo = mesaRow ? (mesaRow.nome || `Mesa ${mesaRow.numero}`) : null;
  let orderId = null;
  try {
    db.transaction(() => {
      const r = botOrderService.createOrder({
        locationId: location.id, clienteNome: nomeLimpo, clienteTelefone: TELEFONE_PEDIDO, tipoEntrega: tipo,
        endereco: tipo === 'entrega' ? enderecoLimpo : null,
        observacoes: observacoesDoPedido({ pagamento: pagamentoFinal, trocoPara, observacao, modo: modoFinal, mesaRotulo }),
        origem: 'manual', itens: validos, mesaNumero: mesaRow ? mesaRow.numero : null,
        consumoLocal: modoFinal === 'local' && !mesaRow,
      });
      if (!r.ok) throw new Error(r.error);
      db.prepare('UPDATE bot_orders SET canal = ?, canal_ref = ?, vitrine_slug = ?, pagamento_online = ?, telefone_informado = ?, aparelho = ? WHERE id = ?')
        .run(CANAL, pedidoId, slug, pagamentoFinal === 'pix_online' ? 'aguardando' : '', telefoneValido(telefone),
          mesaRow && /^[A-Za-z0-9]{16,40}$/.test(String(aparelho || '')) ? aparelho : null, r.id);
      orderId = r.id;
    })();
  } catch (err) {
    const ja2 = db.prepare('SELECT id FROM bot_orders WHERE canal = ? AND canal_ref = ?').get(CANAL, pedidoId);
    if (ja2) return { ok: true, id: ja2.id, jaExistia: true };
    return { ok: false, error: err?.message || 'Não foi possível registrar o pedido.' };
  }
  const { total } = db.prepare('SELECT COALESCE(SUM(preco_unitario * quantidade), 0) AS total FROM bot_order_items WHERE bot_order_id = ?').get(orderId);
  return {
    ok: true, id: orderId, itens: validos.length, total: arred(total), nome: nomeLimpo, tipo, modo: modoFinal, mesa: mesaRotulo,
    pixOnline: pagamentoFinal === 'pix_online',
  };
}

// ---------- acompanhamento (página do cliente) ----------

/** Etapa que a página mostra, a partir do pedido local. Exportada pra teste. */
function etapaDoPedido(pedido, senha) {
  if (!pedido) return null;
  const base = {
    senha: senha ?? null, mesa: pedido.mesa_numero ? `Mesa ${pedido.mesa_numero}` : null,
    pago: pedido.pagamento_online === 'pago',
  };
  if (pedido.status === 'cancelado') {
    return { ...base, etapa: 'cancelado', motivo: pedido.pagamento_online === 'expirado' ? 'O Pix não foi pago no prazo.' : null };
  }
  if (pedido.pagamento_online === 'aguardando' && pedido.status === 'novo') return { ...base, etapa: 'pagamento' };
  if (pedido.mesa_numero) return { ...base, etapa: pedido.status === 'concluido' ? 'na_mesa' : 'recebido' };
  switch (pedido.status) {
    case 'novo': return { ...base, etapa: 'recebido' };
    case 'em_separacao': return { ...base, etapa: 'preparando' };
    case 'pronto': return { ...base, etapa: pedido.tipo_entrega === 'entrega' ? 'saiu' : 'pronto' };
    case 'concluido': return { ...base, etapa: pedido.tipo_entrega === 'entrega' ? 'saiu' : 'entregue' };
    default: return { ...base, etapa: 'recebido' };
  }
}

async function publicarEtapa(orderId) {
  const db = getDb();
  const pedido = db.prepare('SELECT * FROM bot_orders WHERE id = ?').get(orderId);
  if (!pedido || pedido.canal !== CANAL || !pedido.canal_ref) return { publicado: false };
  const senha = db.prepare(`SELECT numero FROM chamadas WHERE bot_order_id = ? AND status <> 'cancelada'`).get(orderId)?.numero;
  const etapa = etapaDoPedido(pedido, senha);
  if (etapa.etapa === 'pagamento') {
    const pixService = require('./vitrinePixService');
    const pix = pixService.paraPagina(pixService.getDoPedido(orderId));
    if (pix && pix.copiaECola) {
      let qr = null;
      try { qr = await require('qrcode').toDataURL(pix.copiaECola, { errorCorrectionLevel: 'M', margin: 1, width: 280 }); } catch { qr = null; }
      etapa.pix = { valor: pix.valor, copiaECola: pix.copiaECola, expiraEm: pix.expiraEm, ...(qr ? { qr } : {}) };
    } else {
      etapa.pix = { valor: pix?.valor ?? null, gerando: true };
    }
  }
  if (!etapa.motivo) delete etapa.motivo;
  try {
    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
    const firestore = require('./licenseService').getLicenseFirestore();
    const installId = require('./pdvRegistryService').getOrCreateDeviceUid();
    await setDoc(doc(firestore, 'installations', installId, 'pedidos_vitrine_status', pedido.canal_ref), { ...etapa, atualizadoEm: serverTimestamp() });
    return { publicado: true };
  } catch (err) {
    console.error('[vitrinePedidoService] acompanhamento não publicado:', err?.message || err);
    return { publicado: false };
  }
}

// ---------- escuta ----------

async function processarDocumento(docSnap, ctx) {
  const dados = docSnap.data() || {};
  if (dados.status !== 'novo') return;
  const { doc, getDoc, updateDoc, serverTimestamp } = require('firebase/firestore');
  const slug = typeof dados.slug === 'string' && SLUG_VALIDO.test(dados.slug) ? dados.slug : null;
  let vitrine = null;
  if (slug) {
    try {
      const v = await getDoc(doc(ctx.firestore, 'vitrines', slug));
      vitrine = v.exists() ? v.data() : null;
    } catch { vitrine = null; }
  }
  // Endereço de demonstração: quem resolve é a vitrine de demonstração.
  if (vitrine && vitrine.demo && typeof vitrine.demo === 'object') {
    await require('./vitrineDemoService').processarPedidoRecebido(docSnap, ctx);
    return;
  }
  const pedidoId = docSnap.id;
  if (estado.processando.has(pedidoId)) return;
  estado.processando.add(pedidoId);
  const ref = doc(ctx.firestore, 'installations', ctx.installId, 'pedidos_vitrine', pedidoId);
  const recusar = (erro) => updateDoc(ref, { status: 'erro', erro, processadoEm: serverTimestamp() }).catch(() => {});
  try {
    if (!vitrine || vitrine.installId !== ctx.installId || vitrine.ativa === false) {
      await recusar('Este endereço não é desta loja.');
      return;
    }
    const r = criarPedidoVitrine({ ...dados, pedidoId, slug });
    if (!r.ok) { await recusar(r.error); return; }
    await updateDoc(ref, { status: 'recebido', bot_order_id: r.id, processadoEm: serverTimestamp() });
    if (r.pixOnline || (r.jaExistia && getDb().prepare(`SELECT pagamento_online FROM bot_orders WHERE id = ?`).get(r.id)?.pagamento_online === 'aguardando')) {
      // Pix antecipado: o QR vai para a página do cliente pelo acompanhamento.
      await publicarEtapa(r.id).catch(() => {});
      const pix = await require('./vitrinePixService').criarParaPedido({ botOrderId: r.id });
      if (!pix.ok) console.error('[vitrinePedidoService] Pix do pedido do site:', pix.error);
    }
    let automatico = { aceito: false };
    if (!r.jaExistia && r.mesa) automatico = aceitarSozinhoSeMesaAberta(r.id);
    publicarEtapa(r.id).catch(() => {});
    if (!r.jaExistia) {
      const aviso = { ...r, demo: false, aguardandoPix: !!r.pixOnline, aceitoSozinho: automatico.aceito };
      try { require('./notificationService').notifyNewVitrineOrder(aviso); } catch { /* aviso é extra */ }
      avisarTelas(aviso);
    }
  } catch (err) {
    console.error('[vitrinePedidoService] falha ao processar pedido da vitrine:', err);
    await recusar('Não foi possível registrar o pedido na loja.');
  } finally {
    estado.processando.delete(pedidoId);
  }
}

function deveEscutar() {
  let demo = false;
  try { demo = require('./vitrineDemoService').ehMaquinaDemo(); } catch { demo = false; }
  const c = require('./vitrineService').getConfig();
  return demo || (!!c.slug && c.ativa && c.pedidosOnline);
}

/** Aviso na tela do GerenciaAI (qualquer tela): som + Aceitar/Recusar. */
function avisarTelas(pedido) {
  // Nesta máquina e nos caixas apontados para ela (avisosDoServidor).
  require('./avisosDoServidor').registrar('vitrine:pedidoNovo', {
    orderId: pedido.id, nome: pedido.nome, mesa: pedido.mesa || null, total: pedido.total, itens: pedido.itens,
    modo: pedido.modo, aguardandoPix: !!pedido.aguardandoPix, aceitoSozinho: !!pedido.aceitoSozinho,
  });
}

function pararEscuta() {
  if (estado.pararEscuta) { try { estado.pararEscuta(); } catch { /* já parada */ } }
  estado.pararEscuta = null;
  estado.escutando = false;
}

/** Tenta ligar a escuta de novo daqui a pouco (15 s, 30 s, ... até 5 min). */
function agendarReconexao() {
  if (estado.timerReconexao) return;
  const espera = Math.min(ESPERA_RECONEXAO_MAX_MS, ESPERA_RECONEXAO_MIN_MS * 2 ** Math.min(estado.tentativas, 5));
  estado.tentativas += 1;
  estado.timerReconexao = setTimeout(() => { estado.timerReconexao = null; atualizarEscuta(); }, espera);
  estado.timerReconexao.unref?.();
}

/** Para a tela da Vitrine: está recebendo pedidos agora? */
function statusDaEscuta() {
  return { escutando: estado.escutando, ultimoErro: estado.ultimoErro, ultimaRespostaEm: estado.ultimaRespostaEm, reconectando: !!estado.timerReconexao };
}

/** Liga ou desliga a escuta conforme a configuração (chamado ao salvar a
 * vitrine, ao ler o documento da instalação e pela vitrine de demonstração). */
function atualizarEscuta() {
  const quer = deveEscutar();
  if (!quer) {
    if (estado.timerReconexao) { clearTimeout(estado.timerReconexao); estado.timerReconexao = null; }
    estado.tentativas = 0;
    estado.ultimoErro = null;
    if (estado.escutando) pararEscuta();
    return;
  }
  if (estado.escutando) return;
  try {
    const { collection, query, where, onSnapshot } = nuvemDeTeste || require('firebase/firestore');
    const firestore = nuvemDeTeste ? nuvemDeTeste.firestore : require('./licenseService').getLicenseFirestore();
    const installId = nuvemDeTeste ? nuvemDeTeste.installId : require('./pdvRegistryService').getOrCreateDeviceUid();
    estado.pararEscuta = onSnapshot(
      query(collection(firestore, 'installations', installId, 'pedidos_vitrine'), where('status', '==', 'novo')),
      (snap) => {
        estado.tentativas = 0;
        estado.ultimoErro = null;
        estado.ultimaRespostaEm = new Date().toISOString();
        snap.docChanges().forEach((mudanca) => {
          if (mudanca.type === 'removed') return;
          processarDocumento(mudanca.doc, { firestore, installId }).catch((err) => console.error('[vitrinePedidoService]', err));
        });
      },
      (err) => {
        // A escuta morreu (o Firestore não religa sozinho depois de um erro): religa.
        console.error('[vitrinePedidoService] escuta de pedidos falhou (religando):', err?.message || err);
        estado.ultimoErro = String(err?.code || err?.message || err).slice(0, 200);
        pararEscuta();
        agendarReconexao();
      },
    );
    estado.escutando = true;
  } catch (err) {
    console.error('[vitrinePedidoService] não foi possível iniciar a escuta (tenta de novo):', err?.message || err);
    estado.ultimoErro = String(err?.message || err).slice(0, 200);
    pararEscuta();
    agendarReconexao();
  }
}

module.exports = {
  aceitarSozinhoSeMesaAberta, telefoneValido, avisarTelas, itensValidos,
  criarPedidoVitrine, etapaDoPedido, publicarEtapa, atualizarEscuta, statusDaEscuta, _definirNuvemParaTeste, itensValidos, observacoesDoPedido,
  CANAL, TELEFONE_PEDIDO, PAGAMENTOS_ACEITOS,
};
