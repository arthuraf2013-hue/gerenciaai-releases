const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const timeService = require('./timeService');

/**
 * Financeiro do ERP (Fase 2): taxas das maquininhas, contas a receber,
 * despesas recorrentes e parceladas, fluxo de caixa e DRE.
 *
 * Princípio: nada de "segunda verdade". Venda, pagamento, fiado,
 * devolução e despesa já existem no banco; aqui só se LÊ deles. O que é
 * novo e precisa de tabela própria: taxa/prazo do cartão, conta a receber
 * lançada à mão, recorrência e o saldo inicial do caixa.
 *
 * Datas de calendário sempre em 'AAAA-MM-DD' local (Brasília); colunas de
 * evento (finalizada_em, criado_em) são UTC e se convertem com -3h.
 */

const METODOS_CARTAO = ['cartao_debito', 'cartao_credito'];
const PRAZO_PADRAO = { cartao_debito: 1, cartao_credito: 30 };
// Categorias que NÃO são despesa operacional no DRE: compra de mercadoria
// vira estoque e entra como CMV; retirada do dono é distribuição de lucro.
const CATEGORIAS_FORA_DO_DRE = ['fornecedor', 'retirada_socio'];

function arred(v, casas = 2) {
  const f = 10 ** casas;
  return Math.round((Number(v) + Number.EPSILON) * f) / f;
}

// ---------- datas ----------

function somarDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(dias));
  return d.toISOString().slice(0, 10);
}
function ultimoDiaDoMes(competencia) {
  const [a, m] = competencia.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}
function somarMeses(competencia, n) {
  const [a, m] = competencia.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function competenciasEntre(de, ate) {
  const lista = [];
  for (let c = de; c <= ate; c = somarMeses(c, 1)) lista.push(c);
  return lista;
}
function vencimentoNaCompetencia(competencia, dia) {
  return `${competencia}-${String(Math.min(Number(dia), ultimoDiaDoMes(competencia))).padStart(2, '0')}`;
}
const ehData = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const ehCompetencia = (v) => /^\d{4}-\d{2}$/.test(String(v || ''));
/** Data local (AAAA-MM-DD) de um timestamp UTC 'AAAA-MM-DD HH:MM:SS'. */
function dataLocalDeUtc(utc) {
  if (!utc) return null;
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  return new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 10);
}

// ---------- configuração ----------

function getConfig() {
  const db = getDb();
  let c = db.prepare('SELECT * FROM erp_config WHERE id = ?').get('default');
  if (!c) {
    db.prepare(`INSERT INTO erp_config (id) VALUES ('default')`).run();
    c = db.prepare('SELECT * FROM erp_config WHERE id = ?').get('default');
  }
  return c;
}

function salvarConfig(campos) {
  const db = getDb();
  getConfig();
  const permitidos = {
    saldoInicial: 'saldo_inicial', dataSaldoInicial: 'data_saldo_inicial', dataAberturaEmpresa: 'data_abertura_empresa',
    atividadeMei: 'atividade_mei', dasMeiValor: 'das_mei_valor', rbt12Anterior: 'rbt12_anterior', diaPacoteContador: 'dia_pacote_contador',
    anexoSimples: 'anexo_simples', folha12Meses: 'folha_12_meses',
  };
  // Valida tudo antes de gravar: um campo inválido no meio não pode deixar
  // metade da configuração salva.
  const aGravar = [];
  for (const [chave, coluna] of Object.entries(permitidos)) {
    if (!campos || !(chave in campos)) continue;
    let v = campos[chave];
    if (v === '' || v === undefined) v = null;
    if (['dataSaldoInicial', 'dataAberturaEmpresa'].includes(chave) && v !== null && !ehData(v)) return { ok: false, error: 'Data inválida.' };
    if (['saldoInicial', 'dasMeiValor', 'rbt12Anterior', 'folha12Meses'].includes(chave) && v !== null) {
      v = Number(v);
      if (!Number.isFinite(v) || (chave !== 'saldoInicial' && v < 0)) return { ok: false, error: 'Valor inválido.' };
    }
    if (chave === 'saldoInicial' && v === null) v = 0;
    if (chave === 'atividadeMei' && !['comercio', 'servicos', 'ambos'].includes(v)) return { ok: false, error: 'Atividade inválida.' };
    if (chave === 'anexoSimples') {
      v = v === null ? 'I' : String(v).toUpperCase();
      if (!['I', 'II', 'III', 'IV', 'V'].includes(v)) return { ok: false, error: 'Anexo do Simples: I, II, III, IV ou V.' };
    }
    if (chave === 'diaPacoteContador') {
      v = Number(v);
      if (!(v >= 1 && v <= 28)) return { ok: false, error: 'Dia do pacote do contador: de 1 a 28.' };
    }
    aGravar.push([coluna, v]);
  }
  db.transaction(() => {
    for (const [coluna, v] of aGravar) db.prepare(`UPDATE erp_config SET ${coluna} = ? WHERE id = 'default'`).run(v);
  })();
  return { ok: true, config: getConfig() };
}

function getTaxas() {
  const db = getDb();
  const salvas = new Map(db.prepare('SELECT * FROM card_fee_config').all().map((t) => [t.metodo, t]));
  return METODOS_CARTAO.map((m) => salvas.get(m) || { metodo: m, taxa_percentual: 0, prazo_dias: PRAZO_PADRAO[m] });
}

function salvarTaxas(taxas) {
  const db = getDb();
  for (const t of taxas || []) {
    if (!METODOS_CARTAO.includes(t.metodo)) return { ok: false, error: 'Forma de pagamento inválida.' };
    const taxa = Number(t.taxaPercentual);
    const prazo = Number(t.prazoDias);
    if (!(taxa >= 0 && taxa < 30)) return { ok: false, error: 'Taxa precisa estar entre 0% e 30%.' };
    if (!(Number.isInteger(prazo) && prazo >= 0 && prazo <= 120)) return { ok: false, error: 'Prazo de recebimento: de 0 a 120 dias.' };
  }
  db.transaction(() => {
    for (const t of taxas || []) {
      db.prepare(
        `INSERT INTO card_fee_config (metodo, taxa_percentual, prazo_dias) VALUES (?, ?, ?)
         ON CONFLICT(metodo) DO UPDATE SET taxa_percentual = excluded.taxa_percentual, prazo_dias = excluded.prazo_dias`
      ).run(t.metodo, Number(t.taxaPercentual), Number(t.prazoDias));
    }
  })();
  return { ok: true, taxas: getTaxas() };
}

// ---------- vendas -> dinheiro ----------

/**
 * Uma linha por venda finalizada no intervalo de datas locais: quanto
 * entrou em dinheiro (sem troco), pix/outro, cartão e fiado. Dinheiro é o
 * que falta depois dos outros meios -- o pagamento em dinheiro pode vir
 * com troco embutido (valor entregue > devido).
 */
function vendasComPagamentos(db, locationId, dataInicio, dataFim) {
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);
  const linhas = db.prepare(
    `SELECT s.id, s.finalizada_em,
       (s.total - s.desconto - s.desconto_gerente) * (1 + s.taxa_servico_percentual / 100.0) AS devido,
       COALESCE(SUM(CASE WHEN p.metodo = 'cartao_debito' THEN p.valor END), 0) AS debito,
       COALESCE(SUM(CASE WHEN p.metodo = 'cartao_credito' THEN p.valor END), 0) AS credito,
       COALESCE(SUM(CASE WHEN p.metodo IN ('pix', 'outro') THEN p.valor END), 0) AS pix,
       COALESCE(SUM(CASE WHEN p.metodo = 'fiado' THEN p.valor END), 0) AS fiado,
       COALESCE(SUM(CASE WHEN p.metodo = 'dinheiro' THEN p.valor END), 0) AS dinheiro_informado
     FROM sales s LEFT JOIN payments p ON p.sale_id = s.id
     WHERE s.location_id = ? AND s.status = 'finalizada' AND s.finalizada_em >= ? AND s.finalizada_em < ?
     GROUP BY s.id`
  ).all(locationId, inicioUtc, fimUtcExclusivo);
  return linhas.map((v) => {
    const outros = v.debito + v.credito + v.pix + v.fiado;
    const dinheiro = Math.min(v.dinheiro_informado, Math.max(0, v.devido - outros));
    return { ...v, data: dataLocalDeUtc(v.finalizada_em), dinheiro: arred(dinheiro) };
  });
}

/** Recebimento previsto de cada venda no cartão: data da venda + prazo,
 * valor líquido da taxa. */
function recebimentosDeCartao(vendas, taxas) {
  const t = Object.fromEntries(taxas.map((x) => [x.metodo, x]));
  const lista = [];
  for (const v of vendas) {
    for (const [metodo, bruto] of [['cartao_debito', v.debito], ['cartao_credito', v.credito]]) {
      if (!(bruto > 0)) continue;
      const taxa = arred(bruto * (Number(t[metodo].taxa_percentual) || 0) / 100);
      lista.push({ metodo, dataVenda: v.data, data: somarDias(v.data, t[metodo].prazo_dias), bruto, taxa, liquido: arred(bruto - taxa) });
    }
  }
  return lista;
}

// ---------- contas a receber ----------

function criarRecebivel({ descricao, customerId, valor, vencimento, locationId, operadorId }) {
  if (!String(descricao || '').trim()) return { ok: false, error: 'Informe a descrição.' };
  if (!(Number(valor) > 0)) return { ok: false, error: 'Informe um valor maior que zero.' };
  if (!ehData(vencimento)) return { ok: false, error: 'Informe o vencimento.' };
  const db = getDb();
  if (customerId && !db.prepare('SELECT 1 FROM customers WHERE id = ?').get(customerId)) return { ok: false, error: 'Cliente não encontrado.' };
  const id = randomUUID();
  db.prepare(
    `INSERT INTO receivables (id, descricao, customer_id, valor, vencimento, location_id, operador_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, String(descricao).trim(), customerId || null, arred(valor), vencimento, locationId, operadorId);
  return { ok: true, id };
}

function receberRecebivel({ id, data, valor }) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM receivables WHERE id = ?').get(id);
  if (!r) return { ok: false, error: 'Conta a receber não encontrada.' };
  if (r.recebido_em || r.cancelado_em) return { ok: false, error: 'Esta conta já foi baixada.' };
  const dataRecebimento = data || timeService.hojeLocalISO();
  if (!ehData(dataRecebimento)) return { ok: false, error: 'Data inválida.' };
  const bloqueio = fechamento().bloqueioPorFechamento(r.location_id, [dataRecebimento]);
  if (bloqueio) return bloqueio;
  const v = valor === undefined || valor === null || valor === '' ? r.valor : Number(valor);
  if (!(v > 0)) return { ok: false, error: 'Valor recebido inválido.' };
  db.prepare('UPDATE receivables SET recebido_em = ?, valor_recebido = ? WHERE id = ?').run(dataRecebimento, arred(v), id);
  return { ok: true };
}

// ---------- baixa com juros, multa, desconto e baixa parcial ----------

const fechamento = () => require('./contabilService');

/** Lê e valida os valores de uma baixa. principal = quanto do valor da
 * conta está sendo quitado (o que faltar vira uma conta nova com o saldo). */
function valoresDaBaixa({ saldo, principal, juros, multa, desconto }) {
  const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));
  const p = principal === undefined || principal === null || principal === '' ? saldo : Number(principal);
  const j = num(juros); const m = num(multa); const d = num(desconto);
  if (![p, j, m, d].every(Number.isFinite)) return { ok: false, error: 'Valor inválido.' };
  if (!(p > 0)) return { ok: false, error: 'Informe quanto está sendo pago (maior que zero).' };
  if (p > saldo + 0.005) return { ok: false, error: `O valor pago passa do valor da conta (R$ ${saldo.toFixed(2)}). Juros e multa vão nos campos próprios.` };
  if (j < 0 || m < 0 || d < 0) return { ok: false, error: 'Juros, multa e desconto não podem ser negativos.' };
  const total = arred(p + j + m - d);
  if (!(total > 0)) return { ok: false, error: 'O desconto não pode ser maior que o valor pago.' };
  return { ok: true, principal: arred(Math.min(p, saldo)), juros: arred(j), multa: arred(m), desconto: arred(d), total, parcial: p < saldo - 0.005 };
}

/**
 * Baixa de conta a receber com juros/multa/desconto. Baixa parcial: esta
 * conta fica com o valor pago e uma conta NOVA (mesmo vencimento, ligada
 * por parcial_de_id) nasce com o saldo -- assim todo relatório que já lia
 * "recebido_em/valor_recebido" continua certo sem mudar nada.
 */
function baixarRecebivel({ id, data, principal, juros, multa, desconto, operadorId }) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM receivables WHERE id = ?').get(id);
  if (!r) return { ok: false, error: 'Conta a receber não encontrada.' };
  if (r.recebido_em || r.cancelado_em) return { ok: false, error: 'Esta conta já foi baixada.' };
  const dia = data || timeService.hojeLocalISO();
  if (!ehData(dia) || dia > timeService.hojeLocalISO()) return { ok: false, error: 'Data de recebimento inválida (não pode ser futura).' };
  const bloqueio = fechamento().bloqueioPorFechamento(r.location_id, [dia]);
  if (bloqueio) return bloqueio;
  const v = valoresDaBaixa({ saldo: r.valor, principal, juros, multa, desconto });
  if (!v.ok) return v;
  let saldoId = null;
  db.transaction(() => {
    if (v.parcial) {
      saldoId = randomUUID();
      db.prepare(
        `INSERT INTO receivables (id, descricao, customer_id, valor, vencimento, location_id, operador_id, parcial_de_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(saldoId, r.descricao.endsWith(' (saldo)') ? r.descricao : `${r.descricao} (saldo)`, r.customer_id, arred(r.valor - v.principal), r.vencimento, r.location_id, operadorId || r.operador_id, r.id);
    }
    db.prepare('UPDATE receivables SET valor = ?, recebido_em = ?, valor_recebido = ?, juros = ?, multa = ?, desconto = ? WHERE id = ?')
      .run(v.principal, dia, v.total, v.juros || null, v.multa || null, v.desconto || null, id);
  })();
  return { ok: true, valorRecebido: v.total, saldoId, saldo: v.parcial ? arred(r.valor - v.principal) : 0 };
}

/** Baixa de despesa (conta a pagar) com juros/multa/desconto e parcial.
 * `valor` passa a ser o que saiu do caixa; `valor_original` guarda o
 * principal (o DRE e o fluxo já leem `valor`, então os encargos entram). */
function baixarDespesa({ expenseId, data, principal, juros, multa, desconto, operadorId }) {
  const db = getDb();
  const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId);
  if (!e) return { ok: false, error: 'Despesa não encontrada.' };
  if (e.data_pagamento) return { ok: false, error: 'Essa despesa já está marcada como paga.' };
  const dia = data || timeService.hojeLocalISO();
  if (!ehData(dia) || dia > timeService.hojeLocalISO()) return { ok: false, error: 'Data de pagamento inválida (não pode ser futura).' };
  const bloqueio = fechamento().bloqueioPorFechamento(e.location_id, [dia, e.competencia ? `${e.competencia}-01` : e.data_vencimento]);
  if (bloqueio) return bloqueio;
  const v = valoresDaBaixa({ saldo: e.valor, principal, juros, multa, desconto });
  if (!v.ok) return v;
  let saldoId = null;
  db.transaction(() => {
    if (v.parcial) {
      saldoId = randomUUID();
      // Sem recorrencia_id: o índice único (recorrência, competência) é da conta original.
      db.prepare(
        `INSERT INTO expenses (id, categoria, descricao, valor, fornecedor_id, data_vencimento, location_id, operador_id, nfe_entrada_id, competencia, centro_custo_id, parcial_de_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(saldoId, e.categoria, e.descricao.endsWith(' (saldo)') ? e.descricao : `${e.descricao} (saldo)`, arred(e.valor - v.principal), e.fornecedor_id,
        e.data_vencimento, e.location_id, operadorId || e.operador_id, e.nfe_entrada_id, e.competencia, e.centro_custo_id, e.id);
    }
    db.prepare(
      `UPDATE expenses SET valor = ?, valor_original = ?, juros = ?, multa = ?, desconto = ?, data_pagamento = ? WHERE id = ?`
    ).run(v.total, v.principal, v.juros || null, v.multa || null, v.desconto || null, `${dia} 15:00:00`, expenseId);
    db.prepare(
      `INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso, entidade, entidade_id, dados_antes, dados_depois)
       VALUES (?, 'despesa_baixada', ?, ?, 1, 'expenses', ?, ?, ?)`
    ).run(randomUUID(), operadorId || null, `"${e.descricao}": pago R$ ${v.total.toFixed(2)}${v.parcial ? ` (parcial; saldo R$ ${arred(e.valor - v.principal).toFixed(2)})` : ''}`,
      expenseId, JSON.stringify({ valor: e.valor, data_pagamento: null }), JSON.stringify({ valor: v.total, principal: v.principal, juros: v.juros, multa: v.multa, desconto: v.desconto, data_pagamento: dia }));
  })();
  return { ok: true, valorPago: v.total, saldoId, saldo: v.parcial ? arred(e.valor - v.principal) : 0 };
}

function cancelarRecebivel({ id }) {
  const db = getDb();
  const r = db.prepare('UPDATE receivables SET cancelado_em = ? WHERE id = ? AND recebido_em IS NULL AND cancelado_em IS NULL')
    .run(timeService.hojeLocalISO(), id);
  if (r.changes === 0) return { ok: false, error: 'Só conta em aberto pode ser cancelada.' };
  return { ok: true };
}

/**
 * Tudo que ainda vai entrar: cartão a cair (vendas já feitas), contas
 * lançadas à mão em aberto e o fiado em aberto (sem data: depende do cliente).
 */
function contasAReceber({ locationId }) {
  const db = getDb();
  const hoje = timeService.hojeLocalISO();
  const taxas = getTaxas();
  const maiorPrazo = Math.max(...taxas.map((t) => t.prazo_dias));
  const vendas = vendasComPagamentos(db, locationId, somarDias(hoje, -maiorPrazo - 1), hoje);
  const porDia = new Map();
  for (const r of recebimentosDeCartao(vendas, taxas).filter((x) => x.data > hoje)) {
    const k = `${r.data}|${r.metodo}`;
    const atual = porDia.get(k) || { data: r.data, metodo: r.metodo, bruto: 0, taxa: 0, liquido: 0, vendas: 0 };
    atual.bruto = arred(atual.bruto + r.bruto); atual.taxa = arred(atual.taxa + r.taxa);
    atual.liquido = arred(atual.liquido + r.liquido); atual.vendas += 1;
    porDia.set(k, atual);
  }
  const cartao = [...porDia.values()].sort((a, b) => a.data.localeCompare(b.data) || a.metodo.localeCompare(b.metodo));

  const manuais = db.prepare(
    `SELECT r.*, c.nome AS cliente_nome FROM receivables r LEFT JOIN customers c ON c.id = r.customer_id
     WHERE r.location_id = ? AND r.recebido_em IS NULL AND r.cancelado_em IS NULL ORDER BY r.vencimento`
  ).all(locationId).map((r) => ({ ...r, vencida: r.vencimento < hoje }));

  const fiado = db.prepare(
    `SELECT c.id, c.nome, c.telefone, SUM(CASE WHEN m.tipo = 'divida' THEN m.valor ELSE -m.valor END) AS saldo,
       MIN(CASE WHEN m.tipo = 'divida' THEN m.criado_em END) AS desde
     FROM customer_credit_movements m JOIN customers c ON c.id = m.customer_id
     GROUP BY c.id HAVING saldo > 0.004 ORDER BY saldo DESC`
  ).all().map((f) => ({ ...f, saldo: arred(f.saldo), desde: dataLocalDeUtc(f.desde) }));

  const soma = (l, k) => arred(l.reduce((s, x) => s + x[k], 0));
  return {
    cartao, manuais, fiado,
    totais: { cartao: soma(cartao, 'liquido'), manuais: soma(manuais, 'valor'), fiado: soma(fiado, 'saldo') },
  };
}

// ---------- despesas recorrentes e parceladas ----------

const CATEGORIAS_VALIDAS = new Set([
  'aluguel', 'contas_consumo', 'fornecedor', 'salario', 'impostos', 'taxas_bancarias', 'manutencao',
  'marketing', 'servicos_terceiros', 'retirada_socio', 'outro',
]);

function criarRecorrencia({ descricao, categoria, valor, diaVencimento, fornecedorId, competenciaInicio, locationId, operadorId }) {
  if (!String(descricao || '').trim()) return { ok: false, error: 'Informe a descrição.' };
  if (!CATEGORIAS_VALIDAS.has(categoria)) return { ok: false, error: 'Categoria inválida.' };
  if (!(Number(valor) > 0)) return { ok: false, error: 'Informe um valor maior que zero.' };
  const dia = Number(diaVencimento);
  if (!(Number.isInteger(dia) && dia >= 1 && dia <= 31)) return { ok: false, error: 'Dia do vencimento: de 1 a 31.' };
  const inicio = competenciaInicio || timeService.hojeLocalISO().slice(0, 7);
  if (!ehCompetencia(inicio)) return { ok: false, error: 'Mês inicial inválido.' };
  const id = randomUUID();
  getDb().prepare(
    `INSERT INTO expense_recurrences (id, descricao, categoria, valor, dia_vencimento, fornecedor_id, competencia_inicio, location_id, operador_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, String(descricao).trim(), categoria, arred(valor), dia, fornecedorId || null, inicio, locationId, operadorId);
  gerarRecorrencias();
  return { ok: true, id };
}

function listarRecorrencias() {
  return getDb().prepare(
    `SELECT r.*, s.nome AS fornecedor_nome FROM expense_recurrences r LEFT JOIN suppliers s ON s.id = r.fornecedor_id
     ORDER BY r.ativa DESC, r.descricao`
  ).all();
}

function alterarRecorrencia({ id, valor, ativa }) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM expense_recurrences WHERE id = ?').get(id);
  if (!r) return { ok: false, error: 'Recorrência não encontrada.' };
  if (valor !== undefined) {
    if (!(Number(valor) > 0)) return { ok: false, error: 'Valor inválido.' };
    db.prepare('UPDATE expense_recurrences SET valor = ? WHERE id = ?').run(arred(valor), id);
  }
  if (ativa !== undefined) db.prepare('UPDATE expense_recurrences SET ativa = ? WHERE id = ?').run(ativa ? 1 : 0, id);
  return { ok: true };
}

/**
 * Lança em contas a pagar cada mês de cada recorrência ativa, do mês
 * seguinte ao último já lançado até o mês atual. Idempotente (índice
 * único recorrência + competência) e não ressuscita despesa excluída
 * (só anda pra frente). Barato: roda ao abrir o Financeiro e antes do
 * fluxo de caixa e do DRE.
 */
function gerarRecorrencias(hojeISO = timeService.hojeLocalISO()) {
  const db = getDb();
  const mesAtual = hojeISO.slice(0, 7);
  let geradas = 0;
  db.transaction(() => {
    for (const r of db.prepare('SELECT * FROM expense_recurrences WHERE ativa = 1').all()) {
      const de = r.ultima_competencia_gerada ? somarMeses(r.ultima_competencia_gerada, 1) : r.competencia_inicio;
      if (de > mesAtual) continue;
      for (const comp of competenciasEntre(de, mesAtual)) {
        const ins = db.prepare(
          `INSERT OR IGNORE INTO expenses (id, categoria, descricao, valor, fornecedor_id, data_vencimento, location_id, operador_id, recorrencia_id, competencia)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(randomUUID(), r.categoria, `${r.descricao} — ${comp.split('-').reverse().join('/')}`, r.valor, r.fornecedor_id,
          vencimentoNaCompetencia(comp, r.dia_vencimento), r.location_id, r.operador_id, r.id, comp);
        geradas += ins.changes;
      }
      db.prepare('UPDATE expense_recurrences SET ultima_competencia_gerada = ? WHERE id = ?').run(mesAtual, r.id);
    }
  })();
  return { ok: true, geradas };
}

/** Despesa parcelada: N contas a pagar mensais; os centavos que sobram da
 * divisão vão na última parcela (a soma bate com o total, sempre). */
function criarDespesaParcelada({ descricao, categoria, valorTotal, parcelas, primeiroVencimento, fornecedorId, locationId, operadorId }) {
  if (!String(descricao || '').trim()) return { ok: false, error: 'Informe a descrição.' };
  if (!CATEGORIAS_VALIDAS.has(categoria)) return { ok: false, error: 'Categoria inválida.' };
  const total = arred(valorTotal);
  const n = Number(parcelas);
  if (!(total > 0)) return { ok: false, error: 'Informe o valor total.' };
  if (!(Number.isInteger(n) && n >= 2 && n <= 60)) return { ok: false, error: 'Parcelas: de 2 a 60.' };
  if (!ehData(primeiroVencimento)) return { ok: false, error: 'Informe o primeiro vencimento.' };
  const base = Math.floor((total / n) * 100) / 100;
  const db = getDb();
  const ids = [];
  const dia = Number(primeiroVencimento.slice(8, 10));
  db.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      const valor = i === n - 1 ? arred(total - base * (n - 1)) : base;
      const comp = somarMeses(primeiroVencimento.slice(0, 7), i);
      const id = randomUUID();
      db.prepare(
        `INSERT INTO expenses (id, categoria, descricao, valor, fornecedor_id, data_vencimento, location_id, operador_id, competencia)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, categoria, `${String(descricao).trim()} — parcela ${i + 1}/${n}`, valor, fornecedorId || null,
        vencimentoNaCompetencia(comp, dia), locationId, operadorId, comp);
      ids.push(id);
    }
  })();
  return { ok: true, ids };
}

/** Marca despesa como paga numa data (a tela antiga só sabia "pago agora"). */
function pagarDespesaNaData({ expenseId, data }) {
  const db = getDb();
  const e = db.prepare('SELECT data_pagamento, location_id FROM expenses WHERE id = ?').get(expenseId);
  if (!e) return { ok: false, error: 'Despesa não encontrada.' };
  if (e.data_pagamento) return { ok: false, error: 'Essa despesa já está marcada como paga.' };
  const dia = data || timeService.hojeLocalISO();
  if (!ehData(dia) || dia > timeService.hojeLocalISO()) return { ok: false, error: 'Data de pagamento inválida (não pode ser futura).' };
  const bloqueio = fechamento().bloqueioPorFechamento(e.location_id, [dia]);
  if (bloqueio) return bloqueio;
  // Meio-dia de Brasília em UTC: a data local nunca escorrega pro dia vizinho.
  db.prepare('UPDATE expenses SET data_pagamento = ? WHERE id = ?').run(`${dia} 15:00:00`, expenseId);
  return { ok: true };
}

// ---------- fluxo de caixa ----------

function movimentosRealizados(db, locationId, de, ate) {
  const taxas = getTaxas();
  const maiorPrazo = Math.max(...taxas.map((t) => t.prazo_dias));
  const mov = []; // { data, tipo: 'entrada'|'saida', origem, valor }
  const vendasCaixa = vendasComPagamentos(db, locationId, de, ate);
  for (const v of vendasCaixa) {
    if (v.dinheiro > 0) mov.push({ data: v.data, tipo: 'entrada', origem: 'Vendas em dinheiro', valor: v.dinheiro });
    if (v.pix > 0) mov.push({ data: v.data, tipo: 'entrada', origem: 'Vendas no Pix', valor: v.pix });
  }
  // Cartão cai depois: considera vendas desde (de − maior prazo).
  const vendasCartao = vendasComPagamentos(db, locationId, somarDias(de, -maiorPrazo - 1), ate);
  for (const r of recebimentosDeCartao(vendasCartao, taxas)) {
    if (r.data < de || r.data > ate) continue;
    mov.push({ data: r.data, tipo: 'entrada', origem: r.metodo === 'cartao_debito' ? 'Cartão de débito' : 'Cartão de crédito', valor: r.liquido });
  }
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(de, ate);
  for (const f of db.prepare(
    `SELECT criado_em, valor FROM customer_credit_movements WHERE tipo = 'pagamento' AND criado_em >= ? AND criado_em < ?`
  ).all(inicioUtc, fimUtcExclusivo)) {
    mov.push({ data: dataLocalDeUtc(f.criado_em), tipo: 'entrada', origem: 'Fiado recebido', valor: f.valor });
  }
  for (const r of db.prepare(
    `SELECT recebido_em, valor_recebido FROM receivables WHERE location_id = ? AND recebido_em >= ? AND recebido_em <= ?`
  ).all(locationId, de, ate)) {
    mov.push({ data: r.recebido_em, tipo: 'entrada', origem: 'Contas recebidas', valor: r.valor_recebido });
  }
  for (const e of db.prepare(
    `SELECT data_pagamento, valor, categoria FROM expenses WHERE location_id = ? AND data_pagamento >= ? AND data_pagamento < ?`
  ).all(locationId, inicioUtc, fimUtcExclusivo)) {
    mov.push({ data: dataLocalDeUtc(e.data_pagamento), tipo: 'saida', origem: 'Contas pagas', valor: e.valor });
  }
  for (const r of db.prepare(
    `SELECT criado_em, valor_devolvido FROM returns WHERE location_id = ? AND criado_em >= ? AND criado_em < ? AND valor_devolvido > 0`
  ).all(locationId, inicioUtc, fimUtcExclusivo)) {
    mov.push({ data: dataLocalDeUtc(r.criado_em), tipo: 'saida', origem: 'Devoluções a clientes', valor: r.valor_devolvido });
  }
  return mov;
}

function movimentosPrevistos(db, locationId, hoje, ate) {
  const mov = [];
  const taxas = getTaxas();
  const maiorPrazo = Math.max(...taxas.map((t) => t.prazo_dias));
  for (const r of recebimentosDeCartao(vendasComPagamentos(db, locationId, somarDias(hoje, -maiorPrazo - 1), hoje), taxas)) {
    if (r.data > hoje && r.data <= ate) mov.push({ data: r.data, tipo: 'entrada', origem: r.metodo === 'cartao_debito' ? 'Cartão de débito' : 'Cartão de crédito', valor: r.liquido, previsto: true });
  }
  for (const r of db.prepare(
    `SELECT vencimento, valor FROM receivables WHERE location_id = ? AND recebido_em IS NULL AND cancelado_em IS NULL AND vencimento <= ?`
  ).all(locationId, ate)) {
    // Atrasada entra hoje: é dinheiro que ainda se espera receber.
    mov.push({ data: r.vencimento < hoje ? hoje : r.vencimento, tipo: 'entrada', origem: 'Contas a receber', valor: r.valor, previsto: true, atrasada: r.vencimento < hoje });
  }
  for (const e of db.prepare(
    `SELECT data_vencimento, valor FROM expenses WHERE location_id = ? AND data_pagamento IS NULL AND data_vencimento IS NOT NULL AND data_vencimento <= ?`
  ).all(locationId, ate)) {
    mov.push({ data: e.data_vencimento < hoje ? hoje : e.data_vencimento, tipo: 'saida', origem: 'Contas a pagar', valor: e.valor, previsto: true, atrasada: e.data_vencimento < hoje });
  }
  // Recorrências dos meses que ainda não foram lançados.
  for (const r of db.prepare('SELECT * FROM expense_recurrences WHERE ativa = 1 AND location_id = ?').all(locationId)) {
    const de = r.ultima_competencia_gerada ? somarMeses(r.ultima_competencia_gerada, 1) : r.competencia_inicio;
    for (const comp of competenciasEntre(de, ate.slice(0, 7))) {
      const venc = vencimentoNaCompetencia(comp, r.dia_vencimento);
      if (venc > hoje && venc <= ate) mov.push({ data: venc, tipo: 'saida', origem: 'Contas a pagar', valor: r.valor, previsto: true });
    }
  }
  return mov;
}

/**
 * Fluxo de caixa dia a dia entre duas datas: realizado até hoje, previsto
 * depois. Saldo parte do saldo inicial informado (erp_config) e soma o
 * realizado desde a data dele.
 */
function fluxoDeCaixa({ locationId, dataInicio, dataFim }) {
  if (!ehData(dataInicio) || !ehData(dataFim) || dataFim < dataInicio) return { ok: false, error: 'Período inválido.' };
  const db = getDb();
  gerarRecorrencias();
  const hoje = timeService.hojeLocalISO();
  const config = getConfig();
  const avisos = [];

  // Saldo no começo do período.
  let saldo = Number(config.saldo_inicial) || 0;
  const dataSaldo = config.data_saldo_inicial;
  if (!dataSaldo) avisos.push('Informe o saldo inicial (dinheiro em caixa + banco numa data) para o saldo do fluxo ser o real.');
  let contarDesde = dataSaldo || dataInicio;
  if (dataSaldo && dataSaldo > dataInicio) {
    avisos.push('O período começa antes da data do saldo inicial: o saldo dos dias anteriores a ela não é conhecido.');
    contarDesde = dataInicio;
    saldo = 0;
  }
  const fimRealizado = hoje < dataFim ? hoje : dataFim;
  if (dataSaldo && dataSaldo <= dataInicio && contarDesde < dataInicio) {
    for (const m of movimentosRealizados(db, locationId, contarDesde, somarDias(dataInicio, -1))) {
      saldo += m.tipo === 'entrada' ? m.valor : -m.valor;
    }
  }
  const saldoInicialPeriodo = arred(saldo);

  const movimentos = [];
  if (dataInicio <= fimRealizado) movimentos.push(...movimentosRealizados(db, locationId, dataInicio, fimRealizado));
  if (dataFim >= hoje) movimentos.push(...movimentosPrevistos(db, locationId, hoje, dataFim).filter((m) => m.data >= dataInicio));

  const porDia = new Map();
  for (let d = dataInicio; d <= dataFim; d = somarDias(d, 1)) {
    porDia.set(d, { data: d, entradas: 0, saidas: 0, previsto: d > hoje, detalhes: {} });
  }
  for (const m of movimentos) {
    const dia = porDia.get(m.data);
    if (!dia) continue;
    if (m.tipo === 'entrada') dia.entradas = arred(dia.entradas + m.valor);
    else dia.saidas = arred(dia.saidas + m.valor);
    const chave = `${m.tipo}|${m.origem}${m.previsto ? '|previsto' : ''}`;
    dia.detalhes[chave] = arred((dia.detalhes[chave] || 0) + m.valor);
  }
  const dias = [];
  for (const dia of porDia.values()) {
    saldo = arred(saldo + dia.entradas - dia.saidas);
    dias.push({ ...dia, saldo });
  }

  const porOrigem = {};
  for (const m of movimentos) {
    const k = `${m.tipo}|${m.origem}`;
    porOrigem[k] = porOrigem[k] || { tipo: m.tipo, origem: m.origem, realizado: 0, previsto: 0 };
    porOrigem[k][m.previsto ? 'previsto' : 'realizado'] = arred(porOrigem[k][m.previsto ? 'previsto' : 'realizado'] + m.valor);
  }
  const menorSaldo = dias.reduce((min, d) => (d.saldo < min.saldo ? d : min), dias[0]);
  if (menorSaldo && menorSaldo.saldo < 0) avisos.push(`O saldo fica negativo em ${menorSaldo.data.split('-').reverse().join('/')} (R$ ${menorSaldo.saldo.toFixed(2)}).`);
  const atrasadas = movimentos.filter((m) => m.atrasada);
  if (atrasadas.length) avisos.push(`${atrasadas.length} conta(s) vencida(s) entraram como previstas para hoje.`);

  return {
    ok: true, dias, saldoInicialPeriodo, saldoFinal: saldo, hoje,
    totais: {
      entradas: arred(dias.reduce((s, d) => s + d.entradas, 0)),
      saidas: arred(dias.reduce((s, d) => s + d.saidas, 0)),
    },
    porOrigem: Object.values(porOrigem).sort((a, b) => a.tipo.localeCompare(b.tipo) || (b.realizado + b.previsto) - (a.realizado + a.previsto)),
    menorSaldo: menorSaldo ? { data: menorSaldo.data, saldo: menorSaldo.saldo } : null,
    avisos,
  };
}

// ---------- DRE ----------

function receitaDoMes(db, locationId, competencia) {
  const de = `${competencia}-01`;
  const ate = `${competencia}-${String(ultimoDiaDoMes(competencia)).padStart(2, '0')}`;
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(de, ate);
  const vendas = db.prepare(
    `SELECT COALESCE(SUM(total), 0) AS bruta, COALESCE(SUM(desconto + desconto_gerente), 0) AS descontos, COUNT(*) AS qtd,
       COALESCE(SUM((total - desconto - desconto_gerente) * taxa_servico_percentual / 100.0), 0) AS taxa_servico
     FROM sales WHERE location_id = ? AND status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo);
  const devolucoes = db.prepare(
    `SELECT COALESCE(SUM(valor_devolvido), 0) AS total FROM returns WHERE location_id = ? AND criado_em >= ? AND criado_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo).total;
  return { ...vendas, devolucoes, inicioUtc, fimUtcExclusivo, de, ate };
}

/** Receita líquida (vendas − descontos − devoluções + taxa de serviço) de um mês. */
function receitaLiquidaDoMes(db, locationId, competencia) {
  const r = receitaDoMes(db, locationId, competencia);
  return arred(r.bruta + r.taxa_servico - r.descontos - r.devolucoes);
}

/**
 * DRE gerencial, um bloco por mês (competência AAAA-MM).
 * CMV = quantidade × custo DO MOMENTO da venda (sale_items.custo_unitario);
 * item de antes dessa coluna usa o custo atual e é contado em
 * `cmvItensEstimados`. Impostos: Simples/MEI estimados pelo assistente
 * fiscal; outros regimes, as despesas de categoria 'impostos'.
 */
function dre({ locationId, competencias }) {
  const lista = (competencias || []).filter(ehCompetencia);
  if (lista.length === 0 || lista.length > 24) return { ok: false, error: 'Escolha de 1 a 24 meses.' };
  const db = getDb();
  gerarRecorrencias();
  const assistente = require('./assistenteFiscalService');
  const regime = db.prepare('SELECT regime_tributario FROM fiscal_config WHERE id = ?').get('default')?.regime_tributario || null;
  const taxas = Object.fromEntries(getTaxas().map((t) => [t.metodo, t]));

  const meses = lista.map((competencia) => {
    const r = receitaDoMes(db, locationId, competencia);
    const receitaLiquida = arred(r.bruta + r.taxa_servico - r.descontos - r.devolucoes);

    const cmvVendas = db.prepare(
      `SELECT COALESCE(SUM(si.quantidade * COALESCE(si.custo_unitario, p.custo, 0)), 0) AS total,
         COALESCE(SUM(CASE WHEN si.custo_unitario IS NULL THEN 1 ELSE 0 END), 0) AS estimados
       FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
       WHERE s.location_id = ? AND s.status = 'finalizada' AND si.cancelado = 0 AND s.finalizada_em >= ? AND s.finalizada_em < ?`
    ).get(locationId, r.inicioUtc, r.fimUtcExclusivo);
    const cmvDevolvido = db.prepare(
      `SELECT COALESCE(SUM(ri.quantidade * COALESCE(
          (SELECT si.custo_unitario FROM sale_items si WHERE si.sale_id = rt.sale_id AND si.product_id = ri.product_id AND si.custo_unitario IS NOT NULL LIMIT 1),
          p.custo, 0)), 0) AS total
       FROM return_items ri JOIN returns rt ON rt.id = ri.return_id JOIN products p ON p.id = ri.product_id
       WHERE rt.location_id = ? AND rt.criado_em >= ? AND rt.criado_em < ?`
    ).get(locationId, r.inicioUtc, r.fimUtcExclusivo).total;
    const cmv = arred(cmvVendas.total - cmvDevolvido);

    let impostos = 0;
    let impostosOrigem = 'despesas';
    if (regime === 'mei' || regime === 'simples_nacional') {
      const est = assistente.impostoEstimadoDoMes({ locationId, competencia, receitaDoMes: receitaLiquida, regime });
      impostos = est.valor;
      impostosOrigem = est.origem;
    }

    const despesasCat = db.prepare(
      `SELECT categoria, COALESCE(SUM(valor), 0) AS total FROM expenses
       WHERE location_id = ? AND nfe_entrada_id IS NULL
         AND COALESCE(competencia, substr(data_vencimento, 1, 7),
               strftime('%Y-%m', data_pagamento, '-3 hours'), strftime('%Y-%m', criado_em, '-3 hours')) = ?
       GROUP BY categoria`
    ).all(locationId, competencia);
    const usaImpostoEstimado = impostosOrigem !== 'despesas';
    if (!usaImpostoEstimado) impostos = arred(despesasCat.filter((d) => d.categoria === 'impostos').reduce((s, d) => s + d.total, 0));
    const despesas = despesasCat
      .filter((d) => !CATEGORIAS_FORA_DO_DRE.includes(d.categoria) && d.categoria !== 'impostos')
      .map((d) => ({ categoria: d.categoria, total: arred(d.total) }))
      .sort((a, b) => b.total - a.total);
    const totalDespesas = arred(despesas.reduce((s, d) => s + d.total, 0));
    const retiradas = arred(despesasCat.filter((d) => d.categoria === 'retirada_socio').reduce((s, d) => s + d.total, 0));
    const impostosPagosRegistrados = arred(despesasCat.filter((d) => d.categoria === 'impostos').reduce((s, d) => s + d.total, 0));

    const cartoes = db.prepare(
      `SELECT p.metodo, COALESCE(SUM(p.valor), 0) AS total FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.location_id = ? AND s.status = 'finalizada' AND p.metodo IN ('cartao_debito', 'cartao_credito')
         AND s.finalizada_em >= ? AND s.finalizada_em < ? GROUP BY p.metodo`
    ).all(locationId, r.inicioUtc, r.fimUtcExclusivo);
    const taxasCartao = arred(cartoes.reduce((s, c) => s + c.total * (Number(taxas[c.metodo]?.taxa_percentual) || 0) / 100, 0));

    const compras = db.prepare(
      `SELECT COALESCE(SUM(valor_total), 0) AS total FROM nfe_entradas
       WHERE location_id = ? AND status = 'confirmada' AND confirmada_em >= ? AND confirmada_em < ?`
    ).get(locationId, r.inicioUtc, r.fimUtcExclusivo).total;

    const lucroBruto = arred(receitaLiquida - impostos - cmv);
    const resultado = arred(lucroBruto - taxasCartao - totalDespesas);
    const pct = (v) => (receitaLiquida > 0 ? arred((v / receitaLiquida) * 100, 1) : null);
    return {
      competencia, vendas: r.qtd,
      receitaBruta: arred(r.bruta + r.taxa_servico), descontos: arred(r.descontos), devolucoes: arred(r.devolucoes), receitaLiquida,
      impostos: arred(impostos), impostosOrigem, cmv, cmvItensEstimados: cmvVendas.estimados,
      lucroBruto, margemBruta: pct(lucroBruto), taxasCartao, despesas, totalDespesas,
      resultado, margemLiquida: pct(resultado), retiradas, impostosPagosRegistrados, comprasMercadoria: arred(compras),
    };
  });
  return { ok: true, regime, meses };
}

module.exports = {
  CATEGORIAS_VALIDAS, CATEGORIAS_FORA_DO_DRE,
  getConfig, salvarConfig, getTaxas, salvarTaxas,
  criarRecebivel, receberRecebivel, cancelarRecebivel, contasAReceber, baixarRecebivel, baixarDespesa, valoresDaBaixa,
  criarRecorrencia, listarRecorrencias, alterarRecorrencia, gerarRecorrencias, criarDespesaParcelada, pagarDespesaNaData,
  fluxoDeCaixa, dre, receitaLiquidaDoMes, vendasComPagamentos, recebimentosDeCartao,
  somarDias, somarMeses, competenciasEntre, ultimoDiaDoMes, dataLocalDeUtc,
};
