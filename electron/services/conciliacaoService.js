const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const timeService = require('./timeService');

/**
 * Conciliação bancária (ERP, financeiro) pelo extrato OFX que todo banco
 * exporta. Sem senha nem integração com banco: a pessoa baixa o arquivo e
 * importa. Cada linha do extrato é casada com uma conta paga, uma conta a
 * receber ou o repasse do cartão do dia; o que não casa vira despesa com
 * um clique ou é ignorado. Reimportar o mesmo arquivo não duplica (FITID).
 */

const arred = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const TAMANHO_MAXIMO = 5 * 1024 * 1024;

function diasEntre(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}
function somarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- leitura do OFX (SGML 1.x e XML 2.x) ----------

function decodificar(buffer) {
  const cabeca = buffer.subarray(0, 600).toString('latin1');
  const utf8 = /ENCODING:\s*UTF-?8|encoding="utf-8"/i.test(cabeca) && !/CHARSET:\s*1252/i.test(cabeca);
  return buffer.toString(utf8 ? 'utf8' : 'latin1');
}

function campo(bloco, tag) {
  // Vale para <TAG>valor</TAG> e para o SGML sem fechamento (<TAG>valor\n).
  const m = bloco.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : '';
}

function dataOfx(v) {
  const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

function valorOfx(v) {
  let s = String(v || '').trim().replace(/\s/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // alguns bancos mandam 1.234,56
  const n = Number(s);
  return Number.isFinite(n) ? arred(n) : null;
}

function parseOfx(texto) {
  if (!/<OFX>/i.test(texto)) return { ok: false, error: 'Este arquivo não parece um extrato OFX.' };
  const conta = [campo(texto, 'BANKID'), campo(texto, 'BRANCHID'), campo(texto, 'ACCTID')].filter(Boolean).join('/') || 'conta';
  const blocos = texto.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>/i)[0]);
  const linhas = [];
  const erros = [];
  for (const b of blocos) {
    const data = dataOfx(campo(b, 'DTPOSTED'));
    const valor = valorOfx(campo(b, 'TRNAMT'));
    const fitid = campo(b, 'FITID') || null;
    if (!data || valor === null) { erros.push(campo(b, 'MEMO') || campo(b, 'NAME') || '(linha sem data/valor)'); continue; }
    const descricao = [campo(b, 'NAME'), campo(b, 'MEMO')].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' — ').slice(0, 200);
    // Sem FITID (raro): id estável pelo conteúdo, para reimportar não duplicar.
    linhas.push({ fitid: fitid || `sem-fitid:${data}:${valor}:${descricao}`, data, valor, descricao });
  }
  if (linhas.length === 0) return { ok: false, error: 'Nenhum lançamento encontrado no extrato.' };
  return { ok: true, conta, linhas, ignoradas: erros.length };
}

function importar({ buffer, operadorId } = {}) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, error: 'Arquivo inválido.' };
  if (buffer.length > TAMANHO_MAXIMO) return { ok: false, error: 'Arquivo grande demais para um extrato (máx. 5 MB).' };
  const lido = parseOfx(decodificar(buffer));
  if (!lido.ok) return lido;
  const db = getDb();
  let importadas = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO bank_statement_lines (id, conta, fitid, data, valor, descricao, operador_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const l of lido.linhas) importadas += ins.run(randomUUID(), lido.conta, l.fitid, l.data, l.valor, l.descricao, operadorId || null).changes;
  })();
  const datas = lido.linhas.map((l) => l.data).sort();
  return { ok: true, conta: lido.conta, importadas, repetidas: lido.linhas.length - importadas, ignoradas: lido.ignoradas, de: datas[0], ate: datas[datas.length - 1] };
}

// ---------- sugestões e conciliação ----------

function jaVinculado(db, tipo, id) {
  return !!db.prepare("SELECT 1 FROM bank_statement_lines WHERE status = 'conciliado' AND vinculo_tipo = ? AND vinculo_id = ?").get(tipo, id);
}

function sugestoesDaLinha(db, linha, cacheCartao) {
  const lista = [];
  const valor = Math.abs(linha.valor);
  if (linha.valor < 0) {
    const despesas = db.prepare(
      `SELECT id, descricao, valor, data_vencimento, data_pagamento FROM expenses
       WHERE abs(valor - ?) < 0.01 AND (
         (data_pagamento IS NOT NULL AND date(data_pagamento, '-3 hours') BETWEEN ? AND ?)
         OR (data_pagamento IS NULL AND data_vencimento BETWEEN ? AND ?))`
    ).all(valor, somarDias(linha.data, -5), somarDias(linha.data, 5), somarDias(linha.data, -15), somarDias(linha.data, 10));
    for (const d of despesas) {
      if (jaVinculado(db, 'despesa', d.id)) continue;
      const ref = d.data_pagamento ? String(d.data_pagamento).slice(0, 10) : d.data_vencimento;
      lista.push({ tipo: 'despesa', id: d.id, descricao: d.descricao, valor: d.valor, data: ref, pendente: !d.data_pagamento, distancia: Math.abs(diasEntre(ref, linha.data)) });
    }
  } else {
    const recebiveis = db.prepare(
      `SELECT r.id, r.descricao, r.valor, r.vencimento, r.recebido_em, c.nome FROM receivables r LEFT JOIN customers c ON c.id = r.customer_id
       WHERE r.cancelado_em IS NULL AND abs(COALESCE(r.valor_recebido, r.valor) - ?) < 0.01
         AND COALESCE(r.recebido_em, r.vencimento) BETWEEN ? AND ?`
    ).all(valor, somarDias(linha.data, -10), somarDias(linha.data, 10));
    for (const r of recebiveis) {
      if (jaVinculado(db, 'recebivel', r.id)) continue;
      const ref = r.recebido_em || r.vencimento;
      lista.push({ tipo: 'recebivel', id: r.id, descricao: `${r.descricao}${r.nome ? ` (${r.nome})` : ''}`, valor: r.valor, data: ref, pendente: !r.recebido_em, distancia: Math.abs(diasEntre(ref, linha.data)) });
    }
    // Repasse da maquininha: líquido previsto para o dia (débito + crédito), 2% de tolerância.
    const previsto = cacheCartao.get(linha.data);
    if (previsto && Math.abs(previsto - valor) <= Math.max(0.05, previsto * 0.02) && !jaVinculado(db, 'cartao', `cartao:${linha.data}`)) {
      lista.push({ tipo: 'cartao', id: `cartao:${linha.data}`, descricao: `Repasse do cartão previsto para ${linha.data.split('-').reverse().join('/')}`, valor: previsto, data: linha.data, pendente: false, distancia: 0 });
    }
  }
  return lista.sort((a, b) => a.distancia - b.distancia).slice(0, 5);
}

function repassesDeCartao(db, locationId, de, ate) {
  const fin = require('./financeiroService');
  const taxas = fin.getTaxas();
  const maiorPrazo = Math.max(...taxas.map((t) => t.prazo_dias));
  const vendas = fin.vendasComPagamentos(db, locationId, somarDias(de, -maiorPrazo - 1), ate);
  const porDia = new Map();
  for (const r of fin.recebimentosDeCartao(vendas, taxas)) porDia.set(r.data, arred((porDia.get(r.data) || 0) + r.liquido));
  return porDia;
}

function listar({ locationId, status = 'pendente', dataInicio, dataFim } = {}) {
  const db = getDb();
  const filtros = [];
  const args = [];
  if (status && status !== 'todos') { filtros.push('status = ?'); args.push(status); }
  if (dataInicio) { filtros.push('data >= ?'); args.push(dataInicio); }
  if (dataFim) { filtros.push('data <= ?'); args.push(dataFim); }
  const linhas = db.prepare(`SELECT * FROM bank_statement_lines ${filtros.length ? `WHERE ${filtros.join(' AND ')}` : ''} ORDER BY data DESC, valor LIMIT 500`).all(...args);
  const pendentes = linhas.filter((l) => l.status === 'pendente');
  const datas = pendentes.map((l) => l.data).sort();
  const cartao = pendentes.some((l) => l.valor > 0) && locationId ? repassesDeCartao(db, locationId, datas[0], datas[datas.length - 1]) : new Map();
  const contagem = db.prepare('SELECT status, COUNT(*) AS qtd, COALESCE(SUM(valor), 0) AS total FROM bank_statement_lines GROUP BY status').all();
  return {
    ok: true,
    resumo: Object.fromEntries(contagem.map((c) => [c.status, { qtd: c.qtd, total: arred(c.total) }])),
    linhas: linhas.map((l) => (l.status === 'pendente' ? { ...l, sugestoes: sugestoesDaLinha(db, l, cartao) } : l)),
  };
}

function linhaPendente(db, linhaId) {
  const l = db.prepare('SELECT * FROM bank_statement_lines WHERE id = ?').get(linhaId);
  if (!l) return { erro: 'Linha do extrato não encontrada.' };
  if (l.status !== 'pendente') return { erro: 'Esta linha já foi conciliada ou ignorada.' };
  return { linha: l };
}

/** Casa a linha com o que ela pagou/recebeu. Conta em aberto é baixada na data do extrato. */
function conciliar({ linhaId, tipo, vinculoId, operadorId } = {}) {
  const db = getDb();
  const { linha, erro } = linhaPendente(db, linhaId);
  if (erro) return { ok: false, error: erro };
  if (!['despesa', 'recebivel', 'cartao'].includes(tipo)) return { ok: false, error: 'Tipo de vínculo inválido.' };
  if (jaVinculado(db, tipo, vinculoId)) return { ok: false, error: 'Isso já foi conciliado com outra linha do extrato.' };
  const fin = require('./financeiroService');
  const hoje = timeService.hojeLocalISO();
  const data = linha.data > hoje ? hoje : linha.data;
  let resultado = { ok: true };
  db.transaction(() => {
    if (tipo === 'despesa') {
      if (!(linha.valor < 0)) { resultado = { ok: false, error: 'Despesa só casa com saída do extrato.' }; return; }
      const e = db.prepare('SELECT id, valor, data_pagamento FROM expenses WHERE id = ?').get(vinculoId);
      if (!e) { resultado = { ok: false, error: 'Despesa não encontrada.' }; return; }
      if (!e.data_pagamento) {
        const r = fin.pagarDespesaNaData({ expenseId: e.id, data });
        if (!r.ok) { resultado = r; return; }
      }
    } else if (tipo === 'recebivel') {
      if (!(linha.valor > 0)) { resultado = { ok: false, error: 'Conta a receber só casa com entrada do extrato.' }; return; }
      const r0 = db.prepare('SELECT id, recebido_em, cancelado_em FROM receivables WHERE id = ?').get(vinculoId);
      if (!r0 || r0.cancelado_em) { resultado = { ok: false, error: 'Conta a receber não encontrada.' }; return; }
      if (!r0.recebido_em) {
        const r = fin.receberRecebivel({ id: r0.id, data, valor: linha.valor });
        if (!r.ok) { resultado = r; return; }
      }
    } else if (!/^cartao:\d{4}-\d{2}-\d{2}$/.test(String(vinculoId)) || !(linha.valor > 0)) {
      resultado = { ok: false, error: 'Repasse de cartão inválido.' };
      return;
    }
    db.prepare("UPDATE bank_statement_lines SET status = 'conciliado', vinculo_tipo = ?, vinculo_id = ?, conciliado_em = datetime('now'), operador_id = ? WHERE id = ?")
      .run(tipo, vinculoId, operadorId || null, linhaId);
  })();
  return resultado;
}

/** Saída do extrato que não tinha conta lançada: vira despesa paga naquele dia. */
function criarDespesa({ linhaId, categoria, descricao, centroCustoId, locationId, operadorId } = {}) {
  const db = getDb();
  const { linha, erro } = linhaPendente(db, linhaId);
  if (erro) return { ok: false, error: erro };
  if (!(linha.valor < 0)) return { ok: false, error: 'Só saídas do extrato viram despesa.' };
  const fin = require('./financeiroService');
  if (!fin.CATEGORIAS_VALIDAS.has(categoria)) return { ok: false, error: 'Categoria inválida.' };
  let resultado;
  try {
    db.transaction(() => {
      const r = require('./expenseService').create({
        categoria, descricao: String(descricao || linha.descricao || 'Saída do extrato').slice(0, 200), valor: Math.abs(linha.valor),
        dataVencimento: linha.data, locationId, operadorId, centroCustoId,
      });
      if (!r.ok) { resultado = r; return; }
      const hoje = timeService.hojeLocalISO();
      const p = fin.pagarDespesaNaData({ expenseId: r.id, data: linha.data > hoje ? hoje : linha.data });
      if (!p.ok) throw new Error(p.error);
      db.prepare("UPDATE bank_statement_lines SET status = 'conciliado', vinculo_tipo = 'despesa', vinculo_id = ?, conciliado_em = datetime('now'), operador_id = ? WHERE id = ?")
        .run(r.id, operadorId || null, linhaId);
      resultado = { ok: true, expenseId: r.id };
    })();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return resultado;
}

function ignorar({ linhaId, operadorId } = {}) {
  const db = getDb();
  const { erro } = linhaPendente(db, linhaId);
  if (erro) return { ok: false, error: erro };
  db.prepare("UPDATE bank_statement_lines SET status = 'ignorado', vinculo_tipo = 'outro', conciliado_em = datetime('now'), operador_id = ? WHERE id = ?").run(operadorId || null, linhaId);
  return { ok: true };
}

/** Volta a linha para pendente. Não desfaz o pagamento/recebimento lançado (isso é no Financeiro). */
function desfazer({ linhaId } = {}) {
  const r = getDb().prepare("UPDATE bank_statement_lines SET status = 'pendente', vinculo_tipo = NULL, vinculo_id = NULL, conciliado_em = NULL WHERE id = ? AND status != 'pendente'").run(linhaId);
  return r.changes ? { ok: true } : { ok: false, error: 'Linha não encontrada ou já pendente.' };
}

module.exports = { parseOfx, importar, listar, conciliar, criarDespesa, ignorar, desfazer, TAMANHO_MAXIMO };
