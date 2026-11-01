const { getDb } = require('../db/database');
const timeService = require('./timeService');

/**
 * Inadimplência (ERP, financeiro): quanto está na rua e há quanto tempo.
 *  - Fiado: por cliente, pagamento abate a dívida MAIS ANTIGA primeiro
 *    (FIFO); o que sobra tem a data da compra. Fiado não tem vencimento,
 *    então "vencido" = mais velho que o prazo combinado (padrão 30 dias).
 *  - Contas a receber lançadas: vencido = vencimento antes de hoje.
 */

const arred = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const FAIXAS = [
  { chave: 'ate30', rotulo: 'até 30 dias', ate: 30 },
  { chave: 'de31a60', rotulo: '31 a 60 dias', ate: 60 },
  { chave: 'de61a90', rotulo: '61 a 90 dias', ate: 90 },
  { chave: 'mais90', rotulo: 'mais de 90 dias', ate: Infinity },
];

function diasEntre(deISO, ateISO) {
  return Math.round((Date.parse(`${ateISO}T12:00:00Z`) - Date.parse(`${deISO}T12:00:00Z`)) / 86400000);
}
function dataLocal(utc) {
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  return new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 10);
}
function faixaDe(dias) {
  return FAIXAS.find((f) => dias <= f.ate).chave;
}

/** Dívidas de fiado ainda em aberto de um cliente, com a data de cada uma (FIFO). */
function fiadoEmAberto(movimentos) {
  const abertas = [];
  let credito = 0;
  for (const m of movimentos) {
    if (m.tipo === 'divida') abertas.push({ data: dataLocal(m.criado_em), valor: Number(m.valor) });
    else credito += Number(m.valor);
    while (credito > 0.004 && abertas.length) {
      const abate = Math.min(credito, abertas[0].valor);
      abertas[0].valor = arred(abertas[0].valor - abate);
      credito = arred(credito - abate);
      if (abertas[0].valor <= 0.004) abertas.shift();
    }
  }
  return abertas;
}

function relatorio({ prazoFiadoDias = 30 } = {}) {
  const prazo = Math.max(0, Math.min(365, Number(prazoFiadoDias) || 30));
  const db = getDb();
  const hoje = timeService.hojeLocalISO();
  const faixas = Object.fromEntries(FAIXAS.map((f) => [f.chave, 0]));
  const porCliente = new Map();
  const cliente = (id, nome, telefone) => {
    if (!porCliente.has(id)) porCliente.set(id, { customerId: id, nome, telefone, aberto: 0, vencido: 0, maisAntigo: null, diasAtraso: 0, origens: new Set() });
    return porCliente.get(id);
  };

  const movs = db.prepare(
    `SELECT m.customer_id, m.tipo, m.valor, m.criado_em, c.nome, c.telefone
     FROM customer_credit_movements m JOIN customers c ON c.id = m.customer_id
     ORDER BY m.customer_id, m.criado_em, m.rowid`
  ).all();
  const agrupado = new Map();
  for (const m of movs) (agrupado.get(m.customer_id) || agrupado.set(m.customer_id, []).get(m.customer_id)).push(m);
  for (const [id, lista] of agrupado) {
    const abertas = fiadoEmAberto(lista);
    if (abertas.length === 0) continue;
    const c = cliente(id, lista[0].nome, lista[0].telefone);
    c.origens.add('fiado');
    for (const d of abertas) {
      const idade = diasEntre(d.data, hoje);
      c.aberto = arred(c.aberto + d.valor);
      if (!c.maisAntigo || d.data < c.maisAntigo) c.maisAntigo = d.data;
      const atraso = idade - prazo;
      if (atraso > 0) {
        c.vencido = arred(c.vencido + d.valor);
        c.diasAtraso = Math.max(c.diasAtraso, atraso);
        faixas[faixaDe(atraso)] = arred(faixas[faixaDe(atraso)] + d.valor);
      }
    }
  }

  const recebiveis = db.prepare(
    `SELECT r.id, r.descricao, r.valor, r.vencimento, r.customer_id, c.nome, c.telefone FROM receivables r
     LEFT JOIN customers c ON c.id = r.customer_id
     WHERE r.recebido_em IS NULL AND r.cancelado_em IS NULL ORDER BY r.vencimento`
  ).all();
  const recebiveisVencidos = [];
  for (const r of recebiveis) {
    const atraso = diasEntre(r.vencimento, hoje);
    const c = r.customer_id ? cliente(r.customer_id, r.nome, r.telefone) : null;
    if (c) { c.aberto = arred(c.aberto + r.valor); c.origens.add('conta'); }
    if (atraso <= 0) continue;
    faixas[faixaDe(atraso)] = arred(faixas[faixaDe(atraso)] + r.valor);
    recebiveisVencidos.push({ id: r.id, descricao: r.descricao, cliente: r.nome || null, valor: r.valor, vencimento: r.vencimento, diasAtraso: atraso });
    if (c) {
      c.vencido = arred(c.vencido + r.valor);
      c.diasAtraso = Math.max(c.diasAtraso, atraso);
      if (!c.maisAntigo || r.vencimento < c.maisAntigo) c.maisAntigo = r.vencimento;
    }
  }

  const clientes = [...porCliente.values()].map((c) => ({ ...c, origens: [...c.origens] }))
    .sort((a, b) => b.vencido - a.vencido || b.aberto - a.aberto);
  const totalAberto = arred(clientes.reduce((s, c) => s + c.aberto, 0) + recebiveis.filter((r) => !r.customer_id).reduce((s, r) => s + r.valor, 0));
  const totalVencido = arred(Object.values(faixas).reduce((s, v) => s + v, 0));
  return {
    ok: true, hoje, prazoFiadoDias: prazo, totalAberto, totalVencido,
    faixas: FAIXAS.map((f) => ({ chave: f.chave, rotulo: f.rotulo, valor: faixas[f.chave] })),
    clientes, recebiveisVencidos,
  };
}

/** Texto pronto para mandar ao cliente (o envio é da pessoa, pelo WhatsApp dela). */
function mensagemDeCobranca({ customerId, prazoFiadoDias } = {}) {
  const r = relatorio({ prazoFiadoDias });
  const c = r.clientes.find((x) => x.customerId === customerId);
  if (!c) return { ok: false, error: 'Cliente sem valor em aberto.' };
  const loja = getDb().prepare("SELECT COALESCE(nome_fantasia, razao_social) AS nome FROM fiscal_config WHERE id = 'default'").get()?.nome
    || getDb().prepare('SELECT nome FROM locations LIMIT 1').get()?.nome || 'a loja';
  const valor = c.aberto.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return { ok: true, texto: `Olá, ${c.nome.split(' ')[0]}! Tudo bem? Aqui é da ${loja}. Passando para lembrar que há ${valor} em aberto na sua conta${c.maisAntigo ? ` (desde ${c.maisAntigo.split('-').reverse().join('/')})` : ''}. Quando puder, passe aqui ou me chame para combinarmos. Obrigado!`, telefone: c.telefone || null };
}

module.exports = { relatorio, mensagemDeCobranca, fiadoEmAberto, FAIXAS };
