const { randomUUID, generateKeyPairSync, privateDecrypt, constants, createHash } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Mesas pelo celular (PWA, pwa-mobile/src/mesas) -- garçom e operador.
 *
 * O celular nunca toca neste SQLite. Duas mãos, pelo Firestore:
 *
 *  1) PUBLICAÇÃO (computador -> celular), só quando o conteúdo muda:
 *       installations/{id}/mesas_ao_vivo/atual
 *         todas as mesas (status, total, quem abriu, unidas) + o que o
 *         celular precisa para montar a tela (caixa aberto, quem pode
 *         autorizar, chave pública para cifrar o PIN). Leva também um
 *         "sinal de vida" a cada 30 s.
 *       installations/{id}/comandas_mesa/{mesaPrincipalId}
 *         a comanda de cada mesa ocupada: itens com pessoa, observação e
 *         status da cozinha, pessoas, e a conta (total, pago, por pessoa).
 *     A leitura exige celular pareado e ativo com o módulo pago (regras
 *     do Firestore): nomes das pessoas da mesa são dado pessoal.
 *
 *  2) COMANDOS (celular -> computador): installations/{id}/comandos_mesa/{id}
 *       { dispositivoUid, tipo, mesaId, ..., status: 'novo' }
 *     O computador confere o celular e o papel ATUAL de quem está ligado a
 *     ele, aplica pelos MESMOS serviços da tela do computador (tableService,
 *     saleService) e responde no mesmo documento. Cada comando vale UMA vez:
 *     o resultado fica em `mobile_comandos_mesa` na mesma transação do que
 *     ele mudou -- reentrega devolve o resultado guardado.
 *
 * Quem pode o quê (o computador decide, o celular só esconde botão):
 *   - garçom, operador, gerente, admin, suporte: abrir mesa, lançar itens
 *     (com pessoa e observação), pessoas, mover item, observação, cancelar
 *     item (a regra de autorização é a do computador: Configurações →
 *     Segurança), marcar mesa limpa;
 *   - operador para cima: juntar, separar e transferir mesas;
 *   - celular de PDV móvel com venda ligada e papel que vende: receber
 *     (mesa inteira ou por pessoa) e taxa de serviço. O dinheiro entra no
 *     caixa aberto DESTE computador, igual à venda do PDV móvel.
 *
 * "Lançar" pode ficar na fila do celular sem internet (o SDK do Firestore
 * guarda e envia depois): vale até 12 h. Os demais precisam de resposta na
 * hora: se chegarem atrasados (celular estava sem internet, ou o computador
 * fechado por mais de 10 min), são recusados e a pessoa confere e refaz.
 */

const PAPEIS_MESA = ['garcom', 'operador', 'gerente', 'admin', 'suporte'];
const PAPEIS_ORGANIZAR = ['operador', 'gerente', 'admin', 'suporte'];
const PAPEIS_QUE_VENDEM = ['operador', 'gerente', 'admin', 'suporte'];
const PAPEIS_AUTORIZAM = ['gerente', 'admin', 'suporte'];
const METODOS_MESA = ['dinheiro', 'cartao_credito', 'cartao_debito', 'pix'];

const VALIDADE_LANCAR_MS = 12 * 60 * 60 * 1000;
const VALIDADE_MS = 10 * 60 * 1000;
const ATRASO_TOLERADO_MS = 5 * 60 * 1000;
const LIMITE_ITENS = 100;
const LIMITE_PAGAMENTOS = 10;
const QUANTIDADE_MAXIMA = 1000;
const LIMITE_PESSOAS = 200;
const TOLERANCIA = 0.009;

const TIPOS = [
  'abrir', 'lancar', 'adicionar_pessoa', 'renomear_pessoa', 'remover_pessoa', 'mover_item', 'observacao_item',
  'cancelar_item', 'limpar_mesa', 'juntar', 'separar', 'transferir', 'taxa_servico', 'receber', 'meu_turno',
];
// Leitura pura: não grava resultado (nada mudou).
const TIPOS_SO_LEITURA = ['meu_turno'];

class ErroComando extends Error {
  constructor(mensagem, extra = null) {
    super(mensagem);
    this.extra = extra;
  }
}

const centavos = (v) => Math.round((Number(v) || 0) * 100);
const reais = (c) => Math.round(c) / 100;
const arred2 = (v) => reais(centavos(v));

function texto(valor, max) {
  return String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function locationIdAtual(db) {
  const location = db.prepare('SELECT id FROM locations LIMIT 1').get();
  if (!location) throw new ErroComando('Nenhum local cadastrado neste computador.');
  return location.id;
}

// ------------------------------------------------------------------ chave do PIN

/** Par RSA deste computador (gerado na primeira vez). A pública vai para o
 * celular cifrar o PIN do gerente; a privada nunca sai daqui. */
function obterChave(db = getDb()) {
  let row = db.prepare(`SELECT * FROM celular_chaves WHERE id = 'pin'`).get();
  if (!row) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    db.prepare(`INSERT OR IGNORE INTO celular_chaves (id, chave_publica, chave_privada) VALUES ('pin', ?, ?)`)
      .run(publicKey.toString('base64'), privateKey);
    row = db.prepare(`SELECT * FROM celular_chaves WHERE id = 'pin'`).get();
  }
  return row;
}

/** PIN cifrado pelo celular (RSA-OAEP com SHA-256, WebCrypto) -> texto. */
function decifrarPin(cifrado, db = getDb()) {
  if (typeof cifrado !== 'string' || !cifrado || cifrado.length > 1024) throw new ErroComando('Autorização inválida. Digite o PIN de novo.');
  try {
    const pin = privateDecrypt(
      { key: obterChave(db).chave_privada, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(cifrado, 'base64'),
    ).toString('utf8');
    if (!/^\d{4,8}$/.test(pin)) throw new Error('formato');
    return pin;
  } catch {
    throw new ErroComando('Não deu para conferir o PIN (o app do celular pode estar desatualizado). Feche e abra o app e tente de novo.');
  }
}

// ------------------------------------------------------------------ quem pede

/** Celular (garçom ou PDV móvel) ativo + usuário ativo + módulo pago ligado.
 * `exigeMesas: false` só para o resumo do turno, que não mexe em mesa. */
function autorizar(uid, { exigeMesas = true } = {}) {
  if (!uid || typeof uid !== 'string') throw new ErroComando('Celular não reconhecido nesta loja.');
  const db = getDb();
  const d = db.prepare(
    `SELECT pd.*, u.nome AS vinculo_nome, u.role AS vinculo_role, u.ativo AS vinculo_ativo
     FROM paired_devices pd JOIN users u ON u.id = pd.vinculo_user_id
     WHERE pd.id = ? AND pd.tipo IN ('garcom', 'pdv') AND pd.ativo = 1`
  ).get(uid);
  if (!d) throw new ErroComando('Celular não reconhecido ou desconectado desta loja.');
  if (d.vinculo_ativo !== 1) throw new ErroComando('O usuário ligado a este celular está desativado.');
  if (!PAPEIS_MESA.includes(d.vinculo_role)) throw new ErroComando('O usuário ligado a este celular não atende mesas.');
  const modulosPagos = require('./modulosPagosService');
  if (d.tipo === 'garcom' && !modulosPagos.moduloAtivo('appGarcom')) throw new ErroComando('O módulo "App do garçom" não está ativo nesta loja.');
  if (d.tipo === 'pdv') {
    if (!modulosPagos.moduloAtivo('pdvMobile')) throw new ErroComando('O módulo "PDV móvel" não está ativo nesta loja.');
    if (exigeMesas && !require('./pdvMobileConfigService').getConfig().permitirMesas) {
      throw new ErroComando('Mesas pelo celular está desligado nesta loja (Configurações → Celular).');
    }
  }
  return {
    dispositivo: { id: d.id, tipo: d.tipo },
    usuario: { id: d.vinculo_user_id, nome: d.vinculo_nome, role: d.vinculo_role },
  };
}

function exigirPapel(ctx, papeis, mensagem) {
  if (!papeis.includes(ctx.usuario.role)) throw new ErroComando(mensagem);
}

function exigirRecebimento(ctx) {
  if (ctx.dispositivo.tipo !== 'pdv') throw new ErroComando('Receber a conta é só pelo celular de PDV móvel (o do garçom só lança).');
  exigirPapel(ctx, PAPEIS_QUE_VENDEM, 'O usuário ligado a este celular não pode receber pagamentos.');
  if (!require('./pdvMobileConfigService').getConfig().permitirVenda) {
    throw new ErroComando('Receber pelo celular está desligado nesta loja (Configurações → Celular).');
  }
}

// ------------------------------------------------------------------ mesas e comanda

function rotuloMesa(t) {
  return t.nome || `Mesa ${t.numero}`;
}

/** Mesa do comando + a principal do grupo dela (se estiver unida). */
function mesaDoComando(db, mesaId, locationId) {
  const id = texto(mesaId, 80);
  const mesa = id ? db.prepare('SELECT * FROM restaurant_tables WHERE id = ? AND location_id = ?').get(id, locationId) : null;
  if (!mesa) throw new ErroComando('Mesa não encontrada (pode ter sido excluída no computador).');
  const principal = mesa.unida_a_mesa_id
    ? db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(mesa.unida_a_mesa_id) || mesa
    : mesa;
  return { mesa, principal };
}

/** Comanda aberta da mesa (qualquer mesa do grupo). */
function comandaAberta(db, mesaId, locationId) {
  const { mesa, principal } = mesaDoComando(db, mesaId, locationId);
  if (principal.status !== 'ocupada' || !principal.sale_id) throw new ErroComando(`${rotuloMesa(mesa)} não está ocupada.`);
  const venda = db.prepare('SELECT * FROM sales WHERE id = ?').get(principal.sale_id);
  if (!venda || venda.status !== 'aberta') throw new ErroComando(`A comanda de ${rotuloMesa(principal)} não está mais aberta.`);
  return { mesa, principal, saleId: principal.sale_id, venda };
}

function totalDePessoas(db, saleId, pessoasDaMesa) {
  const comNome = db.prepare('SELECT MAX(numero) AS m FROM sale_people WHERE sale_id = ?').get(saleId).m || 0;
  const comItem = db.prepare('SELECT MAX(pessoa_numero) AS m FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(saleId).m || 0;
  return Math.max(Number(pessoasDaMesa) || 0, comNome, comItem);
}

function itemDaComanda(db, saleId, itemId) {
  const id = texto(itemId, 80);
  const item = id ? db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(id, saleId) : null;
  if (!item || item.cancelado) throw new ErroComando('Item não encontrado nesta comanda (pode ter sido cancelado).');
  return item;
}

function temPagamento(db, saleId) {
  return db.prepare('SELECT COUNT(*) AS c FROM payments WHERE sale_id = ?').get(saleId).c > 0;
}

function lerDetalhes(json) {
  try { return JSON.parse(json || '{}') || {}; } catch { return {}; }
}

/**
 * A conta da comanda, dividida em grupos: uma por pessoa ('p<N>') e
 * 'mesa' (itens sem pessoa). Valor de cada grupo = subtotal dele com a
 * mesma proporção de desconto e taxa de serviço da conta inteira; o
 * centavo que sobra do arredondamento vai para o maior grupo, então a
 * soma dos grupos é sempre o total a pagar.
 *
 * Pago por grupo: o que os recebimentos pelo celular atribuíram a ele
 * (payments.detalhes.grupos). Pagamento feito no computador (sem grupo)
 * abate de todos, na proporção do que cada um ainda deve. A soma do que
 * cada grupo deve é sempre o que falta na conta.
 */
function calcularConta(db, saleId) {
  const venda = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  const principal = db.prepare('SELECT * FROM restaurant_tables WHERE sale_id = ? AND unida_a_mesa_id IS NULL').get(saleId);
  const itens = db.prepare('SELECT pessoa_numero, preco_unitario, quantidade FROM sale_items WHERE sale_id = ? AND cancelado = 0').all(saleId);
  const nomes = new Map(db.prepare('SELECT numero, nome FROM sale_people WHERE sale_id = ?').all(saleId).map((p) => [p.numero, p.nome]));
  const totalPessoas = totalDePessoas(db, saleId, principal?.pessoas);

  const subtotalPorGrupo = new Map();
  for (const i of itens) {
    const g = i.pessoa_numero ? `p${i.pessoa_numero}` : 'mesa';
    subtotalPorGrupo.set(g, (subtotalPorGrupo.get(g) || 0) + centavos(i.preco_unitario * i.quantidade));
  }
  const subtotal = [...subtotalPorGrupo.values()].reduce((a, b) => a + b, 0);
  const subtotalComDesconto = (venda.total || 0) - (venda.desconto || 0) - (venda.desconto_gerente || 0);
  const taxa = Number(venda.taxa_servico_percentual) || 0;
  // Mesma conta de saleService.finalizeSale. Arredonda para centavos sem
  // ficar abaixo do que ele exige (paga - 0,005 < total recusa): meio
  // centavo de taxa de serviço vira um centavo a mais, nunca a menos.
  const totalExato = subtotalComDesconto + (taxa > 0 ? subtotalComDesconto * (taxa / 100) : 0);
  let totalAPagar = Math.round(totalExato * 100);
  if (totalAPagar / 100 + 0.005 < totalExato) totalAPagar += 1;

  const pagamentos = db.prepare('SELECT id, metodo, valor, detalhes, criado_em FROM payments WHERE sale_id = ? ORDER BY rowid').all(saleId);
  const pago = pagamentos.reduce((s, p) => s + centavos(p.valor), 0);

  const ordem = [...Array.from({ length: totalPessoas }, (_, i) => `p${i + 1}`), 'mesa'];
  const grupos = ordem.map((g) => {
    const numero = g === 'mesa' ? null : Number(g.slice(1));
    return {
      grupo: g,
      pessoaNumero: numero,
      rotulo: g === 'mesa' ? 'Mesa (sem pessoa)' : (nomes.get(numero) || `Pessoa ${numero}`),
      subtotal: subtotalPorGrupo.get(g) || 0,
      valor: 0,
      pagoAlocado: 0,
    };
  });

  // Valor de cada grupo (centavos inteiros, soma = total a pagar).
  if (subtotal > 0) {
    let soma = 0;
    for (const g of grupos) {
      g.valor = Math.round((g.subtotal * totalAPagar) / subtotal);
      soma += g.valor;
    }
    const maior = grupos.reduce((m, g) => (g.subtotal > m.subtotal ? g : m), grupos[0]);
    maior.valor += totalAPagar - soma;
  }

  // Pago atribuído pelo celular.
  const porGrupo = new Map(grupos.map((g) => [g.grupo, g]));
  let alocado = 0;
  const historico = [];
  for (const p of pagamentos) {
    const det = lerDetalhes(p.detalhes);
    const lista = Array.isArray(det.grupos) ? det.grupos : [];
    for (const a of lista) {
      const g = porGrupo.get(a?.grupo);
      const c = centavos(a?.valor);
      if (g && c > 0) { g.pagoAlocado += c; alocado += c; }
    }
    historico.push({
      metodo: p.metodo,
      valor: reais(centavos(p.valor)),
      grupos: lista.map((a) => a?.grupo).filter((x) => porGrupo.has(x)),
      troco: Number(det.troco) > 0 ? arred2(det.troco) : 0,
      em: p.criado_em,
    });
  }

  // Pago sem grupo (no computador): abate na proporção do que falta em cada um.
  let semGrupo = Math.max(0, pago - alocado);
  const faltando = grupos.map((g) => Math.max(0, g.valor - g.pagoAlocado));
  const somaFaltando = faltando.reduce((a, b) => a + b, 0);
  const abatido = grupos.map(() => 0);
  if (semGrupo > 0 && somaFaltando > 0) {
    const usar = Math.min(semGrupo, somaFaltando);
    let distribuido = 0;
    grupos.forEach((g, i) => {
      abatido[i] = Math.floor((faltando[i] * usar) / somaFaltando);
      distribuido += abatido[i];
    });
    // Resto em centavos, um por grupo, para quem ainda deve mais.
    let resto = usar - distribuido;
    const ordemDevedores = grupos.map((_, i) => i).sort((a, b) => (faltando[b] - abatido[b]) - (faltando[a] - abatido[a]));
    for (const i of ordemDevedores) {
      if (resto <= 0) break;
      if (faltando[i] - abatido[i] > 0) { abatido[i] += 1; resto -= 1; }
    }
    semGrupo -= usar;
  }

  const restante = Math.max(0, totalAPagar - pago);
  const saida = grupos.map((g, i) => {
    const devido = Math.max(0, g.valor - g.pagoAlocado - abatido[i]);
    return { ...g, pago: g.pagoAlocado + abatido[i], devido };
  });
  // Garante soma dos devidos = restante (pagamento a mais num grupo, item cancelado depois de pago...).
  let diferenca = restante - saida.reduce((s, g) => s + g.devido, 0);
  if (diferenca !== 0) {
    const ordenados = [...saida].sort((a, b) => b.devido - a.devido);
    for (const g of ordenados) {
      if (diferenca === 0) break;
      if (diferenca > 0) { g.devido += diferenca; diferenca = 0; }
      else { const tira = Math.min(g.devido, -diferenca); g.devido -= tira; diferenca += tira; }
    }
  }

  return {
    subtotal: reais(subtotal),
    desconto: arred2((venda.desconto || 0) + (venda.desconto_gerente || 0)),
    taxaServicoPercentual: taxa,
    totalAPagar: reais(totalAPagar),
    pago: reais(pago),
    restante: reais(restante),
    grupos: saida
      .filter((g) => g.subtotal > 0 || g.pago > 0 || g.devido > 0)
      .map((g) => ({
        grupo: g.grupo, pessoaNumero: g.pessoaNumero, rotulo: g.rotulo,
        subtotal: reais(g.subtotal), valor: reais(g.valor), pago: reais(g.pago), devido: reais(g.devido),
      })),
    pagamentos: historico,
  };
}

/** Documento da comanda publicado para o celular. */
function montarComanda(db, principal) {
  const saleId = principal.sale_id;
  const venda = db.prepare('SELECT criado_em, operador_id FROM sales WHERE id = ?').get(saleId);
  const unidas = db.prepare(
    'SELECT id, numero, nome FROM restaurant_tables WHERE unida_a_mesa_id = ? ORDER BY CAST(numero AS INTEGER), numero'
  ).all(principal.id);
  const itens = db.prepare(
    `SELECT si.id, si.product_id, COALESCE(si.nome_personalizado, p.nome) AS nome, p.unidade, si.quantidade, si.preco_unitario,
            si.pessoa_numero, si.observacao, si.status_preparo, si.criado_em
     FROM sale_items si JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = ? AND si.cancelado = 0 ORDER BY si.criado_em, si.rowid`
  ).all(saleId);
  const total = totalDePessoas(db, saleId, principal.pessoas);
  const nomes = new Map(db.prepare('SELECT numero, nome FROM sale_people WHERE sale_id = ?').all(saleId).map((p) => [p.numero, p.nome]));
  const operador = venda?.operador_id ? db.prepare('SELECT nome FROM users WHERE id = ?').get(venda.operador_id) : null;
  return {
    versao: 1,
    mesaId: principal.id,
    numero: principal.numero,
    nome: principal.nome || null,
    unidas: unidas.map((u) => ({ id: u.id, numero: u.numero, nome: u.nome || null })),
    saleId,
    abertaEm: venda?.criado_em || null,
    abertaPorId: venda?.operador_id || null,
    abertaPorNome: operador?.nome || null,
    pessoas: Array.from({ length: total }, (_, i) => ({ numero: i + 1, nome: nomes.get(i + 1) || null })),
    itens: itens.map((i) => ({
      id: i.id,
      produtoId: i.product_id,
      nome: i.nome,
      unidade: i.unidade || 'un',
      quantidade: i.quantidade,
      precoUnitario: i.preco_unitario,
      total: arred2(i.preco_unitario * i.quantidade),
      pessoaNumero: i.pessoa_numero || null,
      observacao: i.observacao || null,
      preparo: i.status_preparo || 'pendente',
      lancadoEm: i.criado_em,
    })),
    conta: calcularConta(db, saleId),
  };
}

/** Lista de mesas publicada para o celular (tela inicial). */
function montarMesas(db, locationId) {
  const mesas = db.prepare(
    `SELECT t.*, s.criado_em AS aberta_em, s.operador_id AS aberta_por_id, u.nome AS aberta_por_nome
     FROM restaurant_tables t
     LEFT JOIN sales s ON s.id = t.sale_id
     LEFT JOIN users u ON u.id = s.operador_id
     WHERE t.location_id = ?
     ORDER BY CAST(t.numero AS INTEGER), t.numero`
  ).all(locationId);
  const unidasPor = new Map();
  for (const m of mesas) {
    if (!m.unida_a_mesa_id) continue;
    if (!unidasPor.has(m.unida_a_mesa_id)) unidasPor.set(m.unida_a_mesa_id, []);
    unidasPor.get(m.unida_a_mesa_id).push(m.numero);
  }
  const numeroPorId = new Map(mesas.map((m) => [m.id, m.numero]));
  return mesas.map((m) => {
    const ocupadaPrincipal = m.status === 'ocupada' && m.sale_id && !m.unida_a_mesa_id;
    const conta = ocupadaPrincipal ? calcularConta(db, m.sale_id) : null;
    const itens = ocupadaPrincipal
      ? db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(m.sale_id).c
      : 0;
    return {
      id: m.id,
      numero: m.numero,
      nome: m.nome || null,
      status: m.status,
      pessoas: ocupadaPrincipal ? totalDePessoas(db, m.sale_id, m.pessoas) : null,
      unidaA: m.unida_a_mesa_id || null,
      unidaANumero: m.unida_a_mesa_id ? numeroPorId.get(m.unida_a_mesa_id) || null : null,
      unidas: unidasPor.get(m.id) || [],
      itens,
      total: conta ? conta.totalAPagar : 0,
      pago: conta ? conta.pago : 0,
      restante: conta ? conta.restante : 0,
      abertaEm: ocupadaPrincipal ? m.aberta_em || null : null,
      abertaPorId: ocupadaPrincipal ? m.aberta_por_id || null : null,
      abertaPorNome: ocupadaPrincipal ? m.aberta_por_nome || null : null,
      reservadoPara: m.status === 'reservada' ? m.reservado_para || null : null,
    };
  });
}

/** Tudo o que o celular precisa além das mesas para montar a tela. */
function montarContexto(db, locationId) {
  const security = require('./authService').getSecurityConfig() || {};
  const config = require('./pdvMobileConfigService').getConfig();
  const autorizadores = db.prepare(
    `SELECT id, nome FROM users WHERE ativo = 1 AND role IN (${PAPEIS_AUTORIZAM.map(() => '?').join(',')}) ORDER BY nome`
  ).all(...PAPEIS_AUTORIZAM);
  return {
    caixaAberto: !!require('./cashService').getOpenSession(locationId),
    exigeAutorizacaoCancelamento: security.exigir_autorizacao_cancelamento === 1,
    metodosPagamento: config.metodosPagamento.filter((m) => METODOS_MESA.includes(m)),
    permitirVenda: config.permitirVenda,
    autorizadores,
    chavePublica: obterChave(db).chave_publica,
  };
}

// ------------------------------------------------------------------ ações

function lerQuantidade(valor, nome) {
  const q = Number(valor);
  if (!Number.isFinite(q) || q <= 0 || q > QUANTIDADE_MAXIMA) throw new ErroComando(`Quantidade inválida para "${nome || 'item'}".`);
  return Math.round(q * 1000) / 1000;
}

function abrirSePreciso(db, principal, ctx, pessoas) {
  if (principal.status === 'ocupada' && principal.sale_id) return { saleId: principal.sale_id, abriu: false };
  if (principal.status === 'aguardando_limpeza') throw new ErroComando(`${rotuloMesa(principal)} está aguardando limpeza. Marque como limpa antes de abrir.`);
  const r = require('./tableService').openTable({
    tableId: principal.id, locationId: ctx.locationId, operadorId: ctx.usuario.id, pessoas: pessoas || null,
  });
  if (!r.ok) throw new ErroComando(r.error);
  return { saleId: r.saleId, abriu: true };
}

const ACOES = {
  abrir(dados, ctx) {
    const db = getDb();
    const pessoas = dados.pessoas == null ? null : Number(dados.pessoas);
    if (pessoas != null && !(Number.isInteger(pessoas) && pessoas >= 1 && pessoas <= LIMITE_PESSOAS)) {
      throw new ErroComando('Número de pessoas inválido.');
    }
    const { principal } = mesaDoComando(db, dados.mesaId, ctx.locationId);
    const { saleId, abriu } = abrirSePreciso(db, principal, ctx, pessoas);
    if (!abriu && pessoas != null) {
      const r = require('./tableService').updateTablePeople({ tableId: principal.id, pessoas });
      if (!r.ok) throw new ErroComando(r.error);
    }
    return { saleId, mesaId: principal.id, abriu };
  },

  lancar(dados, ctx) {
    const db = getDb();
    const itens = Array.isArray(dados.itens) ? dados.itens : [];
    if (itens.length === 0) throw new ErroComando('Nenhum item para lançar.');
    if (itens.length > LIMITE_ITENS) throw new ErroComando(`Itens demais num envio só (máximo ${LIMITE_ITENS}).`);
    const normalizados = itens.map((i) => {
      const produtoId = texto(i?.produtoId, 80);
      if (!produtoId) throw new ErroComando('Item sem produto identificado.');
      const pessoa = i?.pessoaNumero == null ? null : Number(i.pessoaNumero);
      return {
        produtoId,
        nome: texto(i?.nome, 120),
        quantidade: lerQuantidade(i?.quantidade, i?.nome),
        pessoa: Number.isInteger(pessoa) && pessoa >= 1 ? pessoa : null,
        observacao: texto(i?.observacao, 200) || null,
      };
    });

    const pessoasAoAbrir = Number(dados.pessoas);
    const { principal } = mesaDoComando(db, dados.mesaId, ctx.locationId);
    const { saleId } = abrirSePreciso(db, principal, ctx,
      Number.isInteger(pessoasAoAbrir) && pessoasAoAbrir >= 1 && pessoasAoAbrir <= LIMITE_PESSOAS ? pessoasAoAbrir : null);
    const atual = db.prepare('SELECT pessoas FROM restaurant_tables WHERE id = ?').get(principal.id);
    const totalPessoas = totalDePessoas(db, saleId, atual?.pessoas);

    const saleService = require('./saleService');
    const naoLancados = [];
    let lancados = 0;
    for (const item of normalizados) {
      // Pessoa que não existe mais na mesa (removida enquanto o pedido estava
      // na fila): o item entra sem pessoa, e a tela mostra isso.
      const pessoaNumero = item.pessoa && item.pessoa <= totalPessoas ? item.pessoa : null;
      const r = saleService.addItem({
        saleId, productId: item.produtoId, locationId: ctx.locationId, quantidade: item.quantidade,
        operadorId: ctx.usuario.id, deviceId: ctx.dispositivo.id, pessoaNumero, observacao: item.observacao,
      });
      if (r.ok) lancados += 1;
      else naoLancados.push({ produtoId: item.produtoId, nome: item.nome || 'Item', motivo: r.error });
    }
    if (lancados === 0) {
      throw new ErroComando(
        naoLancados.length === 1 ? `${naoLancados[0].nome}: ${naoLancados[0].motivo}` : 'Nenhum item entrou na comanda.',
        { naoLancados },
      );
    }
    return { saleId, mesaId: principal.id, lancados, naoLancados };
  },

  adicionar_pessoa(dados, ctx) {
    const db = getDb();
    const { principal } = comandaAberta(db, dados.mesaId, ctx.locationId);
    if (totalDePessoas(db, principal.sale_id, principal.pessoas) >= LIMITE_PESSOAS) throw new ErroComando('Pessoas demais nesta mesa.');
    const r = require('./tableService').adicionarPessoa({ tableId: principal.id, nome: texto(dados.nome, 40) || null });
    if (!r.ok) throw new ErroComando(r.error);
    return { numero: r.numero };
  },

  renomear_pessoa(dados, ctx) {
    const db = getDb();
    const { principal } = comandaAberta(db, dados.mesaId, ctx.locationId);
    const r = require('./tableService').renomearPessoa({ tableId: principal.id, numero: dados.numero, nome: texto(dados.nome, 40) });
    if (!r.ok) throw new ErroComando(r.error);
    return { numero: Number(dados.numero) };
  },

  remover_pessoa(dados, ctx) {
    const db = getDb();
    const { principal, saleId } = comandaAberta(db, dados.mesaId, ctx.locationId);
    // Recebimento por pessoa guarda o número da pessoa; tirar uma pessoa
    // renumera as seguintes e embaralharia quem já pagou o quê.
    if (temPagamento(db, saleId)) throw new ErroComando('Esta conta já tem pagamento. Para tirar uma pessoa, faça pelo computador.');
    const r = require('./tableService').removerPessoa({ tableId: principal.id, numero: dados.numero });
    if (!r.ok) throw new ErroComando(r.error);
    return { numero: Number(dados.numero) };
  },

  mover_item(dados, ctx) {
    const db = getDb();
    const { principal, saleId } = comandaAberta(db, dados.mesaId, ctx.locationId);
    const item = itemDaComanda(db, saleId, dados.itemId);
    let pessoa = null;
    if (dados.pessoaNumero != null) {
      pessoa = Number(dados.pessoaNumero);
      const total = totalDePessoas(db, saleId, principal.pessoas);
      if (!(Number.isInteger(pessoa) && pessoa >= 1 && pessoa <= total)) throw new ErroComando('Pessoa não encontrada nesta mesa.');
    }
    require('./saleService').setItemPerson({ saleItemId: item.id, pessoaNumero: pessoa });
    return { itemId: item.id, pessoaNumero: pessoa };
  },

  observacao_item(dados, ctx) {
    const db = getDb();
    const { saleId } = comandaAberta(db, dados.mesaId, ctx.locationId);
    const item = itemDaComanda(db, saleId, dados.itemId);
    require('./saleService').setItemNote({ saleItemId: item.id, observacao: texto(dados.observacao, 200) });
    return { itemId: item.id };
  },

  /** A regra de autorização é a do computador (saleService.cancelSaleItem):
   * PIN de gerente só quando a conta já tem pagamento e a loja exige. PIN
   * errado fica gravado (auditoria e bloqueio por tentativas) -- por isso
   * aqui não se lança erro depois de tentar: devolve { falha }, que é
   * gravada sem desfazer nada. */
  cancelar_item(dados, ctx) {
    const db = getDb();
    const { saleId } = comandaAberta(db, dados.mesaId, ctx.locationId);
    const item = itemDaComanda(db, saleId, dados.itemId);
    const autorizadorId = texto(dados.autorizadorId, 80) || null;
    const pin = dados.pinCifrado ? decifrarPin(dados.pinCifrado, db) : null;
    const r = require('./saleService').cancelSaleItem({
      saleId, saleItemId: item.id, locationId: ctx.locationId, currentOperatorId: ctx.usuario.id,
      candidateManagerId: autorizadorId, pin, motivo: texto(dados.motivo, 200) || 'Cancelado pelo celular',
      deviceId: ctx.dispositivo.id,
    });
    if (!r.ok) return { falha: r.error };
    return { itemId: item.id };
  },

  limpar_mesa(dados, ctx) {
    const db = getDb();
    const { mesa } = mesaDoComando(db, dados.mesaId, ctx.locationId);
    const r = require('./tableService').markCleaned(mesa.id);
    if (!r.ok) throw new ErroComando(r.error);
    return { mesaId: mesa.id };
  },

  juntar(dados, ctx) {
    exigirPapel(ctx, PAPEIS_ORGANIZAR, 'Juntar mesas é com o caixa ou o gerente.');
    const db = getDb();
    const { principal } = mesaDoComando(db, dados.mesaId, ctx.locationId);
    const mesaIds = (Array.isArray(dados.mesaIds) ? dados.mesaIds : []).map((x) => texto(x, 80)).filter(Boolean).slice(0, 30);
    const r = require('./tableService').juntarMesas({ tableId: principal.id, mesaIds, currentOperatorId: ctx.usuario.id });
    if (!r.ok) throw new ErroComando(r.error);
    return { mesaId: r.principalId, saleId: r.saleId };
  },

  separar(dados, ctx) {
    exigirPapel(ctx, PAPEIS_ORGANIZAR, 'Separar mesas é com o caixa ou o gerente.');
    const db = getDb();
    const { mesa } = mesaDoComando(db, dados.mesaId, ctx.locationId);
    const r = require('./tableService').separarMesa({ tableId: mesa.id, currentOperatorId: ctx.usuario.id });
    if (!r.ok) throw new ErroComando(r.error);
    return { mesaId: mesa.id };
  },

  transferir(dados, ctx) {
    exigirPapel(ctx, PAPEIS_ORGANIZAR, 'Transferir mesa é com o caixa ou o gerente.');
    const db = getDb();
    const { principal } = mesaDoComando(db, dados.mesaId, ctx.locationId);
    const destino = mesaDoComando(db, dados.destinoId, ctx.locationId).mesa;
    const r = require('./tableService').transferTable({ fromTableId: principal.id, toTableId: destino.id });
    if (!r.ok) throw new ErroComando(r.error);
    return { mesaId: destino.id, saleId: r.saleId };
  },

  taxa_servico(dados, ctx) {
    exigirRecebimento(ctx);
    const db = getDb();
    const { saleId } = comandaAberta(db, dados.mesaId, ctx.locationId);
    if (temPagamento(db, saleId)) throw new ErroComando('A conta já tem pagamento: a taxa de serviço não muda mais por aqui.');
    const pct = Number(dados.percentual);
    if (!Number.isFinite(pct) || pct < 0 || pct > 30) throw new ErroComando('Taxa de serviço inválida (de 0 a 30%).');
    const r = require('./saleService').setServiceCharge(saleId, pct);
    if (!r.ok) throw new ErroComando(r.error);
    return { percentual: pct };
  },

  /**
   * Recebe a mesa inteira ou o que alguns grupos (pessoas / mesa) devem.
   * `valorEsperado` é o que o celular mostrou: se a conta mudou no meio do
   * caminho (item novo, pagamento no computador), recusa com a conta atual
   * em vez de cobrar diferente do que a pessoa viu.
   */
  receber(dados, ctx) {
    exigirRecebimento(ctx);
    const db = getDb();
    if (!require('./cashService').getOpenSession(ctx.locationId)) {
      throw new ErroComando('O caixa está fechado no computador da loja. Abra o caixa lá antes de receber.');
    }
    const { principal, saleId } = comandaAberta(db, dados.mesaId, ctx.locationId);
    const config = require('./pdvMobileConfigService').getConfig();
    const conta = calcularConta(db, saleId);
    if (conta.restante <= TOLERANCIA) throw new ErroComando('Esta conta já está paga.', { conta });

    const tudo = dados.grupos === 'tudo' || (Array.isArray(dados.grupos) && dados.grupos.includes('tudo'));
    const escolhidos = tudo ? null : [...new Set((Array.isArray(dados.grupos) ? dados.grupos : []).map((g) => texto(g, 12)))];
    if (!tudo && escolhidos.length === 0) throw new ErroComando('Escolha quem vai pagar.');
    const devedores = conta.grupos.filter((g) => g.devido > 0);
    const selecionados = tudo ? devedores : devedores.filter((g) => escolhidos.includes(g.grupo));
    if (!tudo && selecionados.length !== escolhidos.length) {
      throw new ErroComando('Alguém escolhido já pagou ou não tem mais itens. Confira a conta.', { conta });
    }
    const pegaTudo = selecionados.length === devedores.length;
    const esperadoC = pegaTudo ? centavos(conta.restante) : selecionados.reduce((s, g) => s + centavos(g.devido), 0);
    if (Math.abs(centavos(dados.valorEsperado) - esperadoC) > 0) {
      throw new ErroComando(`A conta mudou desde que você abriu (agora: R$ ${reais(esperadoC).toFixed(2)}). Confira e receba de novo.`, { conta });
    }

    const pagamentos = Array.isArray(dados.pagamentos) ? dados.pagamentos : [];
    if (pagamentos.length === 0) throw new ErroComando('Informe como vai ser pago.');
    if (pagamentos.length > LIMITE_PAGAMENTOS) throw new ErroComando(`Formas de pagamento demais (máximo ${LIMITE_PAGAMENTOS}).`);

    // Divide o recebido entre os grupos escolhidos, na ordem: completa o
    // primeiro, depois o segundo... A soma do que cada um recebe fecha
    // exatamente com o que cada um devia quando a conta toda é paga.
    const saldo = selecionados.map((g, i) => ({
      grupo: g.grupo,
      falta: pegaTudo && i === selecionados.length - 1
        ? esperadoC - selecionados.slice(0, -1).reduce((s, x) => s + centavos(x.devido), 0)
        : centavos(g.devido),
    }));
    const alocar = (valorC) => {
      const partes = [];
      let resta = valorC;
      for (const g of saldo) {
        if (resta <= 0) break;
        const parte = Math.min(g.falta, resta);
        if (parte <= 0) continue;
        g.falta -= parte;
        resta -= parte;
        partes.push({ grupo: g.grupo, valor: reais(parte) });
      }
      return partes;
    };

    const saleService = require('./saleService');
    let faltaC = esperadoC;
    const recebidos = [];
    for (const p of pagamentos) {
      const metodo = String(p?.metodo || '');
      if (!METODOS_MESA.includes(metodo) || !config.metodosPagamento.includes(metodo)) {
        throw new ErroComando(`A forma de pagamento "${metodo || '(vazia)'}" não está liberada para o celular nesta loja.`);
      }
      const valorC = centavos(p?.valor);
      if (!(valorC > 0)) throw new ErroComando('Pagamento com valor inválido.');
      if (faltaC <= 0) throw new ErroComando('Tem pagamento a mais. Confira os valores.');
      const detalhes = { origem: 'pdv_movel', comando: 'mesa', recebidoPorId: ctx.usuario.id };
      let lancarC = valorC;
      if (metodo === 'dinheiro') {
        // Só o que falta entra como dinheiro no caixa; o resto é troco.
        const recebidoC = Math.max(centavos(p?.valorRecebido ?? p?.valor), valorC);
        lancarC = Math.min(valorC, faltaC);
        if (recebidoC > lancarC) {
          detalhes.valorRecebido = reais(recebidoC);
          detalhes.troco = reais(recebidoC - lancarC);
        }
      } else if (valorC > faltaC) {
        throw new ErroComando('Cartão e Pix não podem passar do valor da conta. Confira os valores.');
      }
      detalhes.grupos = alocar(lancarC);
      const r = saleService.addPayment({ saleId, metodo, valor: reais(lancarC), detalhes });
      if (!r.ok) throw new ErroComando(r.error);
      faltaC -= centavos(r.valor ?? reais(lancarC));
      recebidos.push({ metodo, valor: reais(lancarC), troco: detalhes.troco || 0 });
    }
    if (faltaC > 0) throw new ErroComando(`Faltam R$ ${reais(faltaC).toFixed(2)} para fechar o que foi escolhido.`);

    const depois = calcularConta(db, saleId);
    return {
      saleId,
      mesaId: principal.id,
      recebidos,
      troco: arred2(recebidos.reduce((s, r) => s + r.troco, 0)),
      restante: depois.restante,
      // Conta toda paga: o processamento finaliza a venda e libera a mesa logo depois.
      finalizar: depois.restante <= TOLERANCIA,
    };
  },

  /** Resumo do que ESTE usuário vendeu no caixa aberto do computador. */
  meu_turno(_dados, ctx) {
    if (ctx.dispositivo.tipo !== 'pdv') throw new ErroComando('O resumo do turno é do celular de PDV móvel.');
    const db = getDb();
    const sessao = require('./cashService').getOpenSession(ctx.locationId);
    if (!sessao) return { caixaAberto: false };
    const vendas = db.prepare(
      `SELECT id, (total - desconto - desconto_gerente) AS valor, finalizada_em FROM sales
       WHERE location_id = ? AND operador_id = ? AND status = 'finalizada' AND finalizada_em >= ?
       ORDER BY finalizada_em DESC`
    ).all(ctx.locationId, ctx.usuario.id, sessao.aberta_em);
    const porMetodo = db.prepare(
      `SELECT p.metodo, COALESCE(SUM(p.valor), 0) AS total FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.location_id = ? AND s.operador_id = ? AND s.status = 'finalizada' AND s.finalizada_em >= ?
       GROUP BY p.metodo ORDER BY total DESC`
    ).all(ctx.locationId, ctx.usuario.id, sessao.aberta_em);
    const recebidosNasMesas = db.prepare(
      `SELECT COALESCE(SUM(p.valor), 0) AS total FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.location_id = ? AND p.criado_em >= ? AND p.detalhes LIKE '%"comando":"mesa"%' AND p.detalhes LIKE ?`
    ).get(ctx.locationId, sessao.aberta_em, `%"recebidoPorId":"${ctx.usuario.id}"%`).total;
    return {
      caixaAberto: true,
      caixaAbertoEm: sessao.aberta_em,
      vendas: vendas.length,
      total: arred2(vendas.reduce((s, v) => s + (Number(v.valor) || 0), 0)),
      porMetodo: porMetodo.map((m) => ({ metodo: m.metodo, total: arred2(m.total) })),
      recebidoNasMesas: arred2(recebidosNasMesas),
      ultimas: vendas.slice(0, 10).map((v) => ({ id: v.id, valor: arred2(v.valor), finalizadaEm: v.finalizada_em })),
    };
  },
};

// ------------------------------------------------------------------ execução

function criadoMs(valor) {
  if (typeof valor?.toMillis === 'function') return valor.toMillis();
  return null;
}

/** Prazo do comando: lançar pode ter ficado na fila sem internet (até 12 h);
 * o resto precisa ter chegado na hora. */
function conferirPrazo(dados, agoraMs) {
  const servidorMs = criadoMs(dados.criadoEm);
  const celularMs = Number(dados.criadoEmCelularMs);
  const lancar = dados.tipo === 'lancar';
  if (servidorMs != null && agoraMs - servidorMs > (lancar ? VALIDADE_LANCAR_MS : VALIDADE_MS)) {
    throw new ErroComando('Este pedido chegou atrasado ao computador da loja e foi descartado. Confira a mesa e faça de novo, se ainda precisar.');
  }
  if (servidorMs != null && Number.isFinite(celularMs) && servidorMs - celularMs > (lancar ? VALIDADE_LANCAR_MS : ATRASO_TOLERADO_MS)) {
    throw new ErroComando(lancar
      ? 'Este pedido ficou mais de 12 h sem internet no celular e foi descartado. Confira com o cliente e lance de novo.'
      : 'Isto foi feito sem internet e chegou atrasado. Confira a mesa e faça de novo, se ainda precisar.');
  }
}

/**
 * Executa (ou devolve o resultado já guardado de) um comando. Parte local,
 * síncrona e transacional: o que o comando mudou e o registro do resultado
 * entram juntos, ou nada entra. Devolve { resultado } ou { erro, extra }.
 */
function executarComando(comandoId, dados, { agoraMs = Date.now() } = {}) {
  const db = getDb();
  const id = texto(comandoId, 120);
  if (!id) return { erro: 'Comando sem identificação.' };

  const guardado = db.prepare('SELECT * FROM mobile_comandos_mesa WHERE id = ?').get(id);
  if (guardado) {
    return guardado.ok
      ? { resultado: lerDetalhes(guardado.resultado), repetido: true }
      : { erro: guardado.erro, extra: guardado.resultado ? lerDetalhes(guardado.resultado) : null, repetido: true };
  }

  let ctx;
  try {
    if (!dados || !TIPOS.includes(dados.tipo)) throw new ErroComando('Comando desconhecido (o app do celular pode estar desatualizado).');
    ctx = { ...autorizar(dados.dispositivoUid, { exigeMesas: dados.tipo !== 'meu_turno' }), locationId: locationIdAtual(db) };
  } catch (err) {
    if (err instanceof ErroComando) return { erro: err.message };
    throw err;
  }

  if (TIPOS_SO_LEITURA.includes(dados.tipo)) {
    try {
      return { resultado: ACOES[dados.tipo](dados, ctx) };
    } catch (err) {
      if (err instanceof ErroComando) return { erro: err.message };
      throw err;
    }
  }

  const tableIdPedido = texto(dados.mesaId, 80) || null;
  return db.transaction(() => {
    let saida;
    try {
      conferirPrazo(dados, agoraMs);
      // Savepoint: se a ação falhar no meio, desfaz só ela -- o registro do
      // erro abaixo continua valendo.
      const r = db.transaction(() => ACOES[dados.tipo](dados, ctx))();
      saida = r && r.falha ? { erro: r.falha } : { resultado: r };
    } catch (err) {
      if (!(err instanceof ErroComando)) throw err;
      saida = { erro: err.message, extra: err.extra || null };
    }
    const saleId = saida.resultado?.saleId || null;
    db.prepare(
      `INSERT INTO mobile_comandos_mesa (id, device_id, usuario_id, tipo, table_id, sale_id, ok, resultado, erro)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, ctx.dispositivo.id, ctx.usuario.id, dados.tipo, tableIdPedido, saleId, saida.erro ? 0 : 1,
      saida.erro ? (saida.extra ? JSON.stringify(saida.extra) : null) : JSON.stringify(saida.resultado ?? null),
      saida.erro || null,
    );
    return saida;
  })();
}

/**
 * Conta toda paga pelo celular: finaliza a venda (mesma checagem de
 * estoque do grupo da venda do computador) e libera a mesa. Seguro de
 * repetir: venda já finalizada não é finalizada de novo.
 */
async function concluirConta(comandoId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mobile_comandos_mesa WHERE id = ?').get(comandoId);
  if (!row || !row.ok || row.tipo !== 'receber') return null;
  const resultado = lerDetalhes(row.resultado);
  if (!resultado.finalizar || resultado.finalizada) return resultado;
  const venda = db.prepare('SELECT status FROM sales WHERE id = ?').get(resultado.saleId);
  let final;
  if (venda?.status === 'finalizada') final = { ok: true };
  else final = await require('./saleService').finalizeSaleComVerificacaoDeGrupo(resultado.saleId);

  const novo = { ...resultado };
  if (final.ok) {
    novo.finalizada = true;
    novo.pendente = false;
    const mesa = db.prepare('SELECT id FROM restaurant_tables WHERE sale_id = ? AND unida_a_mesa_id IS NULL').get(resultado.saleId);
    if (mesa) require('./tableService').releaseTable(mesa.id);
    if (require('./pdvMobileConfigService').getConfig().imprimirReciboNoComputador) {
      require('./printService').printReceipt(resultado.saleId).catch((err) => console.error('[mesaCelularService] impressão do recibo falhou:', err));
    }
  } else {
    novo.pendente = !!final.pendente;
    novo.avisoFinalizacao = final.pendente
      ? 'Pago. Falta confirmar o estoque com as outras máquinas da loja; a mesa libera quando a venda finalizar no computador.'
      : `Pago, mas a venda não finalizou: ${final.error || 'confira no computador'}.`;
  }
  db.prepare('UPDATE mobile_comandos_mesa SET resultado = ? WHERE id = ?').run(JSON.stringify(novo), comandoId);
  return novo;
}

// ------------------------------------------------------------------ Firestore

function firestoreCtx() {
  const licenseService = require('./licenseService');
  const pdvRegistryService = require('./pdvRegistryService');
  return { firestore: licenseService.getLicenseFirestore(), installId: pdvRegistryService.getOrCreateDeviceUid() };
}

let publicarLogo = () => {};

async function processarComando(docSnap) {
  const dados = docSnap.data();
  if (dados.status !== 'novo') return;
  const { doc, updateDoc, serverTimestamp } = require('firebase/firestore');
  const { firestore, installId } = firestoreCtx();
  const ref = doc(firestore, 'installations', installId, 'comandos_mesa', docSnap.id);

  let resposta;
  try {
    resposta = executarComando(docSnap.id, dados);
    if (resposta.resultado?.finalizar && !resposta.resultado?.finalizada) {
      resposta = { resultado: (await concluirConta(docSnap.id)) || resposta.resultado };
    }
  } catch (err) {
    console.error('[mesaCelularService] falha ao processar comando:', err);
    resposta = { erro: 'Erro no computador da loja ao fazer isso. Nada foi mudado.' };
  }

  await updateDoc(ref, resposta.erro
    ? { status: 'erro', erro: resposta.erro, resultado: resposta.extra ?? null, respondidoEm: serverTimestamp() }
    : { status: 'feito', resultado: resposta.resultado ?? null, respondidoEm: serverTimestamp() }
  ).catch((err) => console.error('[mesaCelularService] não consegui responder o celular:', err.message));
  publicarLogo();
}

/** Comandos ficam no Firestore só para o celular acompanhar (o registro de
 * verdade é a tabela local + Auditoria): apaga os com mais de 24 h. */
async function limparComandosAntigos() {
  const { collection, query, where, getDocs, deleteDoc, limit, Timestamp } = require('firebase/firestore');
  const { firestore, installId } = firestoreCtx();
  const corte = Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
  const snap = await getDocs(query(collection(firestore, 'installations', installId, 'comandos_mesa'), where('criadoEm', '<', corte), limit(200)));
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
}

/** Tem celular que atende mesa pareado aqui? (senão não gasta escrita no Firestore) */
function temCelularDeMesa() {
  const db = getDb();
  const garcom = db.prepare(`SELECT 1 FROM paired_devices WHERE tipo = 'garcom' AND ativo = 1 LIMIT 1`).get();
  if (garcom) return true;
  const pdv = db.prepare(`SELECT 1 FROM paired_devices WHERE tipo = 'pdv' AND ativo = 1 LIMIT 1`).get();
  return !!pdv && require('./pdvMobileConfigService').getConfig().permitirMesas;
}

function hashDe(obj) {
  return createHash('sha1').update(JSON.stringify(obj)).digest('hex');
}

/** O que vai ser publicado agora: { mesas: doc, comandas: Map<mesaId, doc> }. */
function montarPublicacao() {
  const db = getDb();
  const locationId = locationIdAtual(db);
  const mesas = montarMesas(db, locationId);
  const comandas = new Map();
  for (const m of mesas) {
    if (m.status !== 'ocupada' || m.unidaA) continue;
    const principal = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(m.id);
    if (principal?.sale_id) comandas.set(m.id, montarComanda(db, principal));
  }
  return { mesas: { versao: 1, ...montarContexto(db, locationId), mesas }, comandas };
}

/**
 * Conta paga pelo celular que ficou esperando o estoque do grupo: quando o
 * ciclo automático do saleService finaliza a venda, libera a mesa (o
 * celular não está mais esperando resposta nenhuma).
 */
function concluirPendentes() {
  const db = getDb();
  const linhas = db.prepare(
    `SELECT id, resultado FROM mobile_comandos_mesa
     WHERE tipo = 'receber' AND ok = 1 AND resultado LIKE '%"pendente":true%'
       AND criado_em >= datetime(NOW_SYNCED(), '-3 days')`
  ).all();
  for (const l of linhas) {
    const r = lerDetalhes(l.resultado);
    const venda = r.saleId ? db.prepare('SELECT status FROM sales WHERE id = ?').get(r.saleId) : null;
    if (!venda || venda.status === 'aberta') continue;
    if (venda.status === 'finalizada') {
      const mesa = db.prepare('SELECT id FROM restaurant_tables WHERE sale_id = ? AND unida_a_mesa_id IS NULL').get(r.saleId);
      if (mesa) require('./tableService').releaseTable(mesa.id);
    }
    db.prepare('UPDATE mobile_comandos_mesa SET resultado = ? WHERE id = ?')
      .run(JSON.stringify({ ...r, pendente: false, finalizada: venda.status === 'finalizada' }), l.id);
  }
}

const SINAL_DE_VIDA_MS = 30 * 1000;
const estadoPublicado = { mesasHash: null, mesasEm: 0, comandas: new Map(), carregouExistentes: false };
let publicando = false;

async function publicar() {
  if (publicando) return;
  publicando = true;
  try {
    if (!temCelularDeMesa()) return;
    concluirPendentes();
    const { doc, setDoc, deleteDoc, serverTimestamp } = require('firebase/firestore');
    const { firestore, installId } = firestoreCtx();
    const { mesas, comandas } = montarPublicacao();

    // Primeira vez desde que o app abriu: a comanda de uma mesa que fechou
    // com este programa desligado pode ter ficado publicada. O computador
    // não lê de volta essa coleção (a leitura é só de celular pareado), então
    // marca todas as mesas que NÃO estão abertas para apagar uma vez.
    if (!estadoPublicado.carregouExistentes) {
      for (const m of mesas.mesas) if (!comandas.has(m.id)) estadoPublicado.comandas.set(m.id, null);
      estadoPublicado.carregouExistentes = true;
    }

    // Sinal de vida só para loja com mesa cadastrada (sem mesa, o celular
    // nem mostra o painel e não precisa saber se o computador está no ar).
    const hashMesas = hashDe(mesas);
    const precisaSinal = mesas.mesas.length > 0 && Date.now() - estadoPublicado.mesasEm > SINAL_DE_VIDA_MS;
    if (hashMesas !== estadoPublicado.mesasHash || precisaSinal) {
      await setDoc(doc(firestore, 'installations', installId, 'mesas_ao_vivo', 'atual'), {
        ...mesas, vivoEmMs: Date.now(), atualizadoEm: serverTimestamp(),
      });
      estadoPublicado.mesasHash = hashMesas;
      estadoPublicado.mesasEm = Date.now();
    }

    for (const [mesaId, comanda] of comandas) {
      const h = hashDe(comanda);
      if (estadoPublicado.comandas.get(mesaId) === h) continue;
      await setDoc(doc(firestore, 'installations', installId, 'comandas_mesa', mesaId), { ...comanda, atualizadoEm: serverTimestamp() });
      estadoPublicado.comandas.set(mesaId, h);
    }
    for (const mesaId of [...estadoPublicado.comandas.keys()]) {
      if (comandas.has(mesaId)) continue;
      await deleteDoc(doc(firestore, 'installations', installId, 'comandas_mesa', mesaId));
      estadoPublicado.comandas.delete(mesaId);
    }
  } catch (err) {
    console.error('[mesaCelularService] publicação das mesas falhou (tenta de novo):', err.message);
  } finally {
    publicando = false;
  }
}

let fila = Promise.resolve();
function enfileirar(tarefa) {
  fila = fila.then(tarefa).catch((err) => console.error('[mesaCelularService] tarefa falhou:', err));
  return fila;
}

let pararEscuta = null;
let intervaloPublicacao = null;
let intervaloLimpeza = null;
let timerLogo = null;

/** Chamado uma vez em main.js. */
function iniciar() {
  publicarLogo = () => {
    clearTimeout(timerLogo);
    timerLogo = setTimeout(() => { publicar().catch(() => {}); }, 300);
  };
  try {
    if (pararEscuta) { pararEscuta(); pararEscuta = null; }
    const { collection, query, where, onSnapshot } = require('firebase/firestore');
    const { firestore, installId } = firestoreCtx();
    pararEscuta = onSnapshot(
      query(collection(firestore, 'installations', installId, 'comandos_mesa'), where('status', '==', 'novo')),
      (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'removed') return;
          const docSnap = change.doc;
          enfileirar(() => processarComando(docSnap));
        });
      },
      (err) => console.error('[mesaCelularService] escuta de comandos falhou:', err)
    );
  } catch (err) {
    console.error('[mesaCelularService] não foi possível iniciar a escuta:', err);
  }

  // Mudança feita no próprio computador (garçom no balcão, cozinha marcando
  // pronto) aparece no celular em até 3 s; só escreve no Firestore se mudou.
  if (intervaloPublicacao) clearInterval(intervaloPublicacao);
  intervaloPublicacao = setInterval(() => { publicar().catch(() => {}); }, 3000);
  publicar().catch(() => {});

  if (intervaloLimpeza) clearInterval(intervaloLimpeza);
  intervaloLimpeza = setInterval(() => { limparComandosAntigos().catch(() => {}); }, 30 * 60 * 1000);
}

module.exports = {
  TIPOS, METODOS_MESA, PAPEIS_MESA, PAPEIS_ORGANIZAR, VALIDADE_LANCAR_MS, VALIDADE_MS,
  iniciar, executarComando, concluirConta, calcularConta, montarComanda, montarMesas, montarContexto,
  montarPublicacao, obterChave, decifrarPin, concluirPendentes,
  // Só para teste (tests/mesaCelular.test.js): publicar com um Firestore falso.
  publicar,
  _reiniciarPublicacao() {
    estadoPublicado.mesasHash = null;
    estadoPublicado.mesasEm = 0;
    estadoPublicado.comandas = new Map();
    estadoPublicado.carregouExistentes = false;
  },
};
