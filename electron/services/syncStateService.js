const { getDb } = require('../db/database');

function getLocalState() {
  const db = getDb();
  return db.prepare('SELECT * FROM sync_state WHERE id = ?').get('default');
}

/** Chamado pelo listener em tempo real da própria instalação (já
 * existe em licenseService) — aproveita o dado que já veio junto no
 * mesmo documento, sem precisar de outra consulta ao Firestore. */
function aplicarGrupoDaInstalacao(dadosInstalacao) {
  const db = getDb();
  db.prepare('UPDATE sync_state SET grupo_sincronizacao_id = ? WHERE id = ?')
    .run(dadosInstalacao.grupoSincronizacaoId || null, 'default');
}

/** Qual grupo essa instalação pertence agora — só dado local, sem
 * rede. null = sincronização não configurada pro Arthur ainda. */
function getGrupoSincronizacaoId() {
  return getLocalState().grupo_sincronizacao_id;
}

module.exports = { getGrupoSincronizacaoId, aplicarGrupoDaInstalacao };
