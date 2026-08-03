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
  const novoGrupoId = dadosInstalacao.grupoSincronizacaoId || null;
  const novoServidor = dadosInstalacao.servidorDoGrupo === true ? 1 : 0;
  const estadoAntes = getLocalState();
  const grupoAntes = estadoAntes.grupo_sincronizacao_id;
  const servidorAntes = estadoAntes.servidor_do_grupo;

  db.prepare('UPDATE sync_state SET grupo_sincronizacao_id = ?, servidor_do_grupo = ? WHERE id = ?')
    .run(novoGrupoId, novoServidor, 'default');

  if (novoGrupoId !== grupoAntes) {
    // Mudou de grupo de verdade (entrou, saiu, ou trocou) — reinicia a
    // escuta de produtos pro grupo novo (ou desliga, se saiu), e manda
    // o catálogo inteiro se acabou de entrar num grupo novo.
    try {
      require('./productSyncService').iniciarEscutaProdutos();
      if (novoGrupoId) require('./productSyncService').pushTodosOsProdutos();
      if (novoGrupoId) require('./salesSyncService').pushTodoOHistorico();
      if (novoGrupoId && novoServidor) require('./stockSyncService').pushEstoqueInicial();
    } catch (err) {
      console.error('[syncStateService] falha ao reagir à mudança de grupo:', err);
    }
  } else if (novoGrupoId && novoServidor && novoServidor !== servidorAntes) {
    // Continuou no MESMO grupo, mas acabou de virar a servidor agora
    // (marcado depois, pelo painel) — precisa mandar o estoque atual
    // dela pro grupo nesse momento, senão o contador compartilhado
    // fica vazio/desatualizado até a próxima mudança de estoque.
    try {
      require('./stockSyncService').pushEstoqueInicial();
    } catch (err) {
      console.error('[syncStateService] falha ao mandar estoque inicial ao virar servidor:', err);
    }
  }
}

/** Se essa máquina é a "servidor" do grupo — só ela é responsável por
 * manter o contador de estoque compartilhado atualizado com a
 * contagem física real. As outras só consultam/debitam. */
function ehServidorDoGrupo() {
  return getLocalState().servidor_do_grupo === 1;
}

/** Qual grupo essa instalação pertence agora — só dado local, sem
 * rede. null = sincronização não configurada pro Arthur ainda. */
function getGrupoSincronizacaoId() {
  return getLocalState().grupo_sincronizacao_id;
}

module.exports = { getGrupoSincronizacaoId, aplicarGrupoDaInstalacao, ehServidorDoGrupo };
