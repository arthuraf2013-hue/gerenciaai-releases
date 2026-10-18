import { novoId, agoraIso, ErroDeNegocio, auditar, ctx } from './base.js';

export function caixaAberto(db) {
  return db.get(`SELECT * FROM caixas WHERE status = 'aberto'`);
}

export async function abrirCaixa(db, { valorAberturaCentavos }, usuarioId) {
  if (!Number.isInteger(valorAberturaCentavos) || valorAberturaCentavos < 0) throw new ErroDeNegocio('Valor de abertura inválido.');
  return db.transacao(async (tx) => {
    if (await caixaAberto(tx)) throw new ErroDeNegocio('Já existe um caixa aberto.');
    const id = novoId();
    await tx.run(
      `INSERT INTO caixas (id, status, aberto_por, aberto_em, valor_abertura_centavos, dispositivo_id) VALUES (?, 'aberto', ?, ?, ?, ?)`,
      [id, usuarioId, agoraIso(), valorAberturaCentavos, ctx().dispositivoId],
    );
    await auditar(tx, 'caixa_aberto', { id, valorAberturaCentavos }, usuarioId);
    return id;
  });
}

/**
 * Tudo o que o caixa movimentou. "Dinheiro esperado na gaveta" =
 * abertura + vendas em dinheiro (o valor que ficou pra venda, o troco já
 * saiu) + fiado recebido em dinheiro + suprimentos − sangrias.
 * Venda cancelada não entra em total nenhum (só na contagem própria).
 */
export async function resumoDoCaixa(db, caixaId) {
  const caixa = await db.get('SELECT * FROM caixas WHERE id = ?', [caixaId]);
  if (!caixa) throw new ErroDeNegocio('Caixa não encontrado.');
  const vendas = await db.get(
    `SELECT COUNT(*) AS qtd, COALESCE(SUM(total_centavos), 0) AS total, COALESCE(SUM(desconto_centavos), 0) AS descontos
     FROM vendas WHERE caixa_id = ? AND status = 'finalizada'`,
    [caixaId],
  );
  const canceladas = await db.get(
    `SELECT COUNT(*) AS qtd, COALESCE(SUM(total_centavos), 0) AS total FROM vendas WHERE caixa_id = ? AND status = 'cancelada'`,
    [caixaId],
  );
  const porMetodoLinhas = await db.all(
    `SELECT p.metodo, SUM(p.valor_centavos) AS total FROM pagamentos p JOIN vendas v ON v.id = p.venda_id
     WHERE v.caixa_id = ? AND v.status = 'finalizada' GROUP BY p.metodo`,
    [caixaId],
  );
  const porMetodo = { dinheiro: 0, credito: 0, debito: 0, pix: 0, fiado: 0 };
  for (const l of porMetodoLinhas) porMetodo[l.metodo] = l.total;

  const fiadoRecebidoLinhas = await db.all(
    `SELECT metodo, -SUM(valor_centavos) AS total FROM fiado_lancamentos WHERE caixa_id = ? AND tipo = 'pagamento' GROUP BY metodo`,
    [caixaId],
  );
  const fiadoRecebido = { dinheiro: 0, credito: 0, debito: 0, pix: 0 };
  for (const l of fiadoRecebidoLinhas) fiadoRecebido[l.metodo] = l.total;

  const mov = await db.all('SELECT tipo, COALESCE(SUM(valor_centavos), 0) AS total FROM caixa_movimentos WHERE caixa_id = ? GROUP BY tipo', [caixaId]);
  const suprimentos = mov.find((m) => m.tipo === 'suprimento')?.total || 0;
  const sangrias = mov.find((m) => m.tipo === 'sangria')?.total || 0;

  const dinheiroEsperado = caixa.valor_abertura_centavos + porMetodo.dinheiro + fiadoRecebido.dinheiro + suprimentos - sangrias;
  return {
    caixa,
    vendas: { quantidade: vendas.qtd, totalCentavos: vendas.total, descontosCentavos: vendas.descontos },
    canceladas: { quantidade: canceladas.qtd, totalCentavos: canceladas.total },
    porMetodo,
    fiadoRecebido,
    suprimentosCentavos: suprimentos,
    sangriasCentavos: sangrias,
    dinheiroEsperadoCentavos: dinheiroEsperado,
  };
}

export async function movimentarCaixa(db, { tipo, valorCentavos, motivo }, usuarioId) {
  if (!['sangria', 'suprimento'].includes(tipo)) throw new ErroDeNegocio('Tipo inválido.');
  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) throw new ErroDeNegocio('Valor inválido.');
  return db.transacao(async (tx) => {
    const caixa = await caixaAberto(tx);
    if (!caixa) throw new ErroDeNegocio('Nenhum caixa aberto.', 'caixa_fechado');
    if (tipo === 'sangria') {
      const { dinheiroEsperadoCentavos } = await resumoDoCaixa(tx, caixa.id);
      if (valorCentavos > dinheiroEsperadoCentavos) throw new ErroDeNegocio('A sangria é maior que o dinheiro que deveria estar no caixa.');
    }
    await tx.run(
      'INSERT INTO caixa_movimentos (id, caixa_id, tipo, valor_centavos, motivo, usuario_id, criado_em, dispositivo_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [novoId(), caixa.id, tipo, valorCentavos, String(motivo || '').trim() || null, usuarioId, agoraIso(), ctx().dispositivoId],
    );
    await auditar(tx, `caixa_${tipo}`, { caixaId: caixa.id, valorCentavos, motivo }, usuarioId);
  });
}

export async function fecharCaixa(db, { valorContadoCentavos, observacao }, usuarioId) {
  if (!Number.isInteger(valorContadoCentavos) || valorContadoCentavos < 0) throw new ErroDeNegocio('Informe quanto tem de dinheiro no caixa.');
  return db.transacao(async (tx) => {
    const caixa = await caixaAberto(tx);
    if (!caixa) throw new ErroDeNegocio('Nenhum caixa aberto.', 'caixa_fechado');
    const resumo = await resumoDoCaixa(tx, caixa.id);
    await tx.run(
      `UPDATE caixas SET status = 'fechado', fechado_por = ?, fechado_em = ?, valor_esperado_centavos = ?, valor_contado_centavos = ?, observacao = ? WHERE id = ?`,
      [usuarioId, agoraIso(), resumo.dinheiroEsperadoCentavos, valorContadoCentavos, String(observacao || '').trim() || null, caixa.id],
    );
    const diferenca = valorContadoCentavos - resumo.dinheiroEsperadoCentavos;
    await auditar(tx, 'caixa_fechado', { id: caixa.id, esperado: resumo.dinheiroEsperadoCentavos, contado: valorContadoCentavos, diferenca }, usuarioId);
    return { ...resumo, valorContadoCentavos, diferencaCentavos: diferenca };
  });
}

export function historicoDeCaixas(db, limite = 30) {
  return db.all(
    `SELECT c.*, ua.nome AS aberto_por_nome, uf.nome AS fechado_por_nome FROM caixas c
     LEFT JOIN usuarios ua ON ua.id = c.aberto_por LEFT JOIN usuarios uf ON uf.id = c.fechado_por
     ORDER BY c.aberto_em DESC LIMIT ?`,
    [limite],
  );
}
