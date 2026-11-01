const { getDb } = require('../db/database');

/**
 * Permissões finas do ERP (Fase 2, fundação). O papel continua sendo a
 * primeira barreira (PAPEL_POR_CANAL no IPC); isto só permite ao admin
 * RETIRAR de um gerente o acesso a uma área do ERP. Escolhas de projeto:
 *  - sem linha = permitido (instalação antiga não muda nada);
 *  - admin e suporte nunca são restritos (ninguém se tranca fora);
 *  - operador/garçom já não passam pelo papel, então não há o que retirar.
 * A checagem é por PREFIXO de canal, aplicada em politicaDeAcesso() a todo
 * canal -- canal novo de uma área já nasce coberto.
 */

const PERMISSOES = {
  'erp.compras': { rotulo: 'Compras (pedidos e notas de entrada)', canais: ['purchaseOrder:', 'nfeEntrada:'] },
  'erp.financeiro': { rotulo: 'Financeiro (contas, fluxo de caixa e DRE)', canais: ['financeiro:', 'expense:'] },
  'erp.estoque': { rotulo: 'Inventário e movimentação de estoque', canais: ['inventario:'] },
  'erp.fiscal': { rotulo: 'Fiscal (assistente e regras tributárias)', canais: ['assistenteFiscal:', 'tributacao:'] },
  'erp.comercial': { rotulo: 'Comissões e metas', canais: ['comissao:'] },
  'erp.bi': { rotulo: 'Painel executivo', canais: ['bi:'] },
  'erp.rh': { rotulo: 'Equipe (cadastro, salários e férias)', canais: ['rh:'] },
  'erp.config': { rotulo: 'Configurações do ERP', canais: ['erp:salvarConfig'] },
};

const PAPEIS_SEM_RESTRICAO = ['admin', 'suporte'];

function permissaoDoCanal(canal) {
  for (const [chave, p] of Object.entries(PERMISSOES)) {
    if (p.canais.some((c) => (c.endsWith(':') ? canal.startsWith(c) : canal === c))) return chave;
  }
  return null;
}

function papelDe(usuarioId) {
  return getDb().prepare('SELECT role FROM users WHERE id = ? AND ativo = 1').get(usuarioId)?.role || null;
}

/** true/false para uma permissão do catálogo. */
function temPermissao(usuarioId, permissao) {
  if (!PERMISSOES[permissao]) throw new Error(`Permissão desconhecida: ${permissao}`);
  const papel = papelDe(usuarioId);
  if (!papel) return false;
  if (PAPEIS_SEM_RESTRICAO.includes(papel)) return true;
  const linha = getDb().prepare('SELECT permitido FROM user_permission_overrides WHERE user_id = ? AND permissao = ?').get(usuarioId, permissao);
  return linha ? linha.permitido === 1 : true;
}

/** null se pode seguir; senão o erro pronto para o IPC. */
function negadoPorPermissao(usuarioId, canal) {
  const permissao = permissaoDoCanal(canal);
  if (!permissao || temPermissao(usuarioId, permissao)) return null;
  return { ok: false, error: `Seu usuário não tem acesso a: ${PERMISSOES[permissao].rotulo}. Peça ao administrador.`, semPermissao: true };
}

function catalogo() {
  return Object.entries(PERMISSOES).map(([chave, p]) => ({ chave, rotulo: p.rotulo }));
}

function doUsuario(usuarioId) {
  const papel = papelDe(usuarioId);
  if (!papel) return { ok: false, error: 'Usuário não encontrado.' };
  return {
    ok: true,
    papel,
    restringivel: papel === 'gerente',
    permissoes: Object.fromEntries(Object.keys(PERMISSOES).map((k) => [k, temPermissao(usuarioId, k)])),
  };
}

/** Só admin/suporte (conferido no IPC). Grava só o que mudou. */
function salvar({ usuarioId, permissoes, operadorId }) {
  const db = getDb();
  const papel = papelDe(usuarioId);
  if (!papel) return { ok: false, error: 'Usuário não encontrado.' };
  if (papel !== 'gerente') return { ok: false, error: 'Só dá para restringir áreas do ERP de um gerente. Admin e suporte têm acesso a tudo; operador não chega ao ERP.' };
  if (!permissoes || typeof permissoes !== 'object') return { ok: false, error: 'Permissões inválidas.' };
  for (const k of Object.keys(permissoes)) if (!PERMISSOES[k]) return { ok: false, error: `Permissão desconhecida: ${k}` };
  const alteradas = [];
  db.transaction(() => {
    for (const [k, valor] of Object.entries(permissoes)) {
      const novo = valor ? 1 : 0;
      if ((temPermissao(usuarioId, k) ? 1 : 0) === novo) continue;
      db.prepare(
        `INSERT INTO user_permission_overrides (user_id, permissao, permitido, alterado_por) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, permissao) DO UPDATE SET permitido = excluded.permitido, alterado_por = excluded.alterado_por, alterado_em = datetime('now')`
      ).run(usuarioId, k, novo, operadorId || null);
      alteradas.push(`${PERMISSOES[k].rotulo}: ${novo ? 'liberado' : 'retirado'}`);
    }
  })();
  return { ok: true, alteradas };
}

module.exports = { PERMISSOES, catalogo, temPermissao, negadoPorPermissao, permissaoDoCanal, doUsuario, salvar };
