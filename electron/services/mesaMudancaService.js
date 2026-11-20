// Mudança de mesa: a conta inteira ou só algumas pessoas vão para outra mesa
// (livre ou ocupada), pelo caixa ou a pedido do cliente pelo QR da mesa.
//
//   moverConta     -- o caixa move: 'todas' as pessoas (mesa inteira; para
//                     mesa ocupada, as contas se juntam) ou só algumas.
//   pedirMudanca   -- o celular de quem está numa mesa leu o QR de outra:
//                     'minha' (levar só a minha conta), 'todos' (mudamos
//                     todos) ou 'entregar' (a conta fica, o pedido avisa
//                     "entregar no Guarda-sol 12"). Mudar conta precisa do
//                     caixa aprovar (aprovarMudanca / recusarMudanca).
//
// Os itens mudam de comanda com a mesma pessoa (nome, cliente, celular), a
// mesma marca de cozinha e o mesmo preço. Movimentos de estoque não são
// editados (como em juntarMesas: o livro-razão cita a comanda onde o item
// foi lançado; um estorno futuro sai pela comanda nova, o saldo é o mesmo).
// Recusa conta com pagamento, desconto, pontos ou Pix em andamento (dos dois
// lados) e mesa sendo paga em outro caixa.

const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

const T = () => require('./tableService');
const rotulo = (m) => (m?.nome ? String(m.nome).slice(0, 30) : `Mesa ${m?.numero}`);

function mesa(db, id) { return db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(id); }
function principal(db, m) { return m?.unida_a_mesa_id ? (mesa(db, m.unida_a_mesa_id) || m) : m; }

/** Motivo que impede mexer nesta conta (ou null). */
function bloqueioDaConta(db, m) {
  const r = rotulo(m);
  if (m.fechando_caixa_id) return `${r} está sendo paga no ${m.fechando_caixa_nome || 'outro caixa'}. Espere terminar o pagamento lá.`;
  if (!m.sale_id) return null;
  const venda = db.prepare('SELECT * FROM sales WHERE id = ?').get(m.sale_id);
  if (!venda || venda.status !== 'aberta') return `A comanda de ${r} já foi fechada.`;
  if (db.prepare('SELECT COUNT(*) AS c FROM payments WHERE sale_id = ?').get(m.sale_id).c > 0) return `${r} já tem pagamento lançado. Finalize ou remova o pagamento antes de mudar de mesa.`;
  try {
    if (db.prepare('SELECT COUNT(*) AS c FROM sale_person_payments WHERE sale_id = ?').get(m.sale_id).c > 0) return `${r} já tem conta de pessoa paga. Finalize antes de mudar de mesa.`;
  } catch { /* banco sem a tabela */ }
  if ((venda.desconto || 0) > 0 || (venda.desconto_gerente || 0) > 0 || (venda.pontos_resgatados || 0) > 0) return `${r} tem desconto ou pontos aplicados. Remova antes de mudar de mesa.`;
  try {
    if (db.prepare(`SELECT COUNT(*) AS c FROM pix_cobrancas WHERE sale_id = ? AND status IN ('criando', 'pendente')`).get(m.sale_id).c > 0) return `${r} tem uma cobrança Pix em andamento.`;
  } catch { /* sem Pix */ }
  return null;
}

/** Pessoas da comanda (com nome ou com item), com o total de cada uma. */
function pessoasDaConta(db, saleId) {
  const nomes = new Map(db.prepare('SELECT numero, nome FROM sale_people WHERE sale_id = ?').all(saleId).map((p) => [p.numero, p.nome]));
  const totais = new Map(db.prepare(`SELECT pessoa_numero AS n, SUM(quantidade * preco_unitario) AS t FROM sale_items
                                      WHERE sale_id = ? AND cancelado = 0 AND pessoa_numero IS NOT NULL GROUP BY pessoa_numero`).all(saleId).map((r) => [r.n, r.t]));
  const numeros = [...new Set([...nomes.keys(), ...totais.keys()])].sort((a, b) => a - b);
  return numeros.map((n) => ({ numero: n, nome: nomes.get(n) || null, total: Math.round((totais.get(n) || 0) * 100) / 100 }));
}

/** Comanda da cozinha avisando a mudança (itens que a cozinha já recebeu). */
function avisarCozinha({ de, para, itens, pessoas }) {
  try {
    const cozinha = require('./cozinhaService');
    const config = cozinha.getConfig();
    if (!config.ativa || !itens.length) return;
    const comanda = {
      titulo: 'MUDOU DE MESA', subtitulo: `${de} -> ${para}`, mesa: String(para).toUpperCase(),
      hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }),
      itens: itens.map((i) => ({ quantidade: i.quantidade, unidade: i.unidade || 'un', nome: i.nome, precoUnitario: null, observacao: null, pessoa: i.pessoa || null })),
      rodape: pessoas ? `Agora na ${para}: ${pessoas}` : null,
      layout: (() => { try { return require('./estudioImpressaoService').getConfig('cozinha'); } catch { return {}; } })(),
    };
    Promise.resolve(cozinha.enviarParaImpressora(comanda, config))
      .catch((err) => console.error('[mudança de mesa] aviso da cozinha:', err?.message || err));
  } catch (err) {
    console.error('[mudança de mesa] aviso da cozinha:', err?.message || err);
  }
}

/**
 * Move a conta de uma mesa para outra. `pessoas`: 'todas' (a mesa inteira,
 * inclusive itens sem pessoa) ou lista de números das pessoas. Destino livre:
 * abre; ocupado: junta na comanda dele (as pessoas vêm depois das de lá).
 */
function moverConta({ fromTableId, toTableId, pessoas = 'todas', operadorId = null } = {}) {
  const db = getDb();
  const tableService = T();
  tableService.repararMesasComVendaFechada(db);
  tableService.repararMesasUnidas(db);
  const de = principal(db, mesa(db, fromTableId));
  const para = principal(db, mesa(db, toTableId));
  if (!de || !para) return { ok: false, error: 'Mesa não encontrada.' };
  if (de.id === para.id) return { ok: false, error: 'Escolha outra mesa.' };
  if (de.location_id !== para.location_id) return { ok: false, error: 'As duas mesas precisam ser do mesmo local.' };
  if (de.status !== 'ocupada' || !de.sale_id) return { ok: false, error: `${rotulo(de)} não está ocupada (atualize a tela de mesas).` };
  if (!['livre', 'ocupada'].includes(para.status)) {
    return { ok: false, error: `${rotulo(para)} está ${para.status === 'reservada' ? 'reservada' : para.status === 'aguardando_limpeza' ? 'aguardando limpeza' : 'indisponível'}.` };
  }
  const todas = pessoas === 'todas';
  const unidas = db.prepare('SELECT COUNT(*) AS n FROM restaurant_tables WHERE unida_a_mesa_id = ?').get(de.id).n;
  if (todas && unidas > 0) return { ok: false, error: 'Separe as mesas unidas antes de mudar a mesa inteira (ou escolha as pessoas).' };
  const bloqueio = bloqueioDaConta(db, de) || (para.status === 'ocupada' ? bloqueioDaConta(db, para) : null);
  if (bloqueio) return { ok: false, error: bloqueio };

  // Mesa inteira para uma livre: a transferência de sempre (a comanda vai junto).
  if (todas && para.status === 'livre') {
    const r = tableService.transferTable({ fromTableId: de.id, toTableId: para.id, operadorId });
    if (r.ok) aposMover(db, { de, para, saleOrigem: de.sale_id, saleDestino: r.saleId, itensIds: null, operadorId, texto: 'mesa inteira' });
    return r.ok ? { ...r, destinoId: para.id, inteira: true } : r;
  }

  const lista = pessoasDaConta(db, de.sale_id);
  let numeros;
  if (todas) numeros = lista.map((p) => p.numero);
  else {
    numeros = [...new Set((Array.isArray(pessoas) ? pessoas : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1))];
    if (!numeros.length) return { ok: false, error: 'Escolha quem muda de mesa.' };
    const existem = new Set(lista.map((p) => p.numero));
    const faltando = numeros.filter((n) => !existem.has(n));
    if (faltando.length) return { ok: false, error: 'Essa pessoa não tem nome nem item nesta mesa. Atualize a tela.' };
  }
  numeros.sort((a, b) => a - b);

  let saleDestino = para.sale_id;
  let itensIds = [];
  const resultado = db.transaction(() => {
    if (para.status === 'livre') {
      const aberta = tableService.openTable({ tableId: para.id, locationId: para.location_id, operadorId: operadorId || db.prepare('SELECT operador_id FROM sales WHERE id = ?').get(de.sale_id).operador_id, pessoas: null });
      if (!aberta.ok) throw new Error(aberta.error);
      saleDestino = aberta.saleId;
    }
    const destinoAtual = mesa(db, para.id);
    const deslocamento = tableService._totalDePessoas(db, saleDestino, destinoAtual.pessoas);
    const novoNumero = new Map(numeros.map((n, i) => [n, deslocamento + i + 1]));

    const pegarItens = db.prepare('SELECT id FROM sale_items WHERE sale_id = ? AND cancelado = 0 AND pessoa_numero = ?');
    const moverItem = db.prepare('UPDATE sale_items SET sale_id = ?, pessoa_numero = ? WHERE id = ?');
    for (const n of numeros) {
      for (const it of pegarItens.all(de.sale_id, n)) { moverItem.run(saleDestino, novoNumero.get(n), it.id); itensIds.push(it.id); }
      const p = db.prepare('SELECT * FROM sale_people WHERE sale_id = ? AND numero = ?').get(de.sale_id, n);
      if (p) {
        db.prepare('INSERT INTO sale_people (id, sale_id, numero, nome, customer_id, aparelho, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), saleDestino, novoNumero.get(n), p.nome, p.customer_id || null, p.aparelho || null, p.criado_em);
        db.prepare('DELETE FROM sale_people WHERE id = ?').run(p.id);
        // O celular dela agora é integrante da mesa nova.
        if (p.aparelho) {
          try {
            db.prepare('DELETE FROM mesa_local_membros WHERE table_id = ? AND aparelho = ?').run(para.id, p.aparelho);
            db.prepare('UPDATE mesa_local_membros SET table_id = ?, sale_id = ? WHERE aparelho = ? AND table_id IN (SELECT id FROM restaurant_tables WHERE id = ? OR unida_a_mesa_id = ?)')
              .run(para.id, saleDestino, p.aparelho, de.id, de.id);
          } catch { /* banco sem a tabela */ }
        }
      }
    }
    if (todas) {
      for (const it of db.prepare('SELECT id FROM sale_items WHERE sale_id = ? AND cancelado = 0 AND pessoa_numero IS NULL').all(de.sale_id)) {
        moverItem.run(saleDestino, null, it.id); itensIds.push(it.id);
      }
    }
    db.prepare('UPDATE restaurant_tables SET pessoas = ? WHERE id = ?').run(deslocamento + numeros.length, para.id);
    recalcular(db, saleDestino);
    recalcular(db, de.sale_id);

    // Sobrou alguma coisa na mesa de origem?
    const restaItem = db.prepare('SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = ? AND cancelado = 0').get(de.sale_id).n;
    const restaPessoa = db.prepare('SELECT COUNT(*) AS n FROM sale_people WHERE sale_id = ?').get(de.sale_id).n;
    const esvaziou = todas || (restaItem === 0 && restaPessoa === 0);
    if (esvaziou) {
      db.prepare(`UPDATE sales SET status = 'cancelada', total = 0, cancelada_em = NOW_SYNCED(), cancelada_por_id = ?, motivo_cancelamento = ? WHERE id = ?`)
        .run(operadorId || null, `Conta levada para ${rotulo(para)} (mudança de mesa)`, de.sale_id);
      db.prepare(`UPDATE restaurant_tables SET status = 'aguardando_limpeza', sale_id = NULL, pessoas = NULL, transferida_para_id = ? WHERE id = ?`).run(para.id, de.id);
      db.prepare('UPDATE restaurant_tables SET transferida_para_id = ? WHERE transferida_para_id = ?').run(para.id, de.id);
      try {
        db.prepare('DELETE FROM mesa_local_membros WHERE table_id = ? AND aparelho IN (SELECT aparelho FROM mesa_local_membros WHERE table_id = ?)').run(para.id, de.id);
        db.prepare('UPDATE mesa_local_membros SET table_id = ?, sale_id = ? WHERE table_id = ?').run(para.id, saleDestino, de.id);
        db.prepare('UPDATE mesa_chamados SET table_id = ? WHERE table_id = ? AND atendido_em IS NULL').run(para.id, de.id);
      } catch { /* banco sem as tabelas */ }
      try {
        db.prepare(`UPDATE bot_orders SET mesa_numero = ? WHERE location_id = ? AND mesa_numero = ? AND status IN ('novo','em_separacao','pronto')`).run(para.numero, de.location_id, de.numero);
      } catch { /* sem pedidos */ }
    } else {
      const atual = mesa(db, de.id);
      db.prepare('UPDATE restaurant_tables SET pessoas = ? WHERE id = ?').run(Math.max(tableService._totalDePessoas(db, de.sale_id, 0), (Number(atual.pessoas) || 0) - numeros.length) || null, de.id);
    }
    return { esvaziou };
  })();

  const nomes = numeros.map((n) => lista.find((p) => p.numero === n)?.nome || `Pessoa ${n}`);
  aposMover(db, {
    de, para, saleOrigem: de.sale_id, saleDestino, itensIds, operadorId,
    texto: todas ? `mesa inteira, juntou com a conta de ${rotulo(para)}` : nomes.join(', '),
  });
  return {
    ok: true, saleId: saleDestino, destinoId: para.id, inteira: resultado.esvaziou, pessoasMovidas: numeros.length, itensMovidos: itensIds.length,
    juntou: para.status === 'ocupada',
  };
}

function recalcular(db, saleId) {
  db.prepare(`UPDATE sales SET total = (SELECT COALESCE(SUM(preco_unitario * quantidade), 0) FROM sale_items WHERE sale_id = ? AND cancelado = 0) WHERE id = ?`).run(saleId, saleId);
}

/** Auditoria, aviso na cozinha e nas telas, depois de mover. */
function aposMover(db, { de, para, saleOrigem, saleDestino, itensIds, operadorId, texto }) {
  try {
    require('./authService').registrarEventoAuditoria({
      tipoEvento: 'mesa_mudou', solicitanteId: operadorId, motivo: `${rotulo(de)} -> ${rotulo(para)}: ${texto}`,
    });
  } catch { /* extra */ }
  // Cozinha: só os itens que ela já recebeu (os outros saem já com a mesa nova).
  try {
    const ids = itensIds === null
      ? db.prepare('SELECT id FROM sale_items WHERE sale_id = ? AND cancelado = 0').all(saleDestino).map((i) => i.id)
      : itensIds;
    if (ids.length) {
      const marca = ids.map(() => '?').join(',');
      const itens = db.prepare(`SELECT si.quantidade, p.unidade, COALESCE(si.nome_personalizado, p.nome) AS nome, sp.nome AS pessoa
                                FROM sale_items si JOIN products p ON p.id = si.product_id
                                LEFT JOIN sale_people sp ON sp.sale_id = si.sale_id AND sp.numero = si.pessoa_numero
                                WHERE si.id IN (${marca}) AND si.enviado_cozinha = 1`).all(...ids);
      const pessoas = [...new Set(itens.map((i) => i.pessoa).filter(Boolean))].join(', ');
      avisarCozinha({ de: rotulo(de), para: rotulo(para), itens, pessoas });
    }
  } catch (err) { console.error('[mudança de mesa] cozinha:', err?.message || err); }
  try { require('./mesaCelularService').avisarTelas({ origem: 'mudanca', mesaId: para.id }); } catch { /* sem telas */ }
  void saleOrigem;
}

// ------------------------------------------------------------ pedido pelo celular

const TIPOS = { minha: 'levar a conta dela', todos: 'mudar a mesa toda', entregar: 'receber os pedidos' };

/** Mesa (principal, com comanda aberta) em que este celular é integrante, fora `exceto`. */
function mesaDoCelular(db, aparelho, exceto = null) {
  try {
    const r = db.prepare(`SELECT mm.table_id FROM mesa_local_membros mm
                          JOIN restaurant_tables t ON t.id = mm.table_id
                          JOIN sales s ON s.id = t.sale_id AND s.status = 'aberta'
                          WHERE mm.aparelho = ? AND mm.sale_id = t.sale_id ${exceto ? 'AND mm.table_id <> ?' : ''}
                          ORDER BY mm.criado_em DESC LIMIT 1`).get(...(exceto ? [aparelho, exceto] : [aparelho]));
    return r ? mesa(db, r.table_id) : null;
  } catch { return null; }
}

/** Último pedido de mudança deste celular para a mesa `paraId` (últimos 30 min). */
function mudancaDoCelular(db, aparelho, paraId) {
  try {
    return db.prepare(`SELECT * FROM mesa_mudancas WHERE aparelho = ? AND para_table_id = ? AND criado_em >= datetime('now', '-30 minutes')
                       ORDER BY criado_em DESC, rowid DESC LIMIT 1`).get(aparelho, paraId) || null;
  } catch { return null; }
}

/** "Entregar aqui" ativo: a conta fica na outra mesa, os pedidos saem para esta. */
function entregaAtiva(db, aparelho, paraId) {
  const m = mudancaDoCelular(db, aparelho, paraId);
  if (!m || m.tipo !== 'entregar' || m.status !== 'ativa') return null;
  const de = principal(db, mesa(db, m.de_table_id));
  return de && de.status === 'ocupada' && de.sale_id ? { mudanca: m, contaEm: de } : null;
}

function pedirMudanca({ paraMesa, aparelho, tipo }) {
  const db = getDb();
  const de = mesaDoCelular(db, aparelho, paraMesa.id);
  if (tipo === 'cancelar') {
    try { db.prepare(`UPDATE mesa_mudancas SET status = 'cancelada', resolvido_em = datetime('now') WHERE aparelho = ? AND status IN ('pendente','ativa')`).run(aparelho); } catch { /* sem tabela */ }
    return { ok: true };
  }
  if (!TIPOS[tipo]) return { ok: false, error: 'Pedido inválido.' };
  if (!de) return { ok: false, error: 'Você não está em outra mesa. Entre nesta com o seu nome.' };
  const membro = db.prepare('SELECT nome FROM mesa_local_membros WHERE table_id = ? AND aparelho = ?').get(de.id, aparelho);
  db.prepare(`UPDATE mesa_mudancas SET status = 'cancelada', resolvido_em = datetime('now') WHERE aparelho = ? AND status IN ('pendente','ativa')`).run(aparelho);
  const id = randomUUID();
  db.prepare('INSERT INTO mesa_mudancas (id, de_table_id, para_table_id, aparelho, nome, tipo, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, de.id, paraMesa.id, aparelho, membro?.nome || null, tipo, tipo === 'entregar' ? 'ativa' : 'pendente');
  if (tipo !== 'entregar') {
    require('./avisosDoServidor').registrar('mesa:chamado', {
      tipo: 'mudanca', mesa: rotulo(de), nome: membro?.nome || null, mesaId: de.id,
      texto: `${membro?.nome || 'Cliente'} quer ${TIPOS[tipo]}: ${rotulo(de)} -> ${rotulo(paraMesa)}`,
    });
  }
  return { ok: true, id };
}

/** O caixa aprova: a conta (dela ou da mesa toda) vai para a mesa nova. */
function aprovarMudanca({ id, operadorId = null } = {}) {
  const db = getDb();
  const m = db.prepare('SELECT * FROM mesa_mudancas WHERE id = ?').get(id);
  if (!m) return { ok: false, error: 'Pedido de mudança não encontrado.' };
  if (m.status !== 'pendente') return { ok: false, error: m.status === 'aprovada' ? 'Essa mudança já foi feita.' : 'Esse pedido de mudança não vale mais.' };
  // A mesa de origem pode ter mudado de lugar no meio tempo.
  let de = principal(db, mesa(db, m.de_table_id));
  if (de && de.status === 'aguardando_limpeza') de = T().destinoDaTransferencia(db, de) || de;
  if (!de || de.status !== 'ocupada' || !de.sale_id) return falhar(db, m, 'A conta de origem já foi fechada.');
  let pessoas = 'todas';
  if (m.tipo === 'minha') {
    const p = db.prepare('SELECT numero FROM sale_people WHERE sale_id = ? AND aparelho = ?').get(de.sale_id, m.aparelho);
    if (!p) return falhar(db, m, `${m.nome || 'Essa pessoa'} não está mais na conta de ${rotulo(de)}.`);
    pessoas = [p.numero];
  }
  const r = moverConta({ fromTableId: de.id, toTableId: m.para_table_id, pessoas, operadorId });
  if (!r.ok) return r; // continua pendente: o caixa resolve (ex.: tira o pagamento) ou recusa
  db.prepare(`UPDATE mesa_mudancas SET status = 'aprovada', resolvido_em = datetime('now'), resolvido_por = ? WHERE id = ?`).run(operadorId, m.id);
  return { ...r, ok: true };
}

function falhar(db, m, erro) {
  db.prepare(`UPDATE mesa_mudancas SET status = 'recusada', erro = ?, resolvido_em = datetime('now') WHERE id = ?`).run(erro, m.id);
  return { ok: false, error: erro };
}

function recusarMudanca({ id, operadorId = null } = {}) {
  const db = getDb();
  const r = db.prepare(`UPDATE mesa_mudancas SET status = 'recusada', resolvido_em = datetime('now'), resolvido_por = ? WHERE id = ? AND status = 'pendente'`).run(operadorId, id);
  return r.changes ? { ok: true } : { ok: false, error: 'Esse pedido de mudança não vale mais.' };
}

/** Pedidos de mudança esperando o caixa, por mesa de origem e de destino (quadrados das mesas). */
function mudancasPendentes(db) {
  try {
    return db.prepare(`SELECT mm.id, mm.de_table_id, mm.para_table_id, mm.nome, mm.tipo, mm.criado_em,
                              d.nome AS de_nome, d.numero AS de_numero, p.nome AS para_nome, p.numero AS para_numero
                       FROM mesa_mudancas mm JOIN restaurant_tables d ON d.id = mm.de_table_id JOIN restaurant_tables p ON p.id = mm.para_table_id
                       WHERE mm.status = 'pendente' AND mm.criado_em >= datetime('now', '-30 minutes') ORDER BY mm.criado_em`).all();
  } catch { return []; }
}

module.exports = {
  moverConta, pessoasDaConta, bloqueioDaConta, pedirMudanca, aprovarMudanca, recusarMudanca, mudancasPendentes,
  mesaDoCelular, mudancaDoCelular, entregaAtiva, rotulo,
};
