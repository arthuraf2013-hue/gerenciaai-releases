const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

function list({ query } = {}) {
  const db = getDb();
  if (query) {
    return db.prepare(
      `SELECT * FROM customers WHERE ativo = 1 AND (nome LIKE ? OR telefone LIKE ? OR cpf LIKE ? OR cnpj LIKE ?) ORDER BY nome`
    ).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);
  }
  return db.prepare('SELECT * FROM customers WHERE ativo = 1 ORDER BY nome').all();
}

function upsert(customer) {
  if (!customer.nome?.trim()) return { ok: false, error: 'Informe o nome do cliente.' };
  const db = getDb();
  const id = customer.id || randomUUID();
  db.prepare(
    `INSERT INTO customers (id, nome, telefone, cpf, cnpj) VALUES (@id, @nome, @telefone, @cpf, @cnpj)
     ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, telefone=excluded.telefone, cpf=excluded.cpf, cnpj=excluded.cnpj`
  ).run({ id, nome: customer.nome.trim(), telefone: customer.telefone || null, cpf: customer.cpf || null, cnpj: customer.cnpj || null });
  return { ok: true, id };
}

function normalizarTelefone(tel) {
  return (tel || '').replace(/\D/g, '');
}

/** Procura um cliente ativo pelo telefone, comparando só os dígitos
 * (ignora espaço/traço/parênteses e tolera diferença de DDI, ex:
 * "11999998888" bate com "5511999998888") -- usado pela tela de
 * Separação pra saber se o cliente do WhatsApp já está cadastrado
 * antes de oferecer o botão "Cadastrar cliente". */
function buscarPorTelefone(telefone) {
  const alvo = normalizarTelefone(telefone);
  if (!alvo) return null;
  const db = getDb();
  const candidatos = db.prepare("SELECT * FROM customers WHERE ativo = 1 AND telefone IS NOT NULL AND telefone != ''").all();
  return candidatos.find((c) => {
    const tel = normalizarTelefone(c.telefone);
    return tel && (tel === alvo || tel.endsWith(alvo) || alvo.endsWith(tel));
  }) || null;
}

/** Saldo devedor = soma dos movimentos de fiado (dívida positiva, pagamento negativo no saldo). */
function getSaldoFiado(customerId) {
  const db = getDb();
  const row = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN tipo = 'divida' THEN valor ELSE -valor END), 0) as saldo
     FROM customer_credit_movements WHERE customer_id = ?`
  ).get(customerId);
  return row.saldo;
}

function listWithSaldo({ query } = {}) {
  return list({ query }).map((c) => ({ ...c, saldoFiado: getSaldoFiado(c.id) }));
}

function getCreditHistory(customerId) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM customer_credit_movements WHERE customer_id = ? ORDER BY criado_em DESC`
  ).all(customerId);
}

/** Chamado pelo saleService quando uma venda com pagamento 'fiado' é registrada. */
function registrarDivida({ customerId, valor, saleId, operadorId }) {
  const db = getDb();
  db.prepare(
    `INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, sale_id, operador_id) VALUES (?, ?, 'divida', ?, ?, ?)`
  ).run(randomUUID(), customerId, valor, saleId, operadorId);
}

function registrarPagamento({ customerId, valor, motivo, operadorId }) {
  const db = getDb();
  if (valor <= 0) return { ok: false, error: 'Informe um valor de pagamento válido.' };
  db.prepare(
    `INSERT INTO customer_credit_movements (id, customer_id, tipo, valor, motivo, operador_id) VALUES (?, ?, 'pagamento', ?, ?, ?)`
  ).run(randomUUID(), customerId, valor, motivo || null, operadorId);
  return { ok: true, saldoAtual: getSaldoFiado(customerId) };
}

// --- Fidelidade ---

function getLoyaltyConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM loyalty_config WHERE id = ?').get('default');
}

function updateLoyaltyConfig(payload) {
  const db = getDb();
  const current = getLoyaltyConfig();
  db.prepare(
    `UPDATE loyalty_config SET ativado = ?, reais_por_ponto = ?, valor_resgate_ponto = ? WHERE id = 'default'`
  ).run(
    payload.ativado ? 1 : 0,
    payload.reaisPorPonto ?? current.reais_por_ponto,
    payload.valorResgatePonto ?? current.valor_resgate_ponto
  );
  return { ok: true };
}

/** Chamado ao finalizar uma venda vinculada a um cliente — soma pontos
 * proporcional ao valor pago (não ao valor com desconto, para não criar
 * um ciclo de pontos gerando mais pontos). */
function acumularPontos(customerId, valorVenda) {
  const db = getDb();
  const config = getLoyaltyConfig();
  if (!config.ativado || !customerId) return;
  const pontosGanhos = Math.floor(valorVenda / config.reais_por_ponto);
  if (pontosGanhos > 0) {
    db.prepare('UPDATE customers SET pontos = pontos + ? WHERE id = ?').run(pontosGanhos, customerId);
  }
}

/** Resgata pontos como desconto — devolve o valor do desconto sem
 * debitar ainda (o débito de pontos só acontece se a venda for
 * finalizada de fato, ver saleService). */
function calcularValorResgate(pontos) {
  const config = getLoyaltyConfig();
  return Number((pontos * config.valor_resgate_ponto).toFixed(2));
}

function debitarPontos(customerId, pontos) {
  const db = getDb();
  db.prepare('UPDATE customers SET pontos = MAX(0, pontos - ?) WHERE id = ?').run(pontos, customerId);
}

/**
 * Clientes que sumiram — em vez de um limiar fixo de dias pra todo
 * mundo (um cliente que compra a cada 90 dias não "sumiu" só porque
 * já fazem 40 dias), compara o tempo desde a última compra com o
 * RITMO PRÓPRIO de cada cliente (média de dias entre as compras
 * dele). Só considera quem já tem pelo menos 2 compras — sem isso
 * não dá pra saber qual é o ritmo normal da pessoa.
 */
function listClientesQueSumiram({ multiplicador = 2, minimoDias = 15 } = {}) {
  const db = getDb();
  const candidatos = db.prepare(
    `SELECT c.id, c.nome, c.telefone,
       MIN(s.finalizada_em) as primeira_compra, MAX(s.finalizada_em) as ultima_compra,
       COUNT(s.id) as total_compras
     FROM customers c
     JOIN sales s ON s.customer_id = c.id AND s.status = 'finalizada'
     WHERE c.ativo = 1
     GROUP BY c.id
     HAVING total_compras >= 2`
  ).all();

  const agora = Date.now();
  const resultado = [];
  for (const c of candidatos) {
    const primeiraMs = new Date(c.primeira_compra + 'Z').getTime();
    const ultimaMs = new Date(c.ultima_compra + 'Z').getTime();
    const diasComoCliente = (ultimaMs - primeiraMs) / 86400000;
    const ritmoMedioDias = diasComoCliente / (c.total_compras - 1);
    const diasDesdeUltimaCompra = Math.floor((agora - ultimaMs) / 86400000);

    // O limiar de "sumiu" é o próprio ritmo da pessoa vezes o
    // multiplicador — nunca menos que minimoDias, pra não avisar de
    // um cliente que só demorou 1 dia a mais que o normal.
    const limiar = Math.max(minimoDias, ritmoMedioDias * multiplicador);
    if (diasDesdeUltimaCompra >= limiar) {
      resultado.push({
        id: c.id, nome: c.nome, telefone: c.telefone,
        diasDesdeUltimaCompra, ritmoMedioDias: Math.round(ritmoMedioDias), totalCompras: c.total_compras,
      });
    }
  }

  return resultado.sort((a, b) => b.diasDesdeUltimaCompra - a.diasDesdeUltimaCompra);
}

/** Monta um link de WhatsApp com uma mensagem de reconquista pronta —
 * mesmo padrão do link de recibo (link.wa.me com o texto já
 * preenchido), só que pra convidar o cliente a voltar. */
function montarLinkReconquista(customerId) {
  const db = getDb();
  const cliente = db.prepare('SELECT nome, telefone FROM customers WHERE id = ?').get(customerId);
  if (!cliente) return { ok: false, error: 'Cliente não encontrado.' };
  if (!cliente.telefone) return { ok: false, error: 'Esse cliente não tem telefone cadastrado.' };

  const primeiroNome = cliente.nome.trim().split(' ')[0];
  const mensagem = `Oi, ${primeiroNome}! Faz um tempinho que a gente não te vê por aqui — sentimos sua falta! Passa lá quando puder, temos novidades pra você. 😊`;

  const digitos = cliente.telefone.replace(/\D/g, '');
  const numeroLimpo = digitos.startsWith('55') ? digitos : '55' + digitos;
  const url = `https://wa.me/${numeroLimpo}?text=${encodeURIComponent(mensagem)}`;
  return { ok: true, url, mensagem };
}

module.exports = {
  list, upsert, getSaldoFiado, listWithSaldo, getCreditHistory, registrarDivida, registrarPagamento,
  getLoyaltyConfig, updateLoyaltyConfig, acumularPontos, calcularValorResgate, debitarPontos,
  listClientesQueSumiram, montarLinkReconquista, buscarPorTelefone,
};
