// Contingência do caixa apontado para o servidor das mesas (mesa compartilhada).
//
// Servidor fora do ar (ou a rede caiu), o caixa NÃO para:
//   - mostra as mesas pela cópia que guarda (espelho: lista + comanda de cada
//     mesa aberta, atualizada sempre que fala com o servidor);
//   - abre mesa, lança, muda quantidade, observação e pessoa, recebe a conta
//     (a venda é deste caixa, como sempre), limpa e abre a mesa de novo;
//   - guarda cada operação numa fila (mesa_fila_offline), na ordem;
//   - imprime na cozinha daqui, se este caixa tiver impressora da cozinha.
// O servidor voltou: a fila vai NA ORDEM (ids provisórios trocados pelos de
// verdade), cada operação com um id próprio -- repetir não aplica duas vezes
// (mesa_ops_aplicadas no servidor). O que o servidor recusar fica marcado
// com o motivo para o gerente conferir (nada some sem aviso).
//
// Enquanto houver fila, tudo passa por ela (uma operação nova nunca fura a
// fila e chega antes das antigas).

const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

const MC = () => require('./mesaCompartilhadaService');
const PREFIXO = 'off'; // ids provisórios: offv<uuid> (venda), offi<uuid> (item)
const ESPERA_ENTRE_TENTATIVAS_MS = 15000;

const CANAIS_OFFLINE = new Set([
  'table:list', 'table:getCart', 'table:open', 'table:markCleaned',
  'sale:addItem', 'sale:ajustarQuantidade', 'sale:setItemNote', 'sale:setItemPerson',
  'reservation:listVinculadasAtivas', 'auth:getSecurityConfig',
]);

function hubAtual() {
  try { return require('./lanClienteService').config()?.hubId || 'servidor'; } catch { return 'servidor'; }
}
function agoraUtc() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function ehProvisorio(id) { return typeof id === 'string' && id.startsWith(PREFIXO); }

// ------------------------------------------------------------ espelho

function lerEspelho(chave, hub = hubAtual()) {
  try {
    const r = getDb().prepare('SELECT json FROM mesa_espelho WHERE hub_id = ? AND chave = ?').get(hub, chave);
    return r ? JSON.parse(r.json) : null;
  } catch { return null; }
}

function gravarEspelho(chave, valor, hub = hubAtual()) {
  try {
    getDb().prepare(`INSERT INTO mesa_espelho (hub_id, chave, json, atualizado_em) VALUES (?, ?, ?, datetime('now'))
                     ON CONFLICT(hub_id, chave) DO UPDATE SET json = excluded.json, atualizado_em = excluded.atualizado_em`)
      .run(hub, chave, JSON.stringify(valor));
  } catch (err) { console.error('[contingência] espelho:', err?.message || err); }
}

function apagarEspelho(chave, hub = hubAtual()) {
  try { getDb().prepare('DELETE FROM mesa_espelho WHERE hub_id = ? AND chave = ?').run(hub, chave); } catch { /* sem tabela */ }
}

/** Resposta boa do servidor: guarda na cópia (só sem fila; com fila, a cópia é a verdade daqui). */
function anotarResposta(canal, args, r) {
  if (temFila()) return;
  if (canal === 'table:list' && Array.isArray(r)) {
    gravarEspelho('lista', r);
    // Comanda que não está mais em nenhuma mesa: sai da cópia.
    const abertas = new Set(r.map((m) => m.sale_id).filter(Boolean));
    try {
      for (const c of getDb().prepare("SELECT chave FROM mesa_espelho WHERE hub_id = ? AND chave LIKE 'cart:%'").all(hubAtual())) {
        if (!abertas.has(c.chave.slice(5))) apagarEspelho(c.chave);
      }
    } catch { /* sem tabela */ }
  }
  if (canal === 'table:getCart' && r && Array.isArray(r.items) && args?.saleId) gravarEspelho(`cart:${args.saleId}`, r);
}

let ultimaAtualizacao = 0;
/** Copia a lista e a comanda de cada mesa aberta (a cada mudança, no máximo a cada 20 s). */
async function atualizarEspelho({ forcar = false } = {}) {
  if (temFila()) return;
  if (!forcar && Date.now() - ultimaAtualizacao < 20000) return;
  ultimaAtualizacao = Date.now();
  try {
    const lista = await MC().chamarNoServidor('table:list', {}, null);
    if (!Array.isArray(lista) || temFila()) return;
    anotarResposta('table:list', {}, lista);
    for (const m of lista) {
      if (m.status === 'ocupada' && m.sale_id && !m.unida_a_mesa_id) {
        const c = await MC().chamarNoServidor('table:getCart', { saleId: m.sale_id }, null);
        if (c && !(c.ok === false)) anotarResposta('table:getCart', { saleId: m.sale_id }, c);
      }
    }
  } catch { /* fica a cópia anterior */ }
}

function lista() { return lerEspelho('lista'); }
function gravarLista(l) { gravarEspelho('lista', l); }
function carrinho(saleId) { return lerEspelho(`cart:${saleId}`); }
function gravarCarrinho(saleId, c) { gravarEspelho(`cart:${saleId}`, c); }
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
function totalDe(c) { return r2((c.items || []).filter((i) => !i.cancelado).reduce((s, i) => s + i.quantidade * i.precoUnitario, 0)); }
function rotulo(m) { return m ? (m.nome || `Mesa ${m.numero}`) : 'Mesa'; }

function mesaDaVenda(l, saleId) { return (l || []).find((m) => m.sale_id === saleId && !m.unida_a_mesa_id) || null; }

function atualizarTotalNaLista(saleId, total) {
  const l = lista();
  const m = mesaDaVenda(l, saleId);
  if (m) { m.total_atual = total; gravarLista(l); }
}

// ------------------------------------------------------------ fila

function temFila() {
  try { return getDb().prepare("SELECT 1 FROM mesa_fila_offline WHERE estado = 'pendente' LIMIT 1").get() != null; } catch { return false; }
}

function enfileirar(canal, args, usuarioId, meta = {}, mesaRotulo = null) {
  const id = randomUUID();
  getDb().prepare('INSERT INTO mesa_fila_offline (id, hub_id, canal, args_json, meta_json, usuario_id, mesa_rotulo) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, hubAtual(), canal, JSON.stringify(args || {}), JSON.stringify(meta || {}), usuarioId || null, mesaRotulo);
  return id;
}

function suporta(canal) { return CANAIS_OFFLINE.has(canal); }

// ------------------------------------------------------------ operações sem o servidor

const SEM_SERVIDOR = 'Sem o servidor das mesas, isto não dá para fazer agora (dá para abrir mesa, lançar, mudar quantidade, observação e pessoa, receber e limpar). Tente quando ele voltar.';

function executar(canal, args = {}, usuarioId = null) {
  const a = args || {};
  switch (canal) {
    case 'table:list': {
      const l = lista();
      if (!l) return { ok: false, error: 'O servidor das mesas não respondeu e este caixa ainda não tem cópia das mesas.', rede: true };
      return MC().anotarTravasDaqui(l).map((m) => ({ ...m, offline: true }));
    }
    case 'table:getCart': {
      const c = carrinho(a.saleId);
      return c || { items: [], total: 0, pessoas: [], taxaServicoPercentual: 0, desconto: 0, totalPago: 0, pagoPorPessoa: {}, grupo: null, offline: true };
    }
    case 'reservation:listVinculadasAtivas': return [];
    case 'auth:getSecurityConfig': return require('./authService').getSecurityConfig();
    case 'table:open': return abrir(a, usuarioId);
    case 'table:markCleaned': return limpar(a, usuarioId);
    case 'sale:addItem': return lancar(a, usuarioId);
    case 'sale:ajustarQuantidade': return ajustar(a, usuarioId);
    case 'sale:setItemNote': return mudarItem(a, usuarioId, 'sale:setItemNote', (i) => { i.observacao = String(a.observacao || '').slice(0, 200); });
    case 'sale:setItemPerson': return mudarItem(a, usuarioId, 'sale:setItemPerson', (i) => { i.pessoaNumero = a.pessoaNumero || null; });
    default: return { ok: false, error: SEM_SERVIDOR, semServidor: true };
  }
}

function abrir(a, usuarioId) {
  const l = lista();
  const m = (l || []).find((x) => x.id === a.tableId);
  if (!m) return { ok: false, error: 'Mesa não encontrada na cópia deste caixa.' };
  if (m.unida_a_mesa_id) { const p = l.find((x) => x.id === m.unida_a_mesa_id); return { ok: true, saleId: p?.sale_id, principalId: p?.id }; }
  if (m.status === 'ocupada' && m.sale_id) return { ok: true, saleId: m.sale_id };
  if (m.status === 'aguardando_limpeza') return { ok: false, error: 'Essa mesa ainda está aguardando limpeza — marque como limpa antes de abrir de novo.' };
  const saleId = `${PREFIXO}v${randomUUID()}`;
  Object.assign(m, { status: 'ocupada', sale_id: saleId, pessoas: a.pessoas ? Number(a.pessoas) : null, aberta_em: agoraUtc(), total_atual: 0, reservado_para: null });
  gravarLista(l);
  gravarCarrinho(saleId, { items: [], total: 0, pessoas: [], taxaServicoPercentual: 0, desconto: 0, totalPago: 0, pagoPorPessoa: {}, grupo: null, venda: { criadoEm: agoraUtc() } });
  enfileirar('table:open', { tableId: a.tableId, pessoas: a.pessoas || null }, usuarioId, { saleTemp: saleId }, rotulo(m));
  avisar();
  return { ok: true, saleId, offline: true };
}

function limpar(a, usuarioId) {
  const l = lista();
  const m = (l || []).find((x) => x.id === a.tableId);
  if (!m) return { ok: false, error: 'Mesa não encontrada na cópia deste caixa.' };
  if (m.status !== 'aguardando_limpeza') return { ok: false, error: 'Essa mesa não está aguardando limpeza.' };
  Object.assign(m, { status: 'livre', sale_id: null, pessoas: null, total_atual: null, fechando_caixa_id: null, fechando_aqui: false, venda_local_id: null });
  gravarLista(l);
  enfileirar('table:markCleaned', { tableId: a.tableId }, usuarioId, {}, rotulo(m));
  avisar();
  return { ok: true, offline: true };
}

function lancar(a, usuarioId) {
  const c = carrinho(a.saleId);
  if (!c) return { ok: false, error: 'Essa comanda não está na cópia deste caixa. Abra a mesa de novo.' };
  const l = lista();
  const m = mesaDaVenda(l, a.saleId);
  if (m?.fechando_caixa_id) return { ok: false, error: 'Essa mesa está sendo paga. Termine o pagamento antes de lançar.' };
  const db = getDb();
  const p = db.prepare('SELECT id, nome, preco, unidade, ativo, tipo FROM products WHERE id = ?').get(a.productId);
  if (!p || !p.ativo) return { ok: false, error: 'Produto não encontrado ou desativado.' };
  const quantidade = Number(a.quantidade) > 0 ? Number(a.quantidade) : 1;
  // Estoque: o das mesas é o do servidor (este caixa não tem o saldo de lá).
  // Sem ele, não trava; a baixa (e a conferência) acontece quando a fila chegar lá.
  const avisoEstoque = null;
  const itemId = `${PREFIXO}i${randomUUID()}`;
  c.items.push({
    id: itemId, nome: p.nome, quantidade, precoUnitario: Number(p.preco) || 0, cancelado: false,
    observacao: a.observacao || '', pessoaNumero: a.pessoaNumero || null, ajustavel: true,
    offline: true, productIdLocal: p.id, unidade: p.unidade || 'un', impresso: false,
  });
  c.total = totalDe(c);
  gravarCarrinho(a.saleId, c);
  atualizarTotalNaLista(a.saleId, c.total);
  enfileirar('sale:addItem', { saleId: a.saleId, productId: a.productId, quantidade, pessoaNumero: a.pessoaNumero || null, observacao: a.observacao || null, deviceId: a.deviceId || null },
    usuarioId, { itemTemp: itemId }, rotulo(m));
  agendarCozinha(a.saleId);
  avisar();
  return {
    ok: true, itemId, precoUnitario: Number(p.preco) || 0, novoTotal: c.total, quantidadeTotal: quantidade, ajustavel: true, offline: true,
    ...(avisoEstoque ? { avisoEstoque } : {}),
  };
}

function ajustar(a, usuarioId) {
  const c = carrinho(a.saleId);
  const item = c?.items.find((i) => i.id === a.saleItemId && !i.cancelado);
  if (!item) return { ok: false, error: 'Item não encontrado na cópia deste caixa.' };
  const delta = Number(a.delta);
  if (![1, -1].includes(delta)) return { ok: false, error: 'Sem o servidor, a quantidade muda de 1 em 1.' };
  const nova = r2(item.quantidade + delta);
  if (nova < 1) return { ok: false, error: 'Para tirar o item, use Cancelar quando o servidor voltar.' };
  if (Number(c.totalPago) > 0 && delta < 0) return { ok: false, error: 'A conta já tem pagamento: diminuir pede o Cancelar (com o servidor).' };
  item.quantidade = nova;
  c.total = totalDe(c);
  gravarCarrinho(a.saleId, c);
  atualizarTotalNaLista(a.saleId, c.total);
  enfileirar('sale:ajustarQuantidade', { saleId: a.saleId, saleItemId: a.saleItemId, delta, deviceId: a.deviceId || null }, usuarioId, {}, rotulo(mesaDaVenda(lista(), a.saleId)));
  if (delta > 0 && item.offline) { item.impresso = false; } // a cozinha recebe a unidade nova
  avisar();
  return { ok: true, quantidade: nova, novoTotal: c.total, offline: true };
}

function mudarItem(a, usuarioId, canal, aplicar) {
  // A comanda do item: procura nas cópias.
  const db = getDb();
  let saleId = a.saleId || null;
  let c = saleId ? carrinho(saleId) : null;
  if (!c) {
    for (const r of db.prepare("SELECT chave, json FROM mesa_espelho WHERE hub_id = ? AND chave LIKE 'cart:%'").all(hubAtual())) {
      const cc = JSON.parse(r.json);
      if (cc.items?.some((i) => i.id === a.saleItemId)) { c = cc; saleId = r.chave.slice(5); break; }
    }
  }
  const item = c?.items.find((i) => i.id === a.saleItemId);
  if (!item) return { ok: false, error: 'Item não encontrado na cópia deste caixa.' };
  aplicar(item);
  gravarCarrinho(saleId, c);
  enfileirar(canal, { ...a, saleId }, usuarioId, {}, rotulo(mesaDaVenda(lista(), saleId)));
  avisar();
  return { ok: true, offline: true };
}

// Cozinha daqui (se tiver): imprime o que foi lançado sem o servidor.
const cozinhaAgendada = new Map();
function agendarCozinha(saleId) {
  clearTimeout(cozinhaAgendada.get(saleId));
  const t = setTimeout(() => { cozinhaAgendada.delete(saleId); imprimirNaCozinha(saleId).catch(() => {}); }, 2500);
  t.unref?.();
  cozinhaAgendada.set(saleId, t);
}

async function imprimirNaCozinha(saleId) {
  const cozinha = require('./cozinhaService');
  const config = cozinha.getConfig();
  if (!config.ativa) return { ok: false, desligada: true };
  const c = carrinho(saleId);
  const novos = (c?.items || []).filter((i) => i.offline && !i.impresso && !i.cancelado);
  if (!novos.length) return { ok: true, nada: true };
  const m = mesaDaVenda(lista(), saleId);
  const pessoa = (n) => (c.pessoas || []).find((p) => p.numero === n)?.nome || (n ? `Pessoa ${n}` : null);
  await cozinha.enviarParaImpressora({
    titulo: String(rotulo(m)).toUpperCase(), subtitulo: 'SEM SERVIDOR (contingência)', mesa: String(rotulo(m)).toUpperCase(),
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }),
    itens: novos.map((i) => ({ quantidade: i.quantidade, unidade: i.unidade || 'un', nome: i.nome, precoUnitario: i.precoUnitario, observacao: i.observacao || null, pessoa: pessoa(i.pessoaNumero) })),
    layout: (() => { try { return require('./estudioImpressaoService').getConfig('cozinha'); } catch { return {}; } })(),
  }, config);
  const atual = carrinho(saleId);
  const ids = new Set(novos.map((i) => i.id));
  for (const i of atual?.items || []) if (ids.has(i.id)) i.impresso = true;
  if (atual) gravarCarrinho(saleId, atual);
  // Na volta do servidor, esses itens chegam marcados como já enviados à cozinha.
  const db = getDb();
  for (const op of db.prepare("SELECT id, meta_json FROM mesa_fila_offline WHERE estado = 'pendente' AND canal = 'sale:addItem'").all()) {
    const meta = JSON.parse(op.meta_json || '{}');
    if (ids.has(meta.itemTemp)) db.prepare('UPDATE mesa_fila_offline SET meta_json = ? WHERE id = ?').run(JSON.stringify({ ...meta, impressoLocal: true }), op.id);
  }
  return { ok: true };
}

// ------------------------------------------------------------ receber a conta sem o servidor

/** Monta, pela cópia, a conta da mesa para receber neste caixa. */
function contaDaCopia(tableId) {
  const l = lista();
  const m = (l || []).find((x) => x.id === tableId);
  if (!m) return { erro: 'Mesa não encontrada na cópia deste caixa.' };
  const principal = m.unida_a_mesa_id ? l.find((x) => x.id === m.unida_a_mesa_id) : m;
  if (!principal || principal.status !== 'ocupada' || !principal.sale_id) return { erro: `${rotulo(m)} não está ocupada.` };
  const c = carrinho(principal.sale_id);
  if (!c) return { erro: `A comanda de ${rotulo(principal)} não está na cópia deste caixa (ela não foi aberta aqui antes de o servidor cair).` };
  const itens = (c.items || []).filter((i) => !i.cancelado);
  if (!itens.length) return { erro: `${rotulo(principal)} não tem nenhum item para cobrar.` };
  return {
    principal,
    conta: {
      offline: true,
      vendaServidorId: principal.sale_id,
      mesa: { id: principal.id, numero: principal.numero, nome: principal.nome || null, pessoas: principal.pessoas || null },
      unidas: l.filter((x) => x.unida_a_mesa_id === principal.id).map((u) => ({ id: u.id, numero: u.numero, nome: u.nome || null })),
      venda: {
        criadoEm: c.venda?.criadoEm || principal.aberta_em || agoraUtc(), operadorDoc: c.venda?.operadorDoc || null, clienteDoc: c.venda?.clienteDoc || null,
        desconto: 0, pontosResgatados: 0, descontoGerente: 0, descontoGerenteMotivo: null, descontoAutorizadoPorDoc: null,
        taxaServicoPercentual: c.taxaServicoPercentual || 0,
      },
      itens: itens.map((i) => ({
        id: i.id, produtoDoc: i.produtoDoc || null, productIdLocal: i.productIdLocal || null, produtoNome: i.nome,
        ehPersonalizado: !!i.ehPersonalizado, nomePersonalizado: i.nomePersonalizado || null,
        quantidade: i.quantidade, precoUnitario: i.precoUnitario, precoOriginal: i.precoOriginal ?? null, precoAlteradoMotivo: i.precoAlteradoMotivo || null,
        custoUnitario: i.custoUnitario ?? null, pessoaNumero: i.pessoaNumero || null, observacao: i.observacao || null,
        statusPreparo: 'pendente', especificacoesJson: i.especificacoesJson || null, criadoEm: i.criadoEm || null,
      })),
      pessoas: (c.pessoas || []).filter((p) => p.nome || p.clienteId).map((p) => ({ numero: p.numero, nome: p.nome || null, clienteDoc: null, clienteIdLocal: p.clienteId || null })),
    },
  };
}

/** Puxar a mesa sem o servidor: a venda é criada aqui pela cópia; a mesa fica "recebendo neste caixa". */
function puxarOffline({ tableId, usuarioId }) {
  const db = getDb();
  const { erro, conta, principal } = contaDaCopia(tableId);
  if (erro) return { ok: false, error: erro };
  const ja = db.prepare(`SELECT sale_id FROM mesa_remota_fechamentos WHERE venda_servidor_id = ? AND estado = 'pagando'`).get(conta.vendaServidorId);
  if (ja && db.prepare("SELECT status FROM sales WHERE id = ?").get(ja.sale_id)?.status === 'aberta') {
    return { ok: true, saleId: ja.sale_id, rotulo: rotulo(principal), retomada: true, offline: true };
  }
  let saleId;
  try {
    saleId = MC().importarConta(db, { ...conta, usuarioIdAqui: usuarioId }, hubAtual());
  } catch (err) {
    return { ok: false, error: err.message };
  }
  db.prepare('UPDATE mesa_remota_fechamentos SET offline = 1 WHERE sale_id = ?').run(saleId);
  const l = lista();
  const m = l.find((x) => x.id === principal.id);
  Object.assign(m, { fechando_caixa_id: MC().meuIdDaqui(), fechando_caixa_nome: 'este caixa', fechando_aqui: true, venda_local_id: saleId });
  gravarLista(l);
  avisar();
  return { ok: true, saleId, rotulo: rotulo(principal), offline: true };
}

/** Desistiu de receber (conta puxada sem o servidor): nada a avisar o servidor. */
function devolverOffline(f) {
  const l = lista();
  const m = (l || []).find((x) => x.venda_local_id === f.sale_id || x.id === f.mesa_id);
  if (m) { Object.assign(m, { fechando_caixa_id: null, fechando_aqui: false, venda_local_id: null }); gravarLista(l); }
  avisar();
}

/** Recebeu sem o servidor (ou com fila): a conclusão entra na fila, depois do que foi lançado. */
function enfileirarConclusao(saleId) {
  const db = getDb();
  const f = db.prepare('SELECT * FROM mesa_remota_fechamentos WHERE sale_id = ?').get(saleId);
  if (!f) return false;
  const ja = db.prepare("SELECT 1 FROM mesa_fila_offline WHERE canal = 'concluir' AND args_json LIKE ?").get(`%"${saleId}"%`);
  if (!ja) enfileirar('concluir', { saleId }, null, {}, f.mesa_rotulo);
  db.prepare(`UPDATE mesa_remota_fechamentos SET estado = 'concluir', offline = 1, atualizado_em = datetime('now') WHERE sale_id = ?`).run(saleId);
  // Na cópia: a mesa vai para limpeza (dá para limpar e abrir de novo sem o servidor).
  const l = lista();
  const m = (l || []).find((x) => x.id === f.mesa_id);
  if (m) {
    apagarEspelho(`cart:${m.sale_id}`);
    for (const x of l) if (x.id === m.id || x.unida_a_mesa_id === m.id) Object.assign(x, { status: 'aguardando_limpeza', sale_id: null, pessoas: null, total_atual: null, fechando_caixa_id: null, fechando_aqui: false, venda_local_id: null, unida_a_mesa_id: null });
    gravarLista(l);
  }
  avisar();
  return true;
}

// ------------------------------------------------------------ mandar a fila quando o servidor voltar

function idReal(temp) {
  if (!ehProvisorio(temp)) return temp;
  try { return getDb().prepare('SELECT real_id FROM mesa_ids_offline WHERE temp_id = ?').get(temp)?.real_id || null; } catch { return null; }
}
function guardarId(temp, real, tipo) {
  if (!temp || !real) return;
  getDb().prepare('INSERT OR REPLACE INTO mesa_ids_offline (temp_id, real_id, tipo) VALUES (?, ?, ?)').run(temp, real, tipo);
}
/** O id provisório nasceu de uma operação que o servidor recusou? */
function provisorioPerdido(temp) {
  try {
    return !!getDb().prepare(`SELECT 1 FROM mesa_fila_offline WHERE estado = 'erro' AND (meta_json LIKE ? OR meta_json LIKE ?)`).get(`%"saleTemp":"${temp}"%`, `%"itemTemp":"${temp}"%`);
  } catch { return false; }
}

let drenando = null;
let drenarDeNovo = null;
let ultimaFalha = 0;

/** Manda a fila ao servidor, na ordem. Para no primeiro sinal de rede fora. */
function drenar() {
  if (drenando) {
    // Pedido no meio de um envio: o que está rodando pode ter começado com o
    // servidor fora e parar no 1º erro. Espera ele acabar e manda DE NOVO --
    // devolver o resultado velho deixava a fila parada até o próximo ciclo.
    if (!drenarDeNovo) drenarDeNovo = drenando.catch(() => {}).then(() => { drenarDeNovo = null; return drenar(); });
    return drenarDeNovo;
  }
  drenando = (async () => {
    const db = getDb();
    let enviados = 0;
    let erros = 0;
    for (;;) {
      const op = db.prepare("SELECT * FROM mesa_fila_offline WHERE estado = 'pendente' ORDER BY seq LIMIT 1").get();
      if (!op) break;
      const args = JSON.parse(op.args_json || '{}');
      const meta = JSON.parse(op.meta_json || '{}');
      // Ids provisórios -> os de verdade.
      let perdido = null;
      for (const k of ['saleId', 'saleItemId']) {
        if (ehProvisorio(args[k])) {
          const real = idReal(args[k]);
          if (real) args[k] = real;
          else if (provisorioPerdido(args[k])) perdido = args[k];
          else perdido = perdido || args[k];
        }
      }
      if (perdido) {
        marcar(op.id, 'erro', 'Depende de uma operação que o servidor recusou (veja a anterior).');
        erros += 1;
        continue;
      }
      let r;
      try {
        if (op.canal === 'concluir') r = await concluirNoServidor(args.saleId, op);
        else r = await MC().chamarNoServidor(op.canal, args, op.usuario_id, { opId: op.id });
      } catch (err) {
        r = { ok: false, error: err.message, rede: !!err.rede };
      }
      if (r && r.rede) {
        db.prepare("UPDATE mesa_fila_offline SET tentativas = tentativas + 1, erro = ?, atualizado_em = datetime('now') WHERE id = ?").run(r.error || 'sem rede', op.id);
        ultimaFalha = Date.now();
        break;
      }
      if (r && r.ok === false && !r.aguardar) {
        marcar(op.id, 'erro', r.error || 'O servidor recusou.');
        erros += 1;
        auditarRecusa(op, r.error);
        continue;
      }
      if (r && r.aguardar) { ultimaFalha = Date.now(); break; } // ex.: produto ainda não chegou no servidor
      if (op.canal === 'table:open' && meta.saleTemp && r?.saleId) guardarId(meta.saleTemp, r.saleId, 'venda');
      if (op.canal === 'sale:addItem' && meta.itemTemp && r?.itemId) {
        guardarId(meta.itemTemp, r.itemId, 'item');
        if (meta.impressoLocal) {
          await MC().chamarNoServidor('cozinha:marcarEnviado', { saleItemIds: [r.itemId] }, op.usuario_id, { opId: `${op.id}:cozinha` }).catch(() => {});
        }
      }
      marcar(op.id, 'feito', null);
      enviados += 1;
    }
    const restantes = db.prepare("SELECT COUNT(*) AS n FROM mesa_fila_offline WHERE estado = 'pendente'").get().n;
    // Mandou a fila inteira: o servidor está no ar AGORA. Sai do modo sem servidor
    // na hora -- um envio antigo (que começou com o servidor fora) pode ter
    // anotado a falha depois e deixava o caixa na cópia local por mais um tempo.
    if (enviados > 0 && restantes === 0) ultimaFalha = 0;
    if (enviados || erros) {
      // Cópia nova do servidor (agora é ele a verdade de novo) e as telas recarregam.
      if (!restantes) { ultimaAtualizacao = 0; await atualizarEspelho({ forcar: true }); }
      MC().avisarTelasDaqui({ origem: 'servidor', contingencia: true });
      if (erros) MC().avisarTelasDaqui({ origem: 'aviso', mensagem: `${erros} operação(ões) feitas sem o servidor foram recusadas por ele. Confira em Mesas → Contingência.` });
    }
    // Registro concluído fica 7 dias; ids provisórios, 30.
    db.prepare("DELETE FROM mesa_fila_offline WHERE estado = 'feito' AND atualizado_em < datetime('now', '-7 days')").run();
    db.prepare("DELETE FROM mesa_ids_offline WHERE criado_em < datetime('now', '-30 days')").run();
    return { ok: true, enviados, erros, restantes };
  })().finally(() => { drenando = null; });
  return drenando;
}

function marcar(id, estado, erro) {
  getDb().prepare("UPDATE mesa_fila_offline SET estado = ?, erro = ?, tentativas = tentativas + 1, atualizado_em = datetime('now') WHERE id = ?").run(estado, erro, id);
}

function auditarRecusa(op, erro) {
  try {
    require('./authService').registrarEventoAuditoria({
      tipoEvento: 'contingencia_recusada', solicitanteId: op.usuario_id,
      motivo: `${op.mesa_rotulo || 'Mesa'}: ${op.canal} feito sem o servidor foi recusado por ele: ${erro || ''}`.slice(0, 480),
    });
  } catch { /* extra */ }
}

/** Conclusão de conta recebida sem o servidor: ids trocados e o mesmo /v1/mesas/concluir de sempre. */
async function concluirNoServidor(saleId, op) {
  const db = getDb();
  const f = db.prepare('SELECT * FROM mesa_remota_fechamentos WHERE sale_id = ?').get(saleId);
  if (!f) return { ok: true };
  if (f.estado === 'feito') return { ok: true };
  const venda = idReal(f.venda_servidor_id);
  if (!venda) return provisorioPerdido(f.venda_servidor_id) ? { ok: false, error: 'A mesa foi aberta sem o servidor e ele recusou a abertura.' } : { ok: false, aguardar: true };
  const itens = [];
  for (const id of JSON.parse(f.itens_servidor || '[]')) {
    const real = idReal(id);
    if (real) itens.push(real);
  }
  const r = await MC().pedirAoServidor('/v1/mesas/concluir', { vendaServidorId: venda, vendaCaixaId: saleId, itens }, { timeoutMs: 10000 });
  if (!r?.ok) return { ok: false, error: r?.error || 'servidor recusou' };
  db.prepare(`UPDATE mesa_remota_fechamentos SET estado = 'feito', venda_servidor_id = ?, aviso = ?, erro = NULL, atualizado_em = datetime('now') WHERE sale_id = ?`)
    .run(venda, r.conflito || (r.itensQueFicaram ? `${r.itensQueFicaram} item(ns) lançado(s) no servidor enquanto o caixa recebia ficaram numa comanda nova na ${f.mesa_rotulo}.` : null), saleId);
  if (r.conflito || r.itensQueFicaram) MC().avisarTelasDaqui({ origem: 'aviso', mensagem: r.conflito || `${r.itensQueFicaram} item(ns) da ${f.mesa_rotulo} ficaram numa comanda nova (lançados no servidor enquanto este caixa recebia).` });
  void op;
  return { ok: true };
}

/** Pode tentar o servidor agora? (não martela um servidor fora: espera 15 s depois de uma falha) */
function podeTentar() { return Date.now() - ultimaFalha > ESPERA_ENTRE_TENTATIVAS_MS; }
function anotarFalha() { ultimaFalha = Date.now(); }
function anotarSucesso() { ultimaFalha = 0; }
function offlineAgora() { return !podeTentar(); }

function avisar() { MC().avisarTelasDaqui({ origem: 'contingencia' }); }

/** Para a tela: fila, recusas recentes e a idade da cópia. */
function resumo() {
  try {
    const db = getDb();
    const pendentes = db.prepare("SELECT COUNT(*) AS n FROM mesa_fila_offline WHERE estado = 'pendente'").get().n;
    const erros = db.prepare("SELECT id, canal, mesa_rotulo, erro, atualizado_em FROM mesa_fila_offline WHERE estado = 'erro' AND atualizado_em >= datetime('now', '-1 day') ORDER BY seq").all();
    const copia = db.prepare("SELECT atualizado_em FROM mesa_espelho WHERE hub_id = ? AND chave = 'lista'").get(hubAtual())?.atualizado_em || null;
    return { offline: offlineAgora(), pendentes, erros, copiaDe: copia };
  } catch { return { offline: false, pendentes: 0, erros: [], copiaDe: null }; }
}

/** O gerente conferiu: tira as recusas da lista. */
function descartarErros() {
  getDb().prepare("UPDATE mesa_fila_offline SET estado = 'feito', erro = 'conferido: ' || COALESCE(erro, '') WHERE estado = 'erro'").run();
  return { ok: true };
}

const NOMES = {
  'table:open': 'abrir a mesa', 'table:markCleaned': 'limpar a mesa', 'sale:addItem': 'lançar item', 'sale:ajustarQuantidade': 'mudar quantidade',
  'sale:setItemNote': 'observação', 'sale:setItemPerson': 'trocar a pessoa', concluir: 'conta recebida',
};

module.exports = {
  CANAIS_OFFLINE, suporta, executar, temFila, drenar, anotarResposta, atualizarEspelho, puxarOffline, devolverOffline, enfileirarConclusao,
  resumo, descartarErros, podeTentar, anotarFalha, anotarSucesso, offlineAgora, ehProvisorio, imprimirNaCozinha, NOMES,
  _lerEspelho: lerEspelho,
};
