const { getDb } = require('../db/database');
const timeService = require('./timeService');

/**
 * Exportação contábil (ERP, Fase 5): lançamentos GERENCIAIS em partidas
 * dobradas de um mês, montados do que o app já registra (vendas, cartão,
 * fiado, compras, despesas, devoluções, CMV), com o de-para para o plano de
 * contas do escritório. Não é escrituração oficial: é a base que o contador
 * importa e valida. Nada é gravado -- muda a venda, muda o lançamento.
 */

const arred = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const ehCompetencia = (c) => /^\d{4}-(0[1-9]|1[0-2])$/.test(c || '');

const CATEGORIA_NOME = {
  aluguel: 'Aluguel', contas_consumo: 'Água, luz e internet', salario: 'Salários', impostos: 'Impostos e taxas',
  taxas_bancarias: 'Tarifas bancárias', manutencao: 'Manutenção', marketing: 'Marketing', servicos_terceiros: 'Serviços de terceiros', outro: 'Outras despesas',
};

const PADRAO = [
  ['caixa', '1.1.1.01', 'Caixa'],
  ['banco', '1.1.1.02', 'Bancos conta movimento'],
  ['cartao_receber', '1.1.2.01', 'Cartões a receber'],
  ['clientes', '1.1.2.02', 'Clientes a receber (fiado)'],
  ['estoque', '1.1.3.01', 'Estoque de mercadorias'],
  ['fornecedores', '2.1.1.01', 'Fornecedores'],
  ['contas_pagar', '2.1.1.02', 'Contas a pagar'],
  ['retirada_socio', '2.3.1.01', 'Retiradas dos sócios'],
  ['receita_vendas', '3.1.1.01', 'Receita de vendas de mercadorias'],
  ['receita_outras', '3.1.3.01', 'Outras receitas'],
  ['deducoes', '3.1.2.01', 'Devoluções de vendas'],
  ['cmv', '4.1.1.01', 'Custo das mercadorias vendidas'],
  ['taxas_cartao', '4.2.1.01', 'Taxas de cartão'],
  // Contas para lançamentos manuais e encargos de baixa (terceira leva).
  ['imobilizado', '1.2.1.01', 'Imobilizado (máquinas, móveis, veículos)'],
  ['emprestimos', '2.1.2.01', 'Empréstimos e financiamentos'],
  ['impostos_recolher', '2.1.3.01', 'Impostos a recolher'],
  ['capital_social', '2.4.1.01', 'Capital social'],
  ['receitas_financeiras', '3.1.3.02', 'Receitas financeiras (juros e multas recebidos)'],
  ['despesas_financeiras', '4.3.1.01', 'Despesas financeiras (juros e multas pagos)'],
  ...Object.entries(CATEGORIA_NOME).map(([cat, nome], i) => [`despesa:${cat}`, `4.2.2.${String(i + 1).padStart(2, '0')}`, nome]),
];

function garantirPadrao(db) {
  const ins = db.prepare('INSERT OR IGNORE INTO accounting_map (chave, codigo, nome) VALUES (?, ?, ?)');
  db.transaction(() => { for (const [k, c, n] of PADRAO) ins.run(k, c, n); })();
}

function planoDeContas() {
  const db = getDb();
  garantirPadrao(db);
  const ordem = new Map(PADRAO.map(([k], i) => [k, i]));
  return db.prepare('SELECT chave, codigo, nome FROM accounting_map').all().sort((a, b) => (ordem.get(a.chave) ?? 999) - (ordem.get(b.chave) ?? 999));
}

function salvarPlano({ contas } = {}) {
  const db = getDb();
  garantirPadrao(db);
  if (!Array.isArray(contas)) return { ok: false, error: 'Nada para salvar.' };
  for (const c of contas) {
    if (!PADRAO.some(([k]) => k === c.chave)) return { ok: false, error: `Conta desconhecida: ${c.chave}` };
    if (!/^[\w.\-]{1,30}$/.test(String(c.codigo || ''))) return { ok: false, error: `Código inválido em "${c.nome || c.chave}" (letras, números, ponto e traço, até 30).` };
    if (!String(c.nome || '').trim() || String(c.nome).length > 80) return { ok: false, error: 'Nome da conta inválido.' };
  }
  db.transaction(() => {
    for (const c of contas) db.prepare('UPDATE accounting_map SET codigo = ?, nome = ? WHERE chave = ?').run(String(c.codigo), String(c.nome).trim(), c.chave);
  })();
  return { ok: true };
}

function ultimoDia(comp) {
  const [a, m] = comp.split('-').map(Number);
  return `${comp}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** Lançamentos do mês (agrupados por par débito/crédito e histórico) + balancete. */
function lancamentos({ locationId, competencia, ignorarFechamento = false } = {}) {
  if (!ehCompetencia(competencia)) return { ok: false, error: 'Mês inválido.' };
  const db = getDb();
  // Mês fechado: vale a foto gravada no fechamento, não o recálculo.
  const fechado = ignorarFechamento ? null : mesFechado(db, locationId, competencia);
  if (fechado) return { ...JSON.parse(fechado.snapshot_json), fechado: { em: fechado.fechado_em, porId: fechado.fechado_por_id } };
  const fin = require('./financeiroService');
  const plano = Object.fromEntries(planoDeContas().map((c) => [c.chave, c]));
  const de = `${competencia}-01`;
  const ate = ultimoDia(competencia);
  const hoje = timeService.hojeLocalISO();
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(de, ate);
  const lista = [];
  const lancar = (debito, credito, valor, historico, data = ate) => {
    const v = arred(valor);
    if (v > 0.004) lista.push({ data, debito, credito, valor: v, historico });
  };

  // 1) Vendas pelo que entrou (dinheiro limitado ao devido, sem o troco).
  const vendas = fin.vendasComPagamentos(db, locationId, de, ate);
  const soma = (k) => vendas.reduce((s, v) => s + (v[k] || 0), 0);
  lancar('caixa', 'receita_vendas', soma('dinheiro'), 'Vendas em dinheiro do mês');
  lancar('banco', 'receita_vendas', soma('pix'), 'Vendas no Pix/outros do mês');
  lancar('cartao_receber', 'receita_vendas', soma('debito') + soma('credito'), 'Vendas no cartão do mês');
  lancar('clientes', 'receita_vendas', soma('fiado'), 'Vendas no fiado do mês');

  // 2) Cartão: taxa das vendas do mês e repasses que caíram no mês.
  const taxas = fin.getTaxas();
  const maiorPrazo = Math.max(...taxas.map((t) => t.prazo_dias));
  const recebimentos = fin.recebimentosDeCartao(fin.vendasComPagamentos(db, locationId, fin.somarDias(de, -maiorPrazo - 1), ate), taxas);
  lancar('taxas_cartao', 'cartao_receber', recebimentos.filter((r) => r.dataVenda >= de && r.dataVenda <= ate).reduce((s, r) => s + r.taxa, 0), 'Taxas das maquininhas');
  lancar('banco', 'cartao_receber', recebimentos.filter((r) => r.data >= de && r.data <= ate && r.data <= hoje).reduce((s, r) => s + r.liquido, 0), 'Repasses de cartão recebidos');

  // 3) Fiado recebido e contas a receber lançadas recebidas.
  const fiadoPago = db.prepare(
    `SELECT COALESCE(SUM(valor), 0) AS t FROM customer_credit_movements WHERE tipo = 'pagamento' AND criado_em >= ? AND criado_em < ?`
  ).get(inicioUtc, fimUtcExclusivo).t;
  lancar('caixa', 'clientes', fiadoPago, 'Recebimento de fiado');
  const outras = db.prepare(
    `SELECT COALESCE(SUM(valor_recebido), 0) AS t, COALESCE(SUM(COALESCE(juros, 0) + COALESCE(multa, 0)), 0) AS encargos
     FROM receivables WHERE location_id = ? AND recebido_em BETWEEN ? AND ?`
  ).get(locationId, de, ate);
  lancar('banco', 'receita_outras', outras.t - outras.encargos, 'Contas a receber recebidas');
  lancar('banco', 'receitas_financeiras', outras.encargos, 'Juros e multas recebidos');

  // 4) Devoluções, CMV e compras.
  const devolucoes = db.prepare('SELECT COALESCE(SUM(valor_devolvido), 0) AS t FROM returns WHERE location_id = ? AND criado_em >= ? AND criado_em < ?')
    .get(locationId, inicioUtc, fimUtcExclusivo).t;
  lancar('deducoes', 'caixa', devolucoes, 'Devoluções de vendas');
  const dre = fin.dre({ locationId, competencias: [competencia] });
  const mes = dre.ok ? dre.meses[0] : null;
  if (mes) lancar('cmv', 'estoque', mes.cmv, 'Custo das mercadorias vendidas (custo médio)');
  const compras = db.prepare(
    `SELECT COALESCE(SUM(valor_total), 0) AS t FROM nfe_entradas WHERE location_id = ? AND status = 'confirmada' AND confirmada_em >= ? AND confirmada_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo).t;
  lancar('estoque', 'fornecedores', compras, 'Compras de mercadoria (NF-e de entrada)');

  // 5) Despesas: reconhecidas na competência, baixadas no pagamento.
  const despesas = db.prepare(
    `SELECT categoria, SUM(valor - COALESCE(juros, 0) - COALESCE(multa, 0)) AS t FROM expenses WHERE location_id = ? AND nfe_entrada_id IS NULL
       AND COALESCE(competencia, substr(data_vencimento, 1, 7), strftime('%Y-%m', data_pagamento, '-3 hours'), strftime('%Y-%m', criado_em, '-3 hours')) = ?
     GROUP BY categoria`
  ).all(locationId, competencia);
  for (const d of despesas) {
    const conta = d.categoria === 'retirada_socio' ? 'retirada_socio' : d.categoria === 'fornecedor' ? 'estoque' : (plano[`despesa:${d.categoria}`] ? `despesa:${d.categoria}` : 'despesa:outro');
    lancar(conta, d.categoria === 'fornecedor' ? 'fornecedores' : 'contas_pagar', d.t, `${CATEGORIA_NOME[d.categoria] || (d.categoria === 'fornecedor' ? 'Compras sem nota' : d.categoria === 'retirada_socio' ? 'Retiradas' : 'Despesas')} do mês`);
  }
  const pagas = db.prepare(
    `SELECT CASE WHEN nfe_entrada_id IS NOT NULL OR categoria = 'fornecedor' THEN 'fornecedores' ELSE 'contas_pagar' END AS conta, SUM(valor) AS t
     FROM expenses WHERE location_id = ? AND data_pagamento >= ? AND data_pagamento < ? GROUP BY conta`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  // Juros e multa da baixa: despesa financeira (o principal já foi reconhecido acima).
  const encargos = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(juros, 0) + COALESCE(multa, 0)), 0) AS t FROM expenses WHERE location_id = ? AND data_pagamento >= ? AND data_pagamento < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo).t;
  lancar('despesas_financeiras', 'contas_pagar', encargos, 'Juros e multas de contas pagas em atraso');
  for (const p of pagas) lancar(p.conta, 'banco', p.t, p.conta === 'fornecedores' ? 'Pagamento a fornecedores' : 'Pagamento de contas');

  // Lançamentos manuais do mês (ajustes do contador, capital, empréstimos...).
  for (const m of manuaisDoMes(db, locationId, competencia)) {
    const v = arred(m.valor);
    if (v > 0) lista.push({ data: m.data, debito: m.debito, credito: m.credito, valor: v, historico: m.historico, manual: true, id: m.id, estornoDeId: m.estorno_de_id || null });
  }

  // Códigos do plano + balancete.
  const linhas = lista.map((l, i) => ({
    ...l, numero: i + 1,
    debitoCodigo: plano[l.debito].codigo, debitoNome: plano[l.debito].nome,
    creditoCodigo: plano[l.credito].codigo, creditoNome: plano[l.credito].nome,
  }));
  const contas = new Map();
  const mov = (chave, d, c) => {
    const x = contas.get(chave) || { chave, codigo: plano[chave].codigo, nome: plano[chave].nome, debitos: 0, creditos: 0 };
    x.debitos = arred(x.debitos + d);
    x.creditos = arred(x.creditos + c);
    contas.set(chave, x);
  };
  for (const l of linhas) { mov(l.debito, l.valor, 0); mov(l.credito, 0, l.valor); }
  const balancete = [...contas.values()].map((c) => ({ ...c, saldo: arred(c.debitos - c.creditos) })).sort((a, b) => a.codigo.localeCompare(b.codigo));
  const totalDebitos = arred(linhas.reduce((s, l) => s + l.valor, 0));
  return { ok: true, competencia, linhas, balancete, totalDebitos, totalCreditos: totalDebitos, fechado: null };
}

// ---------- lançamentos manuais, fechamento, razão e DRE contábil ----------

const DESCRICAO_MES = (c) => `${c.slice(5, 7)}/${c.slice(0, 4)}`;

function mesFechado(db, locationId, competencia) {
  try {
    return db.prepare('SELECT * FROM accounting_periods WHERE location_id = ? AND competencia = ?').get(locationId, competencia) || null;
  } catch (err) {
    if (/no such table/i.test(err.message || '')) return null; // migração versionada pendente
    throw err;
  }
}

/** Erro pronto se alguma das datas (AAAA-MM-DD ou AAAA-MM) cai num mês fechado. */
function bloqueioPorFechamento(locationId, datas) {
  const db = getDb();
  for (const d of datas || []) {
    if (!d) continue;
    const comp = String(d).slice(0, 7);
    if (!ehCompetencia(comp)) continue;
    if (mesFechado(db, locationId, comp)) {
      return { ok: false, periodoFechado: true, error: `O mês ${DESCRICAO_MES(comp)} está fechado na contabilidade. Para mudar algo com data nesse mês, o administrador precisa reabri-lo (Financeiro → Contabilidade).` };
    }
  }
  return null;
}

function manuaisDoMes(db, locationId, competencia) {
  try {
    return db.prepare(
      'SELECT * FROM journal_entries WHERE location_id = ? AND data BETWEEN ? AND ? ORDER BY data, criado_em, rowid'
    ).all(locationId, `${competencia}-01`, ultimoDia(competencia));
  } catch (err) {
    if (/no such table/i.test(err.message || '')) return [];
    throw err;
  }
}

function auditar(db, { tipo, operadorId, motivo, entidade, entidadeId, antes, depois }) {
  db.prepare(
    `INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso, entidade, entidade_id, dados_antes, dados_depois)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).run(require('crypto').randomUUID(), tipo, operadorId || null, motivo, entidade, entidadeId,
    antes === undefined ? null : JSON.stringify(antes), depois === undefined ? null : JSON.stringify(depois));
}

/** Lançamento manual em partidas dobradas (débito e crédito do plano). */
function lancarManual({ locationId, data, debito, credito, valor, historico, operadorId } = {}) {
  const db = getDb();
  const plano = Object.fromEntries(planoDeContas().map((c) => [c.chave, c]));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ''))) return { ok: false, error: 'Informe a data do lançamento.' };
  if (data > timeService.hojeLocalISO()) return { ok: false, error: 'O lançamento não pode ter data futura.' };
  if (!plano[debito] || !plano[credito]) return { ok: false, error: 'Escolha a conta de débito e a de crédito.' };
  if (debito === credito) return { ok: false, error: 'Débito e crédito precisam ser contas diferentes.' };
  const v = arred(valor);
  if (!(v > 0)) return { ok: false, error: 'Informe um valor maior que zero.' };
  const texto = String(historico || '').trim();
  if (!texto || texto.length > 200) return { ok: false, error: 'Escreva o histórico (até 200 caracteres): o que é esse lançamento.' };
  const bloqueio = bloqueioPorFechamento(locationId, [data]);
  if (bloqueio) return bloqueio;
  const id = require('crypto').randomUUID();
  db.transaction(() => {
    db.prepare('INSERT INTO journal_entries (id, location_id, data, debito, credito, valor, historico, operador_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, locationId, data, debito, credito, v, texto, operadorId);
    auditar(db, { tipo: 'contabil_lancamento_manual', operadorId, motivo: `${plano[debito].nome} × ${plano[credito].nome}: R$ ${v.toFixed(2)} — ${texto}`, entidade: 'journal_entries', entidadeId: id, depois: { data, debito, credito, valor: v, historico: texto } });
  })();
  return { ok: true, id };
}

/** Estorno: lançamento inverso com a data de hoje (o original nunca muda). */
function estornarManual({ id, locationId, motivo, operadorId } = {}) {
  const db = getDb();
  const l = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(id);
  if (!l || (locationId && l.location_id !== locationId)) return { ok: false, error: 'Lançamento não encontrado.' };
  if (l.estorno_de_id) return { ok: false, error: 'Este lançamento já é um estorno.' };
  if (db.prepare('SELECT 1 FROM journal_entries WHERE estorno_de_id = ?').get(id)) return { ok: false, error: 'Este lançamento já foi estornado.' };
  const hoje = timeService.hojeLocalISO();
  const bloqueio = bloqueioPorFechamento(l.location_id, [hoje]);
  if (bloqueio) return bloqueio;
  const novoId = require('crypto').randomUUID();
  const texto = `Estorno: ${l.historico}${motivo ? ` (${String(motivo).trim().slice(0, 80)})` : ''}`.slice(0, 200);
  db.transaction(() => {
    db.prepare('INSERT INTO journal_entries (id, location_id, data, debito, credito, valor, historico, estorno_de_id, operador_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(novoId, l.location_id, hoje, l.credito, l.debito, l.valor, texto, l.id, operadorId);
    auditar(db, { tipo: 'contabil_estorno', operadorId, motivo: texto, entidade: 'journal_entries', entidadeId: novoId, antes: { id: l.id }, depois: { estornoDe: l.id, valor: l.valor } });
  })();
  return { ok: true, id: novoId };
}

/** Fecha o mês: grava a foto dos lançamentos e trava mudanças com data nele. */
function fecharMes({ locationId, competencia, operadorId } = {}) {
  if (!ehCompetencia(competencia)) return { ok: false, error: 'Mês inválido.' };
  const db = getDb();
  if (competencia >= timeService.hojeLocalISO().slice(0, 7)) return { ok: false, error: 'Só dá para fechar um mês que já terminou.' };
  if (mesFechado(db, locationId, competencia)) return { ok: false, error: `O mês ${DESCRICAO_MES(competencia)} já está fechado.` };
  const r = lancamentos({ locationId, competencia, ignorarFechamento: true });
  if (!r.ok) return r;
  const { fechado, ...foto } = r;
  db.transaction(() => {
    db.prepare('INSERT INTO accounting_periods (location_id, competencia, fechado_por_id, snapshot_json) VALUES (?, ?, ?, ?)')
      .run(locationId, competencia, operadorId, JSON.stringify(foto));
    auditar(db, { tipo: 'contabil_mes_fechado', operadorId, motivo: `Mês ${DESCRICAO_MES(competencia)} fechado (${r.linhas.length} lançamentos, R$ ${r.totalDebitos.toFixed(2)})`, entidade: 'accounting_periods', entidadeId: competencia, depois: { linhas: r.linhas.length, total: r.totalDebitos } });
  })();
  return { ok: true };
}

/** Reabre um mês fechado (só admin/suporte -- conferido no handler) com motivo. */
function reabrirMes({ locationId, competencia, motivo, operadorId } = {}) {
  const db = getDb();
  const f = mesFechado(db, locationId, competencia);
  if (!f) return { ok: false, error: 'Este mês não está fechado.' };
  const texto = String(motivo || '').trim();
  if (texto.length < 5) return { ok: false, error: 'Explique por que o mês está sendo reaberto.' };
  const foto = JSON.parse(f.snapshot_json);
  db.transaction(() => {
    db.prepare('DELETE FROM accounting_periods WHERE location_id = ? AND competencia = ?').run(locationId, competencia);
    auditar(db, { tipo: 'contabil_mes_reaberto', operadorId, motivo: `Mês ${DESCRICAO_MES(competencia)} reaberto — ${texto}`, entidade: 'accounting_periods', entidadeId: competencia, antes: { fechadoEm: f.fechado_em, fechadoPorId: f.fechado_por_id, linhas: foto.linhas?.length, total: foto.totalDebitos } });
  })();
  return { ok: true };
}

function listarFechamentos({ locationId } = {}) {
  const db = getDb();
  try {
    return db.prepare(
      `SELECT p.competencia, p.fechado_em, u.nome AS fechado_por FROM accounting_periods p LEFT JOIN users u ON u.id = p.fechado_por_id
       WHERE p.location_id = ? ORDER BY p.competencia DESC`
    ).all(locationId);
  } catch (err) {
    if (/no such table/i.test(err.message || '')) return [];
    throw err;
  }
}

/** Livro razão de uma conta no mês: cada movimento com saldo corrente (D − C). */
function razao({ locationId, competencia, conta } = {}) {
  const r = lancamentos({ locationId, competencia });
  if (!r.ok) return r;
  const plano = Object.fromEntries(planoDeContas().map((c) => [c.chave, c]));
  if (!plano[conta]) return { ok: false, error: 'Conta não encontrada.' };
  let saldo = 0;
  const movimentos = r.linhas.filter((l) => l.debito === conta || l.credito === conta)
    .sort((a, b) => a.data.localeCompare(b.data) || a.numero - b.numero)
    .map((l) => {
      const debito = l.debito === conta ? l.valor : 0;
      const credito = l.credito === conta ? l.valor : 0;
      saldo = arred(saldo + debito - credito);
      return { data: l.data, historico: l.historico, contrapartida: l.debito === conta ? l.creditoNome : l.debitoNome, debito, credito, saldo };
    });
  return { ok: true, competencia, conta: plano[conta], movimentos, saldoFinal: saldo, fechado: r.fechado };
}

/** DRE contábil do mês, pelos lançamentos (classificação pela chave do plano, não pelo código). */
function dreContabil({ locationId, competencia } = {}) {
  const r = lancamentos({ locationId, competencia });
  if (!r.ok) return r;
  const saldo = (chave) => {
    const c = r.balancete.find((b) => b.chave === chave);
    return c ? c.creditos - c.debitos : 0; // natureza credora
  };
  const devedora = (filtro) => arred(r.balancete.filter((b) => filtro(b.chave)).reduce((s, b) => s + b.debitos - b.creditos, 0));
  const receitaBruta = arred(saldo('receita_vendas') + saldo('receita_outras'));
  const deducoes = arred(-saldo('deducoes'));
  const receitaLiquida = arred(receitaBruta - deducoes);
  const cmv = devedora((k) => k === 'cmv');
  const lucroBruto = arred(receitaLiquida - cmv);
  const despesasOperacionais = devedora((k) => k === 'taxas_cartao' || k.startsWith('despesa:'));
  const receitasFinanceiras = arred(saldo('receitas_financeiras'));
  const despesasFinanceiras = devedora((k) => k === 'despesas_financeiras');
  const resultado = arred(lucroBruto - despesasOperacionais + receitasFinanceiras - despesasFinanceiras);
  return {
    ok: true, competencia, fechado: r.fechado,
    linhas: [
      { rotulo: 'Receita bruta', valor: receitaBruta },
      { rotulo: '(−) Devoluções', valor: -deducoes },
      { rotulo: '= Receita líquida', valor: receitaLiquida, total: true },
      { rotulo: '(−) Custo das mercadorias vendidas', valor: -cmv },
      { rotulo: '= Lucro bruto', valor: lucroBruto, total: true },
      { rotulo: '(−) Despesas operacionais', valor: -despesasOperacionais },
      { rotulo: '(+) Receitas financeiras', valor: receitasFinanceiras },
      { rotulo: '(−) Despesas financeiras', valor: -despesasFinanceiras },
      { rotulo: '= Resultado do mês (antes de IRPJ/CSLL)', valor: resultado, total: true },
    ],
    resultado,
  };
}

async function xlsx({ locationId, competencia } = {}) {
  const r = lancamentos({ locationId, competencia });
  if (!r.ok) return r;
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const moeda = '#,##0.00';
  const aba = (nome, colunas, dados) => {
    const ws = wb.addWorksheet(nome);
    ws.columns = colunas.map(([header, key, width, numFmt]) => ({ header, key, width, style: numFmt ? { numFmt } : {} }));
    ws.getRow(1).font = { bold: true };
    dados.forEach((d) => ws.addRow(d));
  };
  const br = (iso) => iso.split('-').reverse().join('/');
  aba('Lançamentos', [['Nº', 'numero', 6], ['Data', 'data', 12], ['Débito', 'debitoCodigo', 14], ['Conta débito', 'debitoNome', 32],
    ['Crédito', 'creditoCodigo', 14], ['Conta crédito', 'creditoNome', 32], ['Valor', 'valor', 14, moeda], ['Histórico', 'historico', 44]],
  r.linhas.map((l) => ({ ...l, data: br(l.data) })));
  aba('Balancete', [['Código', 'codigo', 14], ['Conta', 'nome', 36], ['Débitos', 'debitos', 14, moeda], ['Créditos', 'creditos', 14, moeda], ['Saldo', 'saldo', 14, moeda]], r.balancete);
  aba('Plano (de-para)', [['Chave no app', 'chave', 26], ['Código', 'codigo', 14], ['Conta', 'nome', 40]], planoDeContas());
  const ws = wb.addWorksheet('Leia-me');
  ['Lançamentos gerenciais gerados pelo GerenciaAI a partir das vendas, compras e despesas do mês.',
    'Não é escrituração oficial: o contador confere, ajusta e importa no sistema contábil.',
    'Vendas entram pelo valor recebido (descontos já abatidos); dinheiro sem o troco.',
    'Cartão: a taxa vai para despesa e o repasse sai de "Cartões a receber" quando cai.',
    'Despesas são reconhecidas no mês de competência e baixadas no pagamento.',
  ].forEach((t) => ws.addRow([t]));
  ws.getColumn(1).width = 100;
  return { ok: true, buffer: Buffer.from(await wb.xlsx.writeBuffer()), nomeSugerido: `contabil-${competencia}.xlsx`, linhas: r.linhas.length };
}

module.exports = {
  planoDeContas, salvarPlano, lancamentos, xlsx, PADRAO,
  bloqueioPorFechamento, lancarManual, estornarManual, fecharMes, reabrirMes, listarFechamentos, razao, dreContabil,
};
