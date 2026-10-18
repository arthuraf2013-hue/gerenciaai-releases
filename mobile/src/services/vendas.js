import { novoId, agoraIso, ErroDeNegocio, auditar, ctx, lerConfig, gravarConfig, totalItemCentavos } from './base.js';
import { registrarMovimento } from './produtos.js';
import { lancarFiado } from './clientes.js';
import { caixaAberto } from './caixa.js';
import { autorizarGerente } from './usuarios.js';
import { registrarSeTerminal } from './terminal.js';

export const METODOS = {
  dinheiro: 'Dinheiro',
  credito: 'Cartão de crédito',
  debito: 'Cartão de débito',
  pix: 'Pix',
  fiado: 'Fiado',
};

// A licença (licenca.js) registra aqui quem decide se pode vender. Fica
// como "guarda" injetada (em vez de import direto) pra regra de venda não
// depender de rede/Firebase -- e mesmo se alguma tela esquecer de checar,
// a venda em si recusa.
let guardaDeVenda = async () => {};
export function definirGuardaDeVenda(fn) { guardaDeVenda = fn; }

export async function configDeVenda(db) {
  return {
    descontoMaxPercent: Number(await lerConfig(db, 'desconto_max_percent', 10)),
    permitirEstoqueNegativo: !!(await lerConfig(db, 'permitir_estoque_negativo', false)),
  };
}

async function proximoNumero(tx) {
  const seq = Number(await lerConfig(tx, 'seq_venda', 0)) + 1;
  await gravarConfig(tx, 'seq_venda', seq);
  return `${ctx().prefixoVenda}-${String(seq).padStart(6, '0')}`;
}

/**
 * Monta os itens com o preço ATUAL do banco (não confia no carrinho) e
 * valida quantidade/estoque. Exportado pra tela calcular o total do
 * carrinho com a mesma regra da finalização.
 */
export async function precificarItens(db, itens, { permitirEstoqueNegativo = false } = {}) {
  if (!Array.isArray(itens) || itens.length === 0) throw new ErroDeNegocio('O carrinho está vazio.');
  const somaPorProduto = new Map();
  const linhas = [];
  for (const item of itens) {
    const p = await db.get('SELECT * FROM produtos WHERE id = ?', [item.produtoId]);
    if (!p || !p.ativo) throw new ErroDeNegocio(`Produto não está mais disponível: ${item.nome || item.produtoId}.`);
    const qtd = item.qtdMil;
    if (!Number.isInteger(qtd) || qtd <= 0) throw new ErroDeNegocio(`Quantidade inválida em ${p.nome}.`);
    if (p.unidade === 'un' && qtd % 1000 !== 0) throw new ErroDeNegocio(`${p.nome} é vendido por unidade — use quantidade inteira.`);
    somaPorProduto.set(p.id, (somaPorProduto.get(p.id) || 0) + qtd);
    linhas.push({ produto: p, qtdMil: qtd, precoUnitCentavos: p.preco_centavos, totalCentavos: totalItemCentavos(p.preco_centavos, qtd) });
  }
  if (!permitirEstoqueNegativo) {
    for (const [produtoId, qtd] of somaPorProduto) {
      const p = linhas.find((l) => l.produto.id === produtoId).produto;
      if (p.controla_estoque && qtd > p.estoque_mil) {
        const disp = p.unidade === 'kg' ? `${(p.estoque_mil / 1000).toFixed(3).replace('.', ',')} kg` : `${Math.max(0, p.estoque_mil / 1000)} un`;
        throw new ErroDeNegocio(`Estoque insuficiente de ${p.nome}. Disponível: ${disp}.`, 'estoque_insuficiente');
      }
    }
  }
  const subtotalCentavos = linhas.reduce((s, l) => s + l.totalCentavos, 0);
  return { linhas, subtotalCentavos };
}

function validarPagamentos(pagamentos, totalCentavos, clienteId) {
  const lista = (pagamentos || []).filter((p) => p && p.valorCentavos > 0);
  for (const p of lista) {
    if (!METODOS[p.metodo]) throw new ErroDeNegocio('Forma de pagamento inválida.');
    if (!Number.isInteger(p.valorCentavos)) throw new ErroDeNegocio('Valor de pagamento inválido.');
    if (p.metodo === 'dinheiro') {
      const recebido = p.recebidoCentavos ?? p.valorCentavos;
      if (!Number.isInteger(recebido) || recebido < p.valorCentavos) throw new ErroDeNegocio('Valor recebido em dinheiro menor que o lançado.');
    } else if (p.recebidoCentavos != null && p.recebidoCentavos !== p.valorCentavos) {
      throw new ErroDeNegocio('Só pagamento em dinheiro pode ter troco.');
    }
    if (p.metodo === 'fiado' && !clienteId) throw new ErroDeNegocio('Para vender no fiado, escolha o cliente.', 'fiado_sem_cliente');
  }
  const soma = lista.reduce((s, p) => s + p.valorCentavos, 0);
  if (soma !== totalCentavos) {
    throw new ErroDeNegocio(soma < totalCentavos ? 'Falta pagamento para fechar o total da venda.' : 'Os pagamentos passam do total da venda.', 'pagamento_diferente');
  }
  const troco = lista.reduce((s, p) => s + (p.metodo === 'dinheiro' ? (p.recebidoCentavos ?? p.valorCentavos) - p.valorCentavos : 0), 0);
  return { lista, troco };
}

export async function finalizarVenda(db, { itens, descontoCentavos = 0, pagamentos, clienteId = null, pinGerenteDesconto = null }, operadorId) {
  await guardaDeVenda();
  const config = await configDeVenda(db);
  return db.transacao(async (tx) => {
    const caixa = await caixaAberto(tx);
    if (!caixa) throw new ErroDeNegocio('Abra o caixa antes de vender.', 'caixa_fechado');
    const { linhas, subtotalCentavos } = await precificarItens(tx, itens, config);

    if (!Number.isInteger(descontoCentavos) || descontoCentavos < 0 || descontoCentavos > subtotalCentavos) {
      throw new ErroDeNegocio('Desconto inválido.');
    }
    let autorizadoPor = null;
    const limite = Math.floor((subtotalCentavos * config.descontoMaxPercent) / 100);
    if (descontoCentavos > limite) {
      if (!pinGerenteDesconto) throw new ErroDeNegocio(`Desconto acima de ${config.descontoMaxPercent}% precisa de autorização de gerente.`, 'desconto_precisa_autorizacao');
      autorizadoPor = (await autorizarGerente(tx, { pin: pinGerenteDesconto, solicitanteId: operadorId })).id;
    }
    const totalCentavos = subtotalCentavos - descontoCentavos;

    let cliente = null;
    if (clienteId) {
      cliente = await tx.get('SELECT * FROM clientes WHERE id = ? AND ativo = 1', [clienteId]);
      if (!cliente) throw new ErroDeNegocio('Cliente não encontrado.');
    }
    const { lista, troco } = validarPagamentos(pagamentos, totalCentavos, clienteId);
    const fiado = lista.filter((p) => p.metodo === 'fiado').reduce((s, p) => s + p.valorCentavos, 0);
    if (fiado && cliente.limite_fiado_centavos != null && cliente.saldo_fiado_centavos + fiado > cliente.limite_fiado_centavos) {
      throw new ErroDeNegocio(`Passa do limite de fiado de ${cliente.nome}.`, 'limite_fiado');
    }

    const id = novoId();
    const numero = await proximoNumero(tx);
    const agora = agoraIso();
    await tx.run(
      `INSERT INTO vendas (id, numero, caixa_id, operador_id, cliente_id, status, subtotal_centavos, desconto_centavos, total_centavos,
         troco_centavos, desconto_autorizado_por, criado_em, dispositivo_id)
       VALUES (?, ?, ?, ?, ?, 'finalizada', ?, ?, ?, ?, ?, ?, ?)`,
      [id, numero, caixa.id, operadorId, clienteId, subtotalCentavos, descontoCentavos, totalCentavos, troco, autorizadoPor, agora, ctx().dispositivoId],
    );
    for (const l of linhas) {
      await tx.run(
        `INSERT INTO venda_itens (id, venda_id, produto_id, nome, unidade, preco_unit_centavos, qtd_mil, total_centavos) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [novoId(), id, l.produto.id, l.produto.nome, l.produto.unidade, l.precoUnitCentavos, l.qtdMil, l.totalCentavos],
      );
      if (l.produto.controla_estoque) {
        await registrarMovimento(tx, { produtoId: l.produto.id, tipo: 'venda', qtdMil: -l.qtdMil, vendaId: id, usuarioId: operadorId });
      }
    }
    for (const p of lista) {
      await tx.run(
        'INSERT INTO pagamentos (id, venda_id, metodo, valor_centavos, recebido_centavos) VALUES (?, ?, ?, ?, ?)',
        [novoId(), id, p.metodo, p.valorCentavos, p.metodo === 'dinheiro' ? (p.recebidoCentavos ?? p.valorCentavos) : null],
      );
    }
    if (fiado) await lancarFiado(tx, { clienteId, tipo: 'compra', valorCentavos: fiado, vendaId: id, caixaId: caixa.id, usuarioId: operadorId });
    await auditar(tx, 'venda_finalizada', { id, numero, totalCentavos, descontoCentavos, autorizadoPor }, operadorId);
    // Terminal: o retrato da venda pro computador entra NA MESMA transação.
    await registrarSeTerminal(tx, 'venda', id);
    return obterVenda(tx, id);
  });
}

export async function obterVenda(db, id) {
  const venda = await db.get(
    `SELECT v.*, u.nome AS operador_nome, c.nome AS cliente_nome, c.telefone AS cliente_telefone FROM vendas v
     LEFT JOIN usuarios u ON u.id = v.operador_id LEFT JOIN clientes c ON c.id = v.cliente_id WHERE v.id = ?`,
    [id],
  );
  if (!venda) return null;
  venda.itens = await db.all('SELECT * FROM venda_itens WHERE venda_id = ? ORDER BY rowid', [id]);
  venda.pagamentos = await db.all('SELECT * FROM pagamentos WHERE venda_id = ? ORDER BY rowid', [id]);
  return venda;
}

/** Cancelamento: só gerente/admin (e nunca o próprio operador), só venda de caixa ainda aberto. Devolve estoque e estorna fiado. */
export async function cancelarVenda(db, { vendaId, motivo, pinGerente }, solicitanteId) {
  const motivoLimpo = String(motivo || '').trim();
  if (!motivoLimpo) throw new ErroDeNegocio('Informe o motivo do cancelamento.');
  return db.transacao(async (tx) => {
    const venda = await tx.get('SELECT * FROM vendas WHERE id = ?', [vendaId]);
    if (!venda) throw new ErroDeNegocio('Venda não encontrada.');
    if (venda.status === 'cancelada') throw new ErroDeNegocio('Essa venda já foi cancelada.');
    const caixa = await tx.get('SELECT status FROM caixas WHERE id = ?', [venda.caixa_id]);
    if (caixa?.status !== 'aberto') throw new ErroDeNegocio('Essa venda é de um caixa já fechado e não pode mais ser cancelada aqui.', 'caixa_ja_fechado');
    const gerente = await autorizarGerente(tx, { pin: pinGerente, solicitanteId });

    const itens = await tx.all('SELECT vi.*, p.controla_estoque FROM venda_itens vi JOIN produtos p ON p.id = vi.produto_id WHERE vi.venda_id = ?', [vendaId]);
    for (const i of itens) {
      if (i.controla_estoque) {
        await registrarMovimento(tx, { produtoId: i.produto_id, tipo: 'cancelamento_venda', qtdMil: i.qtd_mil, vendaId, motivo: motivoLimpo, usuarioId: gerente.id });
      }
    }
    const fiado = await tx.valor(`SELECT COALESCE(SUM(valor_centavos), 0) FROM pagamentos WHERE venda_id = ? AND metodo = 'fiado'`, [vendaId]);
    if (fiado > 0) await lancarFiado(tx, { clienteId: venda.cliente_id, tipo: 'estorno', valorCentavos: -fiado, vendaId, caixaId: venda.caixa_id, usuarioId: gerente.id });

    await tx.run(
      `UPDATE vendas SET status = 'cancelada', cancelada_em = ?, cancelada_por = ?, motivo_cancelamento = ? WHERE id = ?`,
      [agoraIso(), gerente.id, motivoLimpo, vendaId],
    );
    await auditar(tx, 'venda_cancelada', { id: vendaId, numero: venda.numero, motivo: motivoLimpo, autorizadoPor: gerente.id }, solicitanteId);
    await registrarSeTerminal(tx, 'venda_cancelada', vendaId);
    return obterVenda(tx, vendaId);
  });
}

export function listarVendas(db, { inicio, fim, caixaId = null, limite = 200 }) {
  const filtroCaixa = caixaId ? 'AND v.caixa_id = ?' : '';
  return db.all(
    `SELECT v.*, c.nome AS cliente_nome, u.nome AS operador_nome,
       (SELECT GROUP_CONCAT(DISTINCT metodo) FROM pagamentos WHERE venda_id = v.id) AS metodos
     FROM vendas v LEFT JOIN clientes c ON c.id = v.cliente_id LEFT JOIN usuarios u ON u.id = v.operador_id
     WHERE v.criado_em >= ? AND v.criado_em < ? ${filtroCaixa} ORDER BY v.criado_em DESC LIMIT ?`,
    caixaId ? [inicio, fim, caixaId, limite] : [inicio, fim, limite],
  );
}
