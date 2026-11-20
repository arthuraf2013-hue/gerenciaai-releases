// PEDIDO PELO QR DA MESA, PELA REDE DA LOJA (sem Firebase, sem internet).
//
// O computador servidor (ou o único computador da loja) abre um pequeno site
// na rede local (porta 47830). O QR de cada mesa aponta para
// http://<ip-do-servidor>:47830/m/<segredo-da-mesa>: o cliente, no Wi-Fi da
// loja, vê o cardápio (o mesmo da vitrine: cardápio do dia, esgotados), informa
// o nome (e, se quiser, o celular) e o pedido cai NA HORA na Separação daqui,
// já com a mesa -- como o pedido da vitrine, mas sem passar pela nuvem.
//
// - O segredo da mesa é o mesmo do QR da vitrine (restaurant_tables.qr_token):
//   sem ter lido o QR, ninguém pede "para a mesa 5". Trocar o QR invalida.
// - Mesa já aberta: entra direto na comanda e na cozinha
//   (vitrinePedidoService.aceitarSozinhoSeMesaAberta); senão o atendente aceita.
// - Limites: tamanho do pedido, pedidos por endereço de rede por minuto,
//   pedidos esperando por mesa. Só GET/POST, nada além do cardápio sai daqui.
// - Quem está só no 4G não alcança o servidor (é rede local). O cartão da mesa
//   pode levar também o QR do Wi-Fi (configurável).

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/database');

const CANAL = 'mesa_local';
const PORTA_PADRAO = 47830;
const MAX_CORPO = 32 * 1024;
const PEDIDOS_POR_MINUTO_POR_IP = 6;
const PEDIDOS_ESPERANDO_POR_MESA = 6;
const TOKEN_MESA = /^[A-Za-z0-9]{24}$/;
const ID_PEDIDO = /^[A-Za-z0-9]{12,40}$/;

const estado = { servidor: null, porta: null, erro: null, ligando: null, porIp: new Map() };

// ------------------------------------------------------------ configuração

function linha() {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO mesa_local_config (id) VALUES ('default')").run();
  return db.prepare("SELECT * FROM mesa_local_config WHERE id = 'default'").get();
}

function getConfig() {
  const r = linha();
  const porta = Number(r.porta) || PORTA_PADRAO;
  const enderecoFixo = r.endereco_fixo || '';
  const host = enderecoFixo || enderecosDaMaquina()[0] || null;
  return {
    ativo: r.ativo === 1,
    porta,
    enderecoFixo,
    enderecosDetectados: enderecosDaMaquina(),
    endereco: host ? `http://${host}:${porta}` : null,
    wifiNome: r.wifi_nome || '',
    wifiSenha: r.wifi_senha || '',
    wifiTipo: ['WPA', 'WEP', 'nopass'].includes(r.wifi_tipo) ? r.wifi_tipo : 'WPA',
    mostrarWifi: r.mostrar_wifi === 1 && !!r.wifi_nome,
    rodando: !!estado.servidor,
    porta_em_uso: estado.porta,
    erro: estado.erro,
    deveRodar: deveRodar(r),
  };
}

const IP_VALIDO = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function enderecoFixoValido(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  const m = t.match(IP_VALIDO);
  if (m) return m.slice(1).every((n) => Number(n) <= 255) ? t : null;
  if (/^[\d.]+$/.test(t)) return null; // parece IP, mas não é
  return /^[a-z0-9][a-z0-9.-]{0,60}$/i.test(t) ? t : null; // nome na rede (ex.: caixa1.local)
}

function saveConfig({ ativo, porta, enderecoFixo, wifiNome, wifiSenha, wifiTipo, mostrarWifi, requestingUserId } = {}) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(requestingUserId);
  if (!user || !['gerente', 'admin', 'suporte'].includes(user.role)) return { ok: false, error: 'Apenas gerente ou administrador muda o pedido pela mesa.' };
  const p = porta === undefined || porta === null || porta === '' ? PORTA_PADRAO : Number(porta);
  if (!Number.isInteger(p) || p < 1024 || p > 65535 || p === 47820 || p === 47821) return { ok: false, error: 'Porta inválida (use entre 1024 e 65535, fora da 47820/47821 da rede dos caixas).' };
  const fixo = enderecoFixoValido(enderecoFixo);
  if (fixo === null) return { ok: false, error: 'Endereço inválido. Use o IP do servidor (ex.: 192.168.1.74) ou deixe em branco.' };
  const nomeWifi = String(wifiNome || '').trim().slice(0, 32);
  const tipo = ['WPA', 'WEP', 'nopass'].includes(wifiTipo) ? wifiTipo : 'WPA';
  if (mostrarWifi && !nomeWifi) return { ok: false, error: 'Informe o nome da rede Wi-Fi para mostrar o QR do Wi-Fi.' };
  linha();
  db.prepare(`UPDATE mesa_local_config SET ativo = ?, porta = ?, endereco_fixo = ?, wifi_nome = ?, wifi_senha = ?, wifi_tipo = ?,
    mostrar_wifi = ?, atualizado_em = NOW_SYNCED() WHERE id = 'default'`)
    .run(ativo ? 1 : 0, p, fixo || null, nomeWifi || null, tipo === 'nopass' ? null : String(wifiSenha || '').slice(0, 63) || null, tipo, mostrarWifi ? 1 : 0);
  try {
    require('./authService').registrarEventoAuditoria({
      tipoEvento: 'mesa_local_alterado', solicitanteId: requestingUserId,
      motivo: ativo ? `Pedido pela mesa na rede local ligado (porta ${p})` : 'Pedido pela mesa na rede local desligado',
    });
  } catch { /* auditoria é extra */ }
  atualizar();
  return { ok: true, config: getConfig() };
}

/** IPv4 da rede da loja deste computador (sem virtuais óbvios), o "melhor" primeiro. */
function enderecosDaMaquina(interfaces = os.networkInterfaces()) {
  const lista = [];
  for (const [nome, ifs] of Object.entries(interfaces)) {
    for (const i of ifs || []) {
      if ((i.family !== 'IPv4' && i.family !== 4) || i.internal || i.address.startsWith('169.254.')) continue;
      const virtual = /virtual|vmware|vbox|hyper-v|vethernet|docker|wsl|loopback|tailscale|zerotier/i.test(nome);
      const privado = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address);
      lista.push({ ip: i.address, nota: (privado ? 2 : 0) + (virtual ? -3 : 0) + (i.address.startsWith('192.168.56.') ? -3 : 0) });
    }
  }
  return lista.sort((a, b) => b.nota - a.nota).map((x) => x.ip);
}

/** Só o servidor do grupo (onde ficam as mesas) ou o computador único da loja. */
function deveRodar(r = linha()) {
  if (r.ativo !== 1) return false;
  try {
    const sync = require('./syncStateService');
    return !sync.getGrupoSincronizacaoId() || sync.ehServidorDoGrupo();
  } catch { return true; }
}

// ------------------------------------------------------------ links e QR

function linkDaMesa(token, config = getConfig()) {
  if (!config.endereco || !TOKEN_MESA.test(String(token || ''))) return null;
  return `${config.endereco}/m/${token}`;
}

/** Texto do QR do Wi-Fi (padrão WIFI: que a câmera do celular entende). */
function textoQrWifi({ wifiNome, wifiSenha, wifiTipo }) {
  if (!wifiNome) return null;
  const esc = (v) => String(v || '').replace(/([\\;,:"])/g, '\\$1');
  return wifiTipo === 'nopass' ? `WIFI:T:nopass;S:${esc(wifiNome)};;` : `WIFI:T:${wifiTipo || 'WPA'};S:${esc(wifiNome)};P:${esc(wifiSenha)};;`;
}

// ------------------------------------------------------------ cardápio e pedido

function mesaPeloToken(token) {
  if (!TOKEN_MESA.test(String(token || ''))) return null;
  return getDb().prepare('SELECT * FROM restaurant_tables WHERE qr_token = ?').get(token) || null;
}

function rotuloMesa(m) { return m.nome ? String(m.nome).slice(0, 30) : `Mesa ${m.numero}`; }

function cardapio(token) {
  const mesa = mesaPeloToken(token);
  if (!mesa) return { ok: false, status: 404, error: 'Este QR de mesa não vale mais. Peça ajuda a um atendente.' };
  const db = getDb();
  const { itens } = require('./vitrineService').montarCatalogo();
  const comFoto = new Set(db.prepare("SELECT id FROM products WHERE ativo = 1 AND foto_path IS NOT NULL AND foto_path <> ''").all().map((p) => p.id));
  let nomeLoja = 'Cardápio';
  try { nomeLoja = require('./fiscalService').getNomeNegocio() || nomeLoja; } catch { /* sem nome */ }
  return {
    ok: true,
    loja: nomeLoja,
    mesa: rotuloMesa(mesa),
    produtos: itens.map((p) => ({ ...p, foto: comFoto.has(p.id) })),
  };
}

function limparTexto(valor, max) {
  return String(valor ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Cria o pedido da mesa (Separação). Mesma validação de itens da vitrine. */
function criarPedido({ token, pedidoId, nome, telefone, itens, observacao, aparelho } = {}) {
  const db = getDb();
  if (typeof pedidoId !== 'string' || !ID_PEDIDO.test(pedidoId)) return { ok: false, error: 'Pedido inválido.' };
  const ja = db.prepare('SELECT id FROM bot_orders WHERE canal = ? AND canal_ref = ?').get(CANAL, pedidoId);
  if (ja) return { ok: true, id: ja.id, jaExistia: true };
  let mesa = mesaPeloToken(token);
  if (!mesa) return { ok: false, error: 'Este QR de mesa não vale mais. Peça ajuda a um atendente.' };
  // Integrante da mesa: o pedido sai no nome (e celular) com que ele entrou.
  let membro = null;
  try { membro = membroDe(db, mesaEfetiva(db, mesa).id, aparelho); } catch { membro = null; }
  // "Só entregar aqui": a conta continua na outra mesa; o pedido vai para a
  // conta de lá, avisando onde entregar.
  let entregarEm = null;
  if (!membro && APARELHO.test(String(aparelho || ''))) {
    const aqui = mesaEfetiva(db, mesa);
    const ent = require('./mesaMudancaService').entregaAtiva(db, aparelho, aqui.id);
    const deLa = ent ? membroDe(db, ent.contaEm.id, aparelho) : null;
    if (deLa) { entregarEm = rotuloMesa(aqui); mesa = ent.contaEm; membro = deLa; }
  }
  if (membro) { nome = membro.nome; if (!telefone && membro.telefone) telefone = membro.telefone; }
  const nomeLimpo = limparTexto(nome, 60);
  if (nomeLimpo.length < 2) return { ok: false, error: 'Informe o seu nome.' };
  const vp = require('./vitrinePedidoService');
  const tel = telefone ? vp.telefoneValido(telefone) : null;
  if (telefone && String(telefone).trim() && !tel) return { ok: false, error: 'Confira o celular (DDD + número) ou deixe em branco.' };
  const validos = vp.itensValidos(itens).map((i) => (entregarEm
    ? { ...i, observacao: [`ENTREGAR NO ${entregarEm.toUpperCase()}`, i.observacao].filter(Boolean).join(' · ').slice(0, 200) } : i));
  if (!validos.length) return { ok: false, error: 'Nenhum produto do pedido está disponível agora.' };
  const esperando = db.prepare(`SELECT COUNT(*) AS n FROM bot_orders WHERE canal = ? AND status = 'novo' AND mesa_numero = ?`).get(CANAL, mesa.numero).n;
  if (esperando >= PEDIDOS_ESPERANDO_POR_MESA) return { ok: false, error: 'Esta mesa já tem pedidos esperando o atendente confirmar.' };

  const mesaRotulo = rotuloMesa(mesa);
  let orderId = null;
  try {
    db.transaction(() => {
      const obs = limparTexto(observacao, 200);
      const r = require('./botOrderService').createOrder({
        locationId: mesa.location_id, clienteNome: nomeLimpo, clienteTelefone: 'mesa-qr', tipoEntrega: 'retirada', endereco: null,
        observacoes: [entregarEm ? `ENTREGAR NO ${entregarEm.toUpperCase()} (a conta é da ${mesaRotulo})` : '',
          `Pedido pelo QR da ${mesaRotulo} (rede da loja). Paga na conta da mesa.`, obs ? `Obs.: ${obs}` : ''].filter(Boolean).join('\n'),
        origem: 'manual', itens: validos, mesaNumero: mesa.numero, consumoLocal: false,
      });
      if (!r.ok) throw new Error(r.error);
      db.prepare('UPDATE bot_orders SET canal = ?, canal_ref = ?, telefone_informado = ?, aparelho = ? WHERE id = ?')
        .run(CANAL, pedidoId, tel, /^[A-Za-z0-9]{16,40}$/.test(String(aparelho || '')) ? aparelho : null, r.id);
      orderId = r.id;
    })();
  } catch (err) {
    const ja2 = db.prepare('SELECT id FROM bot_orders WHERE canal = ? AND canal_ref = ?').get(CANAL, pedidoId);
    if (ja2) return { ok: true, id: ja2.id, jaExistia: true };
    return { ok: false, error: err?.message || 'Não foi possível registrar o pedido.' };
  }
  const total = db.prepare('SELECT COALESCE(SUM(preco_unitario * quantidade), 0) AS t FROM bot_order_items WHERE bot_order_id = ?').get(orderId).t;
  const automatico = vp.aceitarSozinhoSeMesaAberta(orderId);
  const resumo = { id: orderId, nome: nomeLimpo, mesa: mesaRotulo, total: Math.round(total * 100) / 100, itens: validos.length, modo: 'local' };
  try { require('./notificationService').notifyNewVitrineOrder({ ...resumo, demo: false, aceitoSozinho: automatico.aceito }); } catch { /* aviso é extra */ }
  vp.avisarTelas({ ...resumo, aceitoSozinho: automatico.aceito });
  return { ok: true, ...resumo, aceitoSozinho: automatico.aceito };
}

// ------------------------------------------------------------ integrantes da mesa
//
// Vários celulares na mesma mesa: cada um entra com o nome (celular opcional)
// e vira um integrante -- uma pessoa da comanda, com a conta dela. Mesa já
// aberta: entra na hora. Mesa livre: fica esperando e entra quando a mesa
// abrir (primeiro pedido aceito ou o garçom abrir). Mesa fechada/limpa: a
// lista zera (o próximo grupo começa do zero).

const APARELHO = /^[A-Za-z0-9]{16,40}$/;
const ESPERA_MAXIMA = '-6 hours'; // integrante esperando a mesa abrir

/** A mesa que vale para o QR: a principal (mesas unidas) ou para onde a comanda foi (transferida). */
function mesaEfetiva(db, mesa) {
  if (!mesa) return null;
  const tableService = require('./tableService');
  let m = mesa;
  if (m.unida_a_mesa_id) m = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(m.unida_a_mesa_id) || m;
  if (m.status === 'aguardando_limpeza') m = tableService.destinoDaTransferencia(db, m) || m;
  return m;
}

function vendaAberta(db, mesa) {
  if (!mesa || mesa.status !== 'ocupada' || !mesa.sale_id) return null;
  return db.prepare("SELECT id FROM sales WHERE id = ? AND status = 'aberta'").get(mesa.sale_id)?.id || null;
}

/** Coloca o integrante na comanda (pessoa da mesa, ligada ao cliente pelo celular). */
function incluirNaComanda(db, mesa, saleId, membro) {
  const bot = require('./botOrderService');
  const numero = bot.pessoaDoPedidoNaMesa(db, mesa.id, saleId, membro.nome, membro.aparelho);
  if (!numero) return null;
  if (membro.telefone) {
    try { bot.ligarPessoaAoCliente(db, { pedido: { id: null, telefone_informado: membro.telefone, cliente_nome: membro.nome }, tableId: mesa.id, pessoaNumero: numero }); } catch { /* extra */ }
  }
  db.prepare('UPDATE mesa_local_membros SET sale_id = ? WHERE table_id = ? AND aparelho = ?').run(saleId, membro.table_id, membro.aparelho);
  return numero;
}

/** Mesa acabou de abrir: quem estava esperando entra na comanda. */
function incluirMembrosPendentes(db, tableId, saleId) {
  try {
    const mesa = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(tableId);
    const pendentes = db.prepare(`SELECT * FROM mesa_local_membros WHERE table_id = ? AND sale_id IS NULL AND criado_em >= datetime('now', ?) ORDER BY criado_em`)
      .all(tableId, ESPERA_MAXIMA);
    for (const m of pendentes) incluirNaComanda(db, mesa, saleId, m);
    return pendentes.length;
  } catch { return 0; } // banco sem a tabela
}

/** Mesa fechou/liberou/foi limpa: a lista de integrantes zera. */
function esquecerMembros(db, tableIds) {
  try {
    const del = db.prepare('DELETE FROM mesa_local_membros WHERE table_id = ?');
    for (const id of tableIds) del.run(id);
  } catch { /* banco sem a tabela */ }
}

/** A mesa mudou de lugar: os integrantes vão junto. */
function moverMembros(db, deId, paraId) {
  try {
    db.prepare('DELETE FROM mesa_local_membros WHERE table_id = ? AND aparelho IN (SELECT aparelho FROM mesa_local_membros WHERE table_id = ?)').run(paraId, deId);
    db.prepare('UPDATE mesa_local_membros SET table_id = ? WHERE table_id = ?').run(paraId, deId);
  } catch { /* banco sem a tabela */ }
}

function membroDe(db, tableId, aparelho) {
  if (!APARELHO.test(String(aparelho || ''))) return null;
  return db.prepare(`SELECT * FROM mesa_local_membros WHERE table_id = ? AND aparelho = ?
                     AND (sale_id IS NOT NULL OR criado_em >= datetime('now', ?))`).get(tableId, aparelho, ESPERA_MAXIMA) || null;
}

/** O celular entra na mesa com o nome (e o celular, opcional). */
function entrarNaMesa({ token, aparelho, nome, telefone } = {}) {
  const db = getDb();
  const lida = mesaPeloToken(token);
  if (!lida) return { ok: false, status: 404, error: 'Este QR de mesa não vale mais. Peça ajuda a um atendente.' };
  if (!APARELHO.test(String(aparelho || ''))) return { ok: false, error: 'Atualize a página e tente de novo.' };
  const nomeLimpo = limparTexto(nome, 40);
  if (nomeLimpo.length < 2) return { ok: false, error: 'Informe o seu nome.' };
  const vp = require('./vitrinePedidoService');
  const tel = telefone && String(telefone).trim() ? vp.telefoneValido(telefone) : null;
  if (telefone && String(telefone).trim() && !tel) return { ok: false, error: 'Confira o celular (DDD + número) ou deixe em branco.' };
  const mesa = mesaEfetiva(db, lida);
  const ja = membroDe(db, mesa.id, aparelho);
  if (!ja && db.prepare(`SELECT COUNT(*) AS n FROM mesa_local_membros WHERE table_id = ? AND (sale_id IS NOT NULL OR criado_em >= datetime('now', ?))`).get(mesa.id, ESPERA_MAXIMA).n >= 30) {
    return { ok: false, error: 'Esta mesa já está cheia de celulares. Peça ajuda a um atendente.' };
  }
  const saleId = vendaAberta(db, mesa);
  db.transaction(() => {
    if (ja) {
      // Já é integrante: só atualiza o celular (o nome na comanda fica como está).
      db.prepare('UPDATE mesa_local_membros SET telefone = COALESCE(?, telefone) WHERE table_id = ? AND aparelho = ?').run(tel, mesa.id, aparelho);
    } else {
      db.prepare('DELETE FROM mesa_local_membros WHERE table_id = ? AND aparelho = ?').run(mesa.id, aparelho);
      db.prepare('INSERT INTO mesa_local_membros (table_id, aparelho, nome, telefone) VALUES (?, ?, ?, ?)').run(mesa.id, aparelho, nomeLimpo, tel);
    }
    const membro = db.prepare('SELECT * FROM mesa_local_membros WHERE table_id = ? AND aparelho = ?').get(mesa.id, aparelho);
    if (saleId && membro.sale_id !== saleId) incluirNaComanda(db, mesa, saleId, membro);
  })();
  if (!ja) {
    try { require('./mesaCelularService').avisarTelas?.({ tipo: 'pessoas', mesaId: mesa.id }); } catch { /* extra */ }
    avisarChamado({ tipo: 'entrou', mesa: rotuloMesa(mesa), nome: nomeLimpo, mesaId: mesa.id });
  }
  return { ok: true, ...estadoDaMesa(token, aparelho) };
}

/**
 * O que o celular vê da mesa: quem está nela, o que ele pediu (a conta dele)
 * e o total da mesa. Só com o segredo do QR certo.
 */
function estadoDaMesa(token, aparelho) {
  const db = getDb();
  const lida = mesaPeloToken(token);
  if (!lida) return null;
  const aqui = mesaEfetiva(db, lida);
  const mud = require('./mesaMudancaService');
  const valido = APARELHO.test(String(aparelho || ''));
  // Integrante de OUTRA mesa que leu este QR: "só entregar aqui" mostra a conta
  // de lá; senão a página pergunta o que ele quer (mudar a conta, entregar aqui).
  if (valido && !membroDe(db, aqui.id, aparelho)) {
    const ent = mud.entregaAtiva(db, aparelho, aqui.id);
    if (ent && membroDe(db, ent.contaEm.id, aparelho)) {
      return { ...estadoDe(db, ent.contaEm, aparelho), mesa: rotuloMesa(aqui), contaEm: rotuloMesa(ent.contaEm), entregarAqui: true, mudanca: resumoMudanca(ent.mudanca) };
    }
    const outra = mud.mesaDoCelular(db, aparelho, aqui.id);
    if (outra) {
      return { ...estadoDe(db, aqui, aparelho), outraMesa: rotuloMesa(outra), mudanca: resumoMudanca(mud.mudancaDoCelular(db, aparelho, aqui.id)) };
    }
  }
  const e = estadoDe(db, aqui, aparelho);
  const ultima = valido ? mud.mudancaDoCelular(db, aparelho, aqui.id) : null;
  return ultima && ultima.status === 'aprovada' ? { ...e, mudanca: resumoMudanca(ultima) } : e;
}

function resumoMudanca(m) {
  return m ? { id: m.id, tipo: m.tipo, status: m.status, erro: m.erro || null } : null;
}

function estadoDe(db, mesa, aparelho) {
  const saleId = vendaAberta(db, mesa);
  const membro = membroDe(db, mesa.id, aparelho);
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  let integrantes;
  let eu = membro ? { nome: membro.nome, numero: null } : null;
  let meusItens = [];
  let totalMesa = 0;
  if (saleId) {
    integrantes = db.prepare('SELECT numero, nome, aparelho FROM sale_people WHERE sale_id = ? AND nome IS NOT NULL ORDER BY numero').all(saleId)
      .map((p) => ({ nome: p.nome, eu: !!membro && p.aparelho === membro.aparelho }));
    // Integrante que entrou e ainda não está na comanda (corrida rara): aparece também.
    const naComanda = db.prepare('SELECT numero, nome FROM sale_people WHERE sale_id = ? AND aparelho = ?').get(saleId, membro?.aparelho || '-');
    if (membro && naComanda) eu = { nome: naComanda.nome, numero: naComanda.numero };
    if (eu?.numero) {
      meusItens = db.prepare(`SELECT COALESCE(si.nome_personalizado, p.nome) AS nome, SUM(si.quantidade) AS quantidade, SUM(si.quantidade * si.preco_unitario) AS total
                              FROM sale_items si JOIN products p ON p.id = si.product_id
                              WHERE si.sale_id = ? AND si.pessoa_numero = ? AND si.cancelado = 0
                              GROUP BY si.product_id, COALESCE(si.nome_personalizado, p.nome) ORDER BY MIN(si.criado_em)`).all(saleId, eu.numero)
        .map((i) => ({ nome: i.nome, quantidade: i.quantidade, total: r2(i.total) }));
    }
    totalMesa = r2(db.prepare('SELECT COALESCE(SUM(quantidade * preco_unitario), 0) AS t FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(saleId).t);
  } else {
    integrantes = db.prepare(`SELECT nome, aparelho FROM mesa_local_membros WHERE table_id = ? AND criado_em >= datetime('now', ?) ORDER BY criado_em`).all(mesa.id, ESPERA_MAXIMA)
      .map((p) => ({ nome: p.nome, eu: !!membro && p.aparelho === membro.aparelho }));
  }
  const esperando = membro
    ? db.prepare(`SELECT COUNT(*) AS n FROM bot_orders WHERE canal = ? AND status IN ('novo','em_separacao') AND aparelho = ?`).get(CANAL, membro.aparelho).n
    : 0;
  return {
    mesa: rotuloMesa(mesa), aberta: !!saleId, integrantes, eu,
    meusItens, meuTotal: r2(meusItens.reduce((s, i) => s + i.total, 0)), totalMesa, pedidosEsperando: esperando,
  };
}

// Chamar o garçom / pedir a conta: no máximo 1 por minuto por celular e tipo.
const ultimoChamado = new Map();
const TIPOS_CHAMADO = { garcom: 'chama o garçom', conta: 'pede a conta' };

function chamar({ token, aparelho, tipo, ip = null } = {}) {
  const db = getDb();
  const lida = mesaPeloToken(token);
  if (!lida) return { ok: false, status: 404, error: 'Este QR de mesa não vale mais.' };
  if (!TIPOS_CHAMADO[tipo]) return { ok: false, error: 'Pedido inválido.' };
  let mesa = mesaEfetiva(db, lida);
  let membro = membroDe(db, mesa.id, aparelho);
  if (!membro && APARELHO.test(String(aparelho || ''))) {
    // "Só entregar aqui": é integrante da mesa onde está a conta; a conta é pedida lá.
    const ent = require('./mesaMudancaService').entregaAtiva(db, aparelho, mesa.id);
    if (ent) { membro = membroDe(db, ent.contaEm.id, aparelho); if (tipo === 'conta' && membro) mesa = ent.contaEm; }
  }
  // Chamar o garçom não precisa de nome (qualquer um na mesa chama); pedir a
  // conta é de quem entrou na mesa.
  if (!membro && tipo !== 'garcom') return { ok: false, error: 'Entre na mesa com o seu nome primeiro.' };
  const quem = APARELHO.test(String(aparelho || '')) ? aparelho : `ip:${ip || '?'}`;
  const chave = `${mesa.id}:${quem}:${tipo}`;
  const agora = Date.now();
  if (agora - (ultimoChamado.get(chave) || 0) < 60000) return { ok: true, repetido: true };
  ultimoChamado.set(chave, agora);
  if (ultimoChamado.size > 2000) ultimoChamado.clear();
  // Fica marcado no quadrado da mesa até alguém atender. Um chamado aberto
  // por tipo e mesa: chamar de novo só atualiza quem chamou e a hora.
  try {
    const aberto = db.prepare('SELECT id FROM mesa_chamados WHERE table_id = ? AND tipo = ? AND atendido_em IS NULL').get(mesa.id, tipo);
    const nome = membro?.nome || null;
    if (aberto) db.prepare("UPDATE mesa_chamados SET nome = COALESCE(?, nome), criado_em = datetime('now') WHERE id = ?").run(nome, aberto.id);
    else db.prepare('INSERT INTO mesa_chamados (id, table_id, tipo, nome) VALUES (?, ?, ?, ?)').run(require('crypto').randomUUID(), mesa.id, tipo, nome);
  } catch { /* banco sem a tabela */ }
  avisarChamado({ tipo, mesa: rotuloMesa(mesa), nome: membro?.nome || null, mesaId: mesa.id });
  return { ok: true };
}

/** Alguém atendeu a mesa: tira os chamados do quadrado (grupo inteiro de mesas unidas). */
function atenderChamados({ tableId, usuarioId = null, tipo = null } = {}) {
  const db = getDb();
  const lida = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(tableId);
  if (!lida) return { ok: false, error: 'Mesa não encontrada.' };
  const principal = lida.unida_a_mesa_id ? (db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(lida.unida_a_mesa_id) || lida) : lida;
  const ids = db.prepare('SELECT id FROM restaurant_tables WHERE id = ? OR unida_a_mesa_id = ?').all(principal.id, principal.id).map((m) => m.id);
  let n = 0;
  try {
    const upd = db.prepare(`UPDATE mesa_chamados SET atendido_em = datetime('now'), atendido_por = ? WHERE table_id = ? AND atendido_em IS NULL ${tipo ? 'AND tipo = ?' : ''}`);
    for (const id of ids) n += upd.run(...(tipo ? [usuarioId, id, tipo] : [usuarioId, id])).changes;
  } catch { /* banco sem a tabela */ }
  return { ok: true, atendidos: n };
}

/**
 * O que aparece no quadrado de cada mesa (só nas principais): chamados
 * abertos, pedidos do QR esperando o atendente, quantos celulares estão nela.
 */
function indicadoresDasMesas(db, mesas) {
  const mapa = new Map();
  const de = (id) => { if (!mapa.has(id)) mapa.set(id, { chamados: [], pedidosEsperando: 0, noQr: 0, mudancas: [], chegando: [] }); return mapa.get(id); };
  const principalDe = new Map(mesas.map((m) => [m.id, m.unida_a_mesa_id || m.id]));
  const porNumero = new Map(mesas.map((m) => [`${m.location_id}|${m.numero}`, m]));
  try {
    for (const c of db.prepare(`SELECT table_id, tipo, nome, criado_em FROM mesa_chamados WHERE atendido_em IS NULL AND criado_em >= datetime('now', '-3 hours') ORDER BY criado_em`).all()) {
      const p = principalDe.get(c.table_id);
      if (p) de(p).chamados.push({ tipo: c.tipo, nome: c.nome, desde: c.criado_em });
    }
  } catch { /* banco sem a tabela */ }
  // Pedidos de mudança de mesa pelo celular, esperando o caixa aprovar.
  for (const m of require('./mesaMudancaService').mudancasPendentes(db)) {
    const origem = principalDe.get(m.de_table_id);
    const destino = principalDe.get(m.para_table_id);
    const rot = (nome, numero) => nome || `Mesa ${numero}`;
    if (origem) de(origem).mudancas.push({ id: m.id, nome: m.nome, tipo: m.tipo, para: rot(m.para_nome, m.para_numero) });
    if (destino) de(destino).chegando.push({ id: m.id, nome: m.nome, tipo: m.tipo, de: rot(m.de_nome, m.de_numero) });
  }
  try {
    for (const b of db.prepare(`SELECT location_id, mesa_numero, COUNT(*) AS n FROM bot_orders WHERE mesa_numero IS NOT NULL AND status = 'novo' GROUP BY location_id, mesa_numero`).all()) {
      const m = porNumero.get(`${b.location_id}|${b.mesa_numero}`);
      if (m) de(principalDe.get(m.id)).pedidosEsperando += b.n;
    }
  } catch { /* sem pedidos */ }
  try {
    const abertas = mesas.filter((m) => !m.unida_a_mesa_id && m.status === 'ocupada' && m.sale_id);
    const contar = db.prepare('SELECT COUNT(*) AS n FROM sale_people WHERE sale_id = ? AND aparelho IS NOT NULL');
    for (const m of abertas) { const n = contar.get(m.sale_id).n; if (n) de(m.id).noQr = n; }
    for (const r of db.prepare(`SELECT table_id, COUNT(*) AS n FROM mesa_local_membros WHERE sale_id IS NULL AND criado_em >= datetime('now', ?) GROUP BY table_id`).all(ESPERA_MAXIMA)) {
      const p = principalDe.get(r.table_id);
      if (p) de(p).noQr += r.n;
    }
  } catch { /* banco sem a tabela */ }
  return mapa;
}

/** Aviso nas telas do computador e dos caixas apontados (AppShell mostra e toca). */
function avisarChamado({ tipo, mesa, nome, mesaId = null }) {
  const texto = tipo === 'entrou' ? `${nome} entrou na ${mesa} pelo QR`
    : nome ? `${mesa}: ${nome} ${TIPOS_CHAMADO[tipo]}` : `${mesa}: ${tipo === 'conta' ? 'pediram a conta' : 'chamando o garçom'}`;
  require('./avisosDoServidor').registrar('mesa:chamado', { tipo, mesa, nome, texto, mesaId });
  if (tipo !== 'entrou') {
    try {
      const { Notification } = require('electron');
      if (Notification?.isSupported?.()) new Notification({ title: tipo === 'conta' ? 'Pediram a conta' : 'Chamando o garçom', body: texto }).show();
    } catch { /* sem notificação do sistema */ }
  }
  return texto;
}

/** Andamento do pedido para a página (só com o segredo da mesa certo). */
function andamento(token, pedidoId) {
  const mesa = mesaPeloToken(token);
  if (!mesa || !ID_PEDIDO.test(String(pedidoId || ''))) return null;
  const db = getDb();
  const p = db.prepare('SELECT * FROM bot_orders WHERE canal = ? AND canal_ref = ? AND mesa_numero = ?').get(CANAL, pedidoId, mesa.numero);
  if (!p) return null;
  const etapa = p.status === 'cancelado' ? 'cancelado' : (p.status === 'concluido' ? 'na_mesa' : 'recebido');
  return { etapa, mesa: rotuloMesa(mesa) };
}

// ------------------------------------------------------------ servidor HTTP

function responder(res, status, corpo, tipo = 'application/json; charset=utf-8') {
  const dados = typeof corpo === 'string' || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': tipo, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(dados);
}

function passouDoLimite(ip) {
  const agora = Date.now();
  const lista = (estado.porIp.get(ip) || []).filter((t) => agora - t < 60000);
  if (lista.length >= PEDIDOS_POR_MINUTO_POR_IP) { estado.porIp.set(ip, lista); return true; }
  lista.push(agora);
  estado.porIp.set(ip, lista);
  if (estado.porIp.size > 2000) estado.porIp.clear();
  return false;
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > MAX_CORPO) { reject(new Error('grande')); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(partes).toString('utf8') || '{}')); } catch { reject(new Error('json')); } });
    req.on('error', reject);
  });
}

function fotoDoProduto(id) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(id || ''))) return null;
  const p = getDb().prepare('SELECT foto_path FROM products WHERE id = ? AND ativo = 1').get(id);
  if (!p?.foto_path) return null;
  let base;
  try { base = path.resolve(require('./productService').fotosDir()); } catch { return null; }
  const alvo = path.resolve(String(p.foto_path));
  if (!alvo.startsWith(base + path.sep) || !fs.existsSync(alvo)) return null;
  return { arquivo: alvo, tipo: /\.png$/i.test(alvo) ? 'image/png' : /\.webp$/i.test(alvo) ? 'image/webp' : 'image/jpeg' };
}

async function atender(req, res) {
  try {
    const url = new URL(req.url, 'http://local');
    const caminho = url.pathname;
    if (req.method === 'GET' && (caminho === '/' || caminho === '/favicon.ico')) {
      return responder(res, caminho === '/' ? 200 : 404, require('./mesaLocalPagina').paginaSemMesa(), 'text/html; charset=utf-8');
    }
    const m = caminho.match(/^\/m\/([A-Za-z0-9]{24})\/?$/);
    if (req.method === 'GET' && m) {
      const mesa = mesaPeloToken(m[1]);
      return responder(res, mesa ? 200 : 404, require('./mesaLocalPagina').paginaDaMesa({ valida: !!mesa }), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && caminho === '/api/cardapio') {
      const r = cardapio(url.searchParams.get('m'));
      return responder(res, r.ok ? 200 : (r.status || 400), r);
    }
    const f = caminho.match(/^\/api\/foto\/([A-Za-z0-9-]{8,64})$/);
    if (req.method === 'GET' && f) {
      const foto = fotoDoProduto(f[1]);
      if (!foto) return responder(res, 404, { ok: false });
      return responder(res, 200, fs.readFileSync(foto.arquivo), foto.tipo);
    }
    if (req.method === 'GET' && caminho === '/api/pedido') {
      const a = andamento(url.searchParams.get('m'), url.searchParams.get('id'));
      return responder(res, a ? 200 : 404, a ? { ok: true, ...a } : { ok: false });
    }
    if (req.method === 'GET' && caminho === '/api/mesa') {
      const e = estadoDaMesa(url.searchParams.get('m'), url.searchParams.get('a'));
      return responder(res, e ? 200 : 404, e ? { ok: true, ...e } : { ok: false });
    }
    if (req.method === 'POST' && caminho === '/api/mudar') {
      const ip = req.socket?.remoteAddress || '?';
      if (passouDoLimite(ip)) return responder(res, 429, { ok: false, error: 'Muitos pedidos seguidos deste celular. Espere um minuto.' });
      let corpo;
      try { corpo = await lerCorpo(req); } catch { return responder(res, 400, { ok: false, error: 'Pedido inválido.' }); }
      const lida = mesaPeloToken(corpo.m);
      if (!lida) return responder(res, 404, { ok: false, error: 'Este QR de mesa não vale mais.' });
      if (!APARELHO.test(String(corpo.aparelho || ''))) return responder(res, 400, { ok: false, error: 'Atualize a página e tente de novo.' });
      const r = require('./mesaMudancaService').pedirMudanca({ paraMesa: mesaEfetiva(getDb(), lida), aparelho: corpo.aparelho, tipo: corpo.tipo });
      return responder(res, r.ok ? 200 : 400, r.ok ? { ok: true, ...estadoDaMesa(corpo.m, corpo.aparelho) } : r);
    }
    if (req.method === 'POST' && (caminho === '/api/entrar' || caminho === '/api/chamar')) {
      const ip = req.socket?.remoteAddress || '?';
      if (passouDoLimite(ip)) return responder(res, 429, { ok: false, error: 'Muitos pedidos seguidos deste celular. Espere um minuto.' });
      let corpo;
      try { corpo = await lerCorpo(req); } catch { return responder(res, 400, { ok: false, error: 'Pedido inválido.' }); }
      const r = caminho === '/api/entrar'
        ? entrarNaMesa({ token: corpo.m, aparelho: corpo.aparelho, nome: corpo.nome, telefone: corpo.telefone })
        : chamar({ token: corpo.m, aparelho: corpo.aparelho, tipo: corpo.tipo, ip });
      return responder(res, r.ok ? 200 : (r.status || 400), r);
    }
    if (req.method === 'POST' && caminho === '/api/pedido') {
      const ip = req.socket?.remoteAddress || '?';
      if (passouDoLimite(ip)) return responder(res, 429, { ok: false, error: 'Muitos pedidos seguidos deste celular. Espere um minuto.' });
      let corpo;
      try { corpo = await lerCorpo(req); } catch { return responder(res, 400, { ok: false, error: 'Pedido inválido.' }); }
      const r = criarPedido({ token: corpo.m, pedidoId: corpo.id, nome: corpo.nome, telefone: corpo.telefone, itens: corpo.itens, observacao: corpo.observacao, aparelho: corpo.aparelho });
      return responder(res, r.ok ? 200 : 400, r.ok ? { ok: true, id: r.id, aceitoSozinho: !!r.aceitoSozinho, total: r.total } : r);
    }
    return responder(res, 404, { ok: false });
  } catch (err) {
    console.error('[mesaLocal] erro ao atender', err?.message || err);
    return responder(res, 500, { ok: false, error: 'Erro no servidor da loja.' });
  }
}

function iniciar(porta = getConfig().porta) {
  // Ligando agora na mesma porta: espera a mesma partida (salvar + o ciclo de
  // 1 minuto não abrem dois servidores).
  if (estado.ligando && estado.ligando.porta === porta) return estado.ligando.promessa;
  if (estado.servidor && (estado.porta === porta || porta === 0)) return Promise.resolve({ ok: true, porta: estado.porta });
  parar();
  const promessa = new Promise((resolve) => {
    const srv = http.createServer((req, res) => { atender(req, res); });
    srv.on('error', (err) => {
      estado.erro = err?.code === 'EADDRINUSE' ? `A porta ${porta} já está em uso neste computador.` : (err?.message || String(err));
      if (estado.ligando?.srv === srv) estado.ligando = null;
      try { srv.close(); } catch { /* não chegou a abrir */ }
      resolve({ ok: false, error: estado.erro });
    });
    srv.listen(porta, '0.0.0.0', () => {
      if (estado.ligando?.srv !== srv) { srv.close(); resolve({ ok: false, error: 'cancelado' }); return; } // parar() no meio
      estado.ligando = null;
      estado.servidor = srv;
      estado.porta = srv.address().port;
      estado.erro = null;
      resolve({ ok: true, porta: estado.porta });
    });
    estado.ligando = { porta, srv, promessa: null };
  });
  if (estado.ligando) estado.ligando.promessa = promessa;
  return promessa;
}

function parar() {
  if (estado.ligando) { const { srv } = estado.ligando; estado.ligando = null; try { srv.close(); } catch { /* ainda não abriu */ } }
  if (estado.servidor) { try { estado.servidor.close(); estado.servidor.closeAllConnections?.(); } catch { /* já fechado */ } }
  estado.servidor = null;
  estado.porta = null;
}

/** Liga/desliga conforme a configuração e o papel no grupo (na inicialização e ao salvar). */
function atualizar() {
  try {
    if (deveRodar()) return iniciar();
    parar();
  } catch (err) {
    console.error('[mesaLocal] não consegui atualizar', err?.message || err);
  }
  return Promise.resolve({ ok: true });
}

function status() {
  const config = getConfig();
  return {
    ...config, rodando: !!estado.servidor, portaEmUso: estado.porta, erro: estado.erro,
    enderecos: enderecosDaMaquina(), deveRodar: deveRodar(),
  };
}

module.exports = {
  CANAL, PORTA_PADRAO, getConfig, saveConfig, enderecosDaMaquina, linkDaMesa, textoQrWifi, cardapio, criarPedido, andamento,
  entrarNaMesa, estadoDaMesa, chamar, atenderChamados, indicadoresDasMesas, incluirMembrosPendentes, esquecerMembros, moverMembros, status,
  iniciar, parar, atualizar, atender, deveRodar,
};
