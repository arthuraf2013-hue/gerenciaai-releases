import { novoId, agoraIso, normalizarBusca, ErroDeNegocio, auditar, ctx } from './base.js';
import { exigirModoAutonomo } from './terminal.js';

/** Movimento de estoque + saldo em cache, sempre juntos (chamar dentro de transação). */
export async function registrarMovimento(tx, { produtoId, tipo, qtdMil, motivo = null, vendaId = null, usuarioId = null }) {
  await tx.run(
    `INSERT INTO movimentos_estoque (id, produto_id, tipo, qtd_mil, motivo, venda_id, usuario_id, criado_em, dispositivo_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [novoId(), produtoId, tipo, qtdMil, motivo, vendaId, usuarioId, agoraIso(), ctx().dispositivoId],
  );
  await tx.run('UPDATE produtos SET estoque_mil = estoque_mil + ?, atualizado_em = ? WHERE id = ?', [qtdMil, agoraIso(), produtoId]);
}

function validar(dados) {
  const nome = String(dados.nome || '').trim();
  if (!nome) throw new ErroDeNegocio('Informe o nome do produto.');
  if (!Number.isInteger(dados.precoCentavos) || dados.precoCentavos < 0) throw new ErroDeNegocio('Preço inválido.');
  const custo = dados.custoCentavos ?? 0;
  if (!Number.isInteger(custo) || custo < 0) throw new ErroDeNegocio('Custo inválido.');
  const unidade = dados.unidade || 'un';
  if (!['un', 'kg'].includes(unidade)) throw new ErroDeNegocio('Unidade inválida.');
  const codigo = String(dados.codigoBarras || '').trim() || null;
  if (codigo && !/^[0-9A-Za-z.\-]{1,40}$/.test(codigo)) throw new ErroDeNegocio('Código de barras inválido.');
  return { nome, unidade, codigo, custo };
}

async function garantirCodigoLivre(db, codigo, idAtual) {
  if (!codigo) return;
  const outro = await db.get('SELECT id, nome FROM produtos WHERE codigo_barras = ? AND id != ?', [codigo, idAtual || '']);
  if (outro) throw new ErroDeNegocio(`O código ${codigo} já é do produto "${outro.nome}".`, 'codigo_duplicado');
}

export async function salvarProduto(db, dados, usuarioId) {
  exigirModoAutonomo('Cadastro de produto');
  const { nome, unidade, codigo, custo } = validar(dados);
  return db.transacao(async (tx) => {
    await garantirCodigoLivre(tx, codigo, dados.id);
    const agora = agoraIso();
    if (dados.id) {
      const r = await tx.run(
        `UPDATE produtos SET nome = ?, nome_busca = ?, codigo_barras = ?, categoria = ?, unidade = ?, preco_centavos = ?,
           custo_centavos = ?, estoque_minimo_mil = ?, controla_estoque = ?, atualizado_em = ? WHERE id = ?`,
        [nome, normalizarBusca(nome), codigo, dados.categoria || null, unidade, dados.precoCentavos, custo,
          dados.estoqueMinimoMil || 0, dados.controlaEstoque === false ? 0 : 1, agora, dados.id],
      );
      if (!r.changes) throw new ErroDeNegocio('Produto não encontrado.');
      await auditar(tx, 'produto_editado', { id: dados.id, nome, precoCentavos: dados.precoCentavos }, usuarioId);
      return dados.id;
    }
    const id = novoId();
    await tx.run(
      `INSERT INTO produtos (id, nome, nome_busca, codigo_barras, categoria, unidade, preco_centavos, custo_centavos,
         estoque_mil, estoque_minimo_mil, controla_estoque, ativo, criado_em, atualizado_em, dispositivo_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?)`,
      [id, nome, normalizarBusca(nome), codigo, dados.categoria || null, unidade, dados.precoCentavos, custo,
        dados.estoqueMinimoMil || 0, dados.controlaEstoque === false ? 0 : 1, agora, agora, ctx().dispositivoId],
    );
    if (dados.estoqueInicialMil > 0) {
      await registrarMovimento(tx, { produtoId: id, tipo: 'inicial', qtdMil: dados.estoqueInicialMil, motivo: 'Estoque inicial', usuarioId });
    }
    await auditar(tx, 'produto_criado', { id, nome }, usuarioId);
    return id;
  });
}

export function obterProduto(db, id) {
  return db.get('SELECT * FROM produtos WHERE id = ?', [id]);
}

export function produtoPorCodigo(db, codigo) {
  return db.get('SELECT * FROM produtos WHERE codigo_barras = ? AND ativo = 1', [String(codigo || '').trim()]);
}

/**
 * Busca do PDV: código exato primeiro; depois nome, com "começa com"
 * na frente de "contém". `LIKE` com o termo escapado (um "%" digitado
 * não vira coringa).
 */
export async function buscarProdutos(db, termo, { limite = 30, incluirInativos = false } = {}) {
  const t = String(termo || '').trim();
  const filtroAtivo = incluirInativos ? '' : 'AND ativo = 1';
  if (!t) {
    return db.all(`SELECT * FROM produtos WHERE 1 = 1 ${filtroAtivo} ORDER BY nome_busca LIMIT ?`, [limite]);
  }
  const porCodigo = await db.get(`SELECT * FROM produtos WHERE codigo_barras = ? ${filtroAtivo}`, [t]);
  const n = normalizarBusca(t).replace(/[\\%_]/g, (c) => `\\${c}`);
  const linhas = await db.all(
    `SELECT *, (nome_busca LIKE ? ESCAPE '\\') AS comeca FROM produtos
     WHERE (nome_busca LIKE ? ESCAPE '\\' OR codigo_barras LIKE ? ESCAPE '\\') ${filtroAtivo}
     ORDER BY comeca DESC, nome_busca LIMIT ?`,
    [`${n}%`, `%${n}%`, `${n}%`, limite],
  );
  const lista = linhas.map(({ comeca, ...p }) => p);
  if (porCodigo && !lista.some((p) => p.id === porCodigo.id)) lista.unshift(porCodigo);
  else if (porCodigo) lista.sort((a, b) => (a.id === porCodigo.id ? -1 : b.id === porCodigo.id ? 1 : 0));
  return lista;
}

/** Entrada de mercadoria (soma) ou contagem (define o saldo exato). */
export async function movimentarEstoque(db, { produtoId, modo, qtdMil, motivo }, usuarioId) {
  exigirModoAutonomo('Entrada e contagem de estoque');
  if (!Number.isInteger(qtdMil) || qtdMil < 0 || (modo === 'entrada' && qtdMil === 0)) throw new ErroDeNegocio('Quantidade inválida.');
  return db.transacao(async (tx) => {
    const p = await tx.get('SELECT id, nome, estoque_mil FROM produtos WHERE id = ?', [produtoId]);
    if (!p) throw new ErroDeNegocio('Produto não encontrado.');
    const delta = modo === 'contagem' ? qtdMil - p.estoque_mil : qtdMil;
    if (delta === 0) return p.estoque_mil;
    await registrarMovimento(tx, {
      produtoId, tipo: modo === 'contagem' ? 'ajuste' : 'entrada', qtdMil: delta,
      motivo: motivo || (modo === 'contagem' ? 'Contagem de estoque' : 'Entrada de mercadoria'), usuarioId,
    });
    return p.estoque_mil + delta;
  });
}

export async function definirProdutoAtivo(db, id, ativo, usuarioId) {
  exigirModoAutonomo('Ativar/desativar produto');
  await db.run('UPDATE produtos SET ativo = ?, atualizado_em = ? WHERE id = ?', [ativo ? 1 : 0, agoraIso(), id]);
  await auditar(db, ativo ? 'produto_reativado' : 'produto_desativado', { id }, usuarioId);
}

export function estoqueBaixo(db) {
  return db.all(
    `SELECT * FROM produtos WHERE ativo = 1 AND controla_estoque = 1 AND estoque_mil <= estoque_minimo_mil ORDER BY estoque_mil - estoque_minimo_mil, nome_busca`,
  );
}

export function historicoDoProduto(db, produtoId, limite = 50) {
  return db.all('SELECT * FROM movimentos_estoque WHERE produto_id = ? ORDER BY criado_em DESC LIMIT ?', [produtoId, limite]);
}
