import { novoId, agoraIso, normalizarBusca, ErroDeNegocio, auditar, ctx } from './base.js';
import { registrarSeTerminal } from './terminal.js';

export async function salvarCliente(db, dados, usuarioId) {
  const nome = String(dados.nome || '').trim();
  if (!nome) throw new ErroDeNegocio('Informe o nome do cliente.');
  const telefone = String(dados.telefone || '').replace(/[^\d+]/g, '') || null;
  const documento = String(dados.documento || '').replace(/\D/g, '') || null;
  if (documento && ![11, 14].includes(documento.length)) throw new ErroDeNegocio('CPF/CNPJ precisa ter 11 ou 14 números.');
  const limite = dados.limiteFiadoCentavos ?? null;
  if (limite !== null && (!Number.isInteger(limite) || limite < 0)) throw new ErroDeNegocio('Limite de fiado inválido.');
  // Transação: no modo terminal, o evento pro computador entra junto com o cadastro.
  return db.transacao(async (tx) => {
    const agora = agoraIso();
    if (dados.id) {
      const r = await tx.run(
        'UPDATE clientes SET nome = ?, nome_busca = ?, telefone = ?, documento = ?, limite_fiado_centavos = ?, atualizado_em = ? WHERE id = ?',
        [nome, normalizarBusca(nome), telefone, documento, limite, agora, dados.id],
      );
      if (!r.changes) throw new ErroDeNegocio('Cliente não encontrado.');
      await auditar(tx, 'cliente_editado', { id: dados.id }, usuarioId);
      await registrarSeTerminal(tx, 'cliente', dados.id);
      return dados.id;
    }
    const id = novoId();
    await tx.run(
      `INSERT INTO clientes (id, nome, nome_busca, telefone, documento, saldo_fiado_centavos, limite_fiado_centavos, ativo, criado_em, atualizado_em, dispositivo_id)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?)`,
      [id, nome, normalizarBusca(nome), telefone, documento, limite, agora, agora, ctx().dispositivoId],
    );
    await auditar(tx, 'cliente_criado', { id, nome }, usuarioId);
    await registrarSeTerminal(tx, 'cliente', id);
    return id;
  });
}

export function obterCliente(db, id) {
  return db.get('SELECT * FROM clientes WHERE id = ?', [id]);
}

export function buscarClientes(db, termo, { limite = 30, soComFiado = false } = {}) {
  const n = normalizarBusca(termo).replace(/[\\%_]/g, (c) => `\\${c}`);
  const dig = String(termo || '').replace(/\D/g, '');
  const filtroFiado = soComFiado ? 'AND saldo_fiado_centavos > 0' : '';
  if (!n) return db.all(`SELECT * FROM clientes WHERE ativo = 1 ${filtroFiado} ORDER BY nome_busca LIMIT ?`, [limite]);
  const porNumero = dig.length >= 3;
  return db.all(
    `SELECT * FROM clientes WHERE ativo = 1 ${filtroFiado}
       AND (nome_busca LIKE ? ESCAPE '\\' ${porNumero ? 'OR telefone LIKE ? OR documento LIKE ?' : ''})
     ORDER BY nome_busca LIMIT ?`,
    porNumero ? [`%${n}%`, `%${dig}%`, `${dig}%`, limite] : [`%${n}%`, limite],
  );
}

/** Lança no fiado + atualiza saldo (chamar dentro de transação). `valor` > 0 aumenta a dívida, < 0 abate. */
export async function lancarFiado(tx, { clienteId, tipo, valorCentavos, metodo = null, vendaId = null, caixaId = null, usuarioId = null }) {
  const id = novoId();
  await tx.run(
    `INSERT INTO fiado_lancamentos (id, cliente_id, tipo, valor_centavos, metodo, venda_id, caixa_id, usuario_id, criado_em, dispositivo_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, clienteId, tipo, valorCentavos, metodo, vendaId, caixaId, usuarioId, agoraIso(), ctx().dispositivoId],
  );
  await tx.run('UPDATE clientes SET saldo_fiado_centavos = saldo_fiado_centavos + ?, atualizado_em = ? WHERE id = ?', [valorCentavos, agoraIso(), clienteId]);
  return id;
}

/** Cliente pagando (parte d)o que deve. Dinheiro entra no caixa aberto. */
export async function receberFiado(db, { clienteId, valorCentavos, metodo }, usuarioId) {
  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) throw new ErroDeNegocio('Valor inválido.');
  if (!['dinheiro', 'credito', 'debito', 'pix'].includes(metodo)) throw new ErroDeNegocio('Forma de pagamento inválida.');
  return db.transacao(async (tx) => {
    const c = await tx.get('SELECT * FROM clientes WHERE id = ?', [clienteId]);
    if (!c) throw new ErroDeNegocio('Cliente não encontrado.');
    if (valorCentavos > c.saldo_fiado_centavos) throw new ErroDeNegocio('O valor é maior que o saldo devedor do cliente.');
    const caixa = await tx.get(`SELECT id FROM caixas WHERE status = 'aberto'`);
    if (!caixa) throw new ErroDeNegocio('Abra o caixa antes de receber pagamento.', 'caixa_fechado');
    const lancamentoId = await lancarFiado(tx, { clienteId, tipo: 'pagamento', valorCentavos: -valorCentavos, metodo, caixaId: caixa.id, usuarioId });
    await auditar(tx, 'fiado_recebido', { clienteId, valorCentavos, metodo }, usuarioId);
    await registrarSeTerminal(tx, 'fiado_pagamento', lancamentoId);
    return c.saldo_fiado_centavos - valorCentavos;
  });
}

export function extratoFiado(db, clienteId, limite = 100) {
  return db.all(
    `SELECT f.*, v.numero AS venda_numero FROM fiado_lancamentos f LEFT JOIN vendas v ON v.id = f.venda_id
     WHERE f.cliente_id = ? ORDER BY f.criado_em DESC LIMIT ?`,
    [clienteId, limite],
  );
}
