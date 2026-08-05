const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Lista categorias — mescla a tabela dedicada (permite categoria
 * existir mesmo sem nenhum produto ainda, ex: acabou de criar) com
 * qualquer nome de categoria que já apareça em produtos mas ainda não
 * tenha sido formalmente cadastrado (dado antigo, de antes dessa
 * tabela existir, ou vindo de importação de planilha).
 */
function list() {
  const db = getDb();
  const categoriasFormais = db.prepare('SELECT id, nome FROM categories').all();
  const contagens = db.prepare(
    `SELECT categoria, COUNT(*) as total FROM products
     WHERE ativo = 1 AND categoria IS NOT NULL AND TRIM(categoria) != ''
     GROUP BY categoria`
  ).all();
  const contagemPorNome = Object.fromEntries(contagens.map((c) => [c.categoria, c.total]));

  const porNome = new Map();
  for (const c of categoriasFormais) {
    porNome.set(c.nome, { id: c.id, nome: c.nome, totalProdutos: contagemPorNome[c.nome] || 0 });
  }
  // Categorias "órfãs" -- em produtos, mas nunca formalmente criadas.
  for (const nome of Object.keys(contagemPorNome)) {
    if (!porNome.has(nome)) {
      porNome.set(nome, { id: null, nome, totalProdutos: contagemPorNome[nome] });
    }
  }

  return [...porNome.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

/** Cria uma categoria nova — pode existir mesmo sem nenhum produto
 * usando ela ainda, pra dar pra escolher na hora de cadastrar. */
function create({ nome }) {
  const db = getDb();
  const nomeLimpo = (nome || '').trim();
  if (!nomeLimpo) return { ok: false, error: 'Informe um nome pra categoria.' };

  const jaExiste = db.prepare('SELECT id FROM categories WHERE nome = ?').get(nomeLimpo);
  if (jaExiste) return { ok: false, error: 'Já existe uma categoria com esse nome.' };

  const id = randomUUID();
  db.prepare('INSERT INTO categories (id, nome) VALUES (?, ?)').run(id, nomeLimpo);
  return { ok: true, id };
}

/**
 * Renomeia uma categoria — atualiza a tabela dedicada (se já
 * cadastrada formalmente) E todo produto que usa o nome antigo, pra
 * nunca ficar com produto "órfão" apontando pro nome que não existe
 * mais.
 */
function rename({ nomeAntigo, nomeNovo }) {
  const db = getDb();
  const nomeNovoLimpo = (nomeNovo || '').trim();
  if (!nomeNovoLimpo) return { ok: false, error: 'Informe o novo nome.' };
  if (nomeNovoLimpo === nomeAntigo) return { ok: true };

  const conflito = db.prepare('SELECT id FROM categories WHERE nome = ?').get(nomeNovoLimpo);
  if (conflito) return { ok: false, error: 'Já existe uma categoria com esse nome.' };

  const tx = db.transaction(() => {
    db.prepare('UPDATE categories SET nome = ? WHERE nome = ?').run(nomeNovoLimpo, nomeAntigo);
    db.prepare('UPDATE products SET categoria = ? WHERE categoria = ?').run(nomeNovoLimpo, nomeAntigo);
  });
  tx();
  return { ok: true };
}

/**
 * Exclui uma categoria — os produtos que usavam ela ficam sem
 * categoria (NULL), a menos que `moverParaCategoria` seja informado,
 * caso em que são realocados pra essa outra categoria em vez de
 * ficarem soltos.
 */
function remove({ nome, moverParaCategoria }) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('UPDATE products SET categoria = ? WHERE categoria = ?').run(moverParaCategoria || null, nome);
    db.prepare('DELETE FROM categories WHERE nome = ?').run(nome);
  });
  tx();
  return { ok: true };
}

const TAMANHO_LOTE_IA = 80; // produtos por chamada -- evita um prompt gigante de uma vez só

/**
 * Busca produtos sem categoria e pede sugestões pra IA, em lotes (pra
 * não mandar um catálogo inteiro numa única chamada). Nunca aplica
 * sozinho — devolve as sugestões pra revisão antes de qualquer coisa
 * ser realmente salva.
 */
async function sugerirCategoriasComIA({ limite } = {}) {
  const db = getDb();
  const semCategoria = db.prepare(
    `SELECT id, nome FROM products WHERE ativo = 1 AND (categoria IS NULL OR TRIM(categoria) = '') ORDER BY nome LIMIT ?`
  ).all(limite || 500);

  if (semCategoria.length === 0) return { ok: true, sugestoes: [], totalSemCategoria: 0 };

  const categoriasExistentes = list().map((c) => c.nome);
  const aiService = require('./aiService');

  const todasAsSugestoes = [];
  for (let i = 0; i < semCategoria.length; i += TAMANHO_LOTE_IA) {
    const lote = semCategoria.slice(i, i + TAMANHO_LOTE_IA);
    const resultado = await aiService.sugerirCategorias(lote, categoriasExistentes);
    if (!resultado.ok) return resultado; // erro de configuração/API interrompe tudo, nada foi salvo ainda
    todasAsSugestoes.push(...resultado.sugestoes);
  }

  // Junta o nome do produto de volta (a IA só devolve id + categoria),
  // pra facilitar mostrar a lista de revisão sem outra consulta.
  const nomesPorId = Object.fromEntries(semCategoria.map((p) => [p.id, p.nome]));
  const sugestoesComNome = todasAsSugestoes.map((s) => ({
    produtoId: s.produtoId, produtoNome: nomesPorId[s.produtoId] || '(produto não encontrado)', categoriaSugerida: s.categoria,
  }));

  return { ok: true, sugestoes: sugestoesComNome, totalSemCategoria: semCategoria.length };
}

/** Aplica as sugestões que a pessoa revisou e aceitou — cria
 * categorias novas que ainda não existem formalmente, e atualiza cada
 * produto com a categoria escolhida. */
function aplicarSugestoes(sugestoesAceitas) {
  const db = getDb();
  const tx = db.transaction(() => {
    for (const s of sugestoesAceitas) {
      const jaExiste = db.prepare('SELECT id FROM categories WHERE nome = ?').get(s.categoriaSugerida);
      if (!jaExiste) {
        db.prepare('INSERT INTO categories (id, nome) VALUES (?, ?)').run(randomUUID(), s.categoriaSugerida);
      }
      db.prepare('UPDATE products SET categoria = ? WHERE id = ?').run(s.categoriaSugerida, s.produtoId);
    }
  });
  tx();
  return { ok: true, totalAplicado: sugestoesAceitas.length };
}

module.exports = { list, create, rename, remove, sugerirCategoriasComIA, aplicarSugestoes };
