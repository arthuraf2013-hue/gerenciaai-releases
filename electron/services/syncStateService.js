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
  const tem = (campo) => !!dadosInstalacao && Object.prototype.hasOwnProperty.call(dadosInstalacao, campo);
  // Só a Central tira a máquina do grupo, e ela grava o campo como null
  // (desvincular / apagar grupo). Documento SEM o campo (pedaço do
  // documento, instalação recém-criada) não mexe no grupo daqui: tirar e
  // pôr de novo relê o catálogo e reenvia todo o histórico de vendas.
  if (!tem('grupoSincronizacaoId')) return;
  const estadoAntes = getLocalState();
  const grupoAntes = estadoAntes.grupo_sincronizacao_id;
  const servidorAntes = estadoAntes.servidor_do_grupo;
  const novoGrupoId = dadosInstalacao.grupoSincronizacaoId || null;
  const novoServidor = tem('servidorDoGrupo')
    ? (dadosInstalacao.servidorDoGrupo === true ? 1 : 0)
    : (novoGrupoId && novoGrupoId === grupoAntes ? servidorAntes : 0);

  db.prepare('UPDATE sync_state SET grupo_sincronizacao_id = ?, servidor_do_grupo = ? WHERE id = ?')
    .run(novoGrupoId, novoServidor, 'default');
  // Confirmado pela Central: lembra (o grupo volta sozinho se sumir daqui)
  // ou marca que ela tirou a máquina de propósito (aí não volta).
  if (novoGrupoId) {
    db.prepare(`UPDATE sync_state SET ultimo_grupo_id = ?, ultimo_servidor = ?, saiu_do_grupo = 0, grupo_recuperado = 0 WHERE id = 'default'`)
      .run(novoGrupoId, novoServidor);
  } else {
    db.prepare(`UPDATE sync_state SET saiu_do_grupo = 1, grupo_recuperado = 0 WHERE id = 'default'`).run();
  }
  // Voltando ao MESMO grupo de antes (sumiu daqui e a Central confirmou):
  // só o que falta, nada de reenviar todo o histórico.
  const mesmoGrupoDeAntes = !!novoGrupoId && novoGrupoId === estadoAntes.ultimo_grupo_id;

  if (novoGrupoId !== grupoAntes || novoServidor !== servidorAntes) {
    // Rede local (servidor atende os caixas / caixa fala com o servidor) e o
    // que a Central vê na presença.
    setImmediate(() => {
      try { require('./grupoTransporteService').reavaliar(); } catch (err) { console.error('[syncStateService]', err?.message || err); }
      try { require('./presencaService').atualizarDados(); } catch { /* sem presença */ }
    });
  }

  if (novoGrupoId !== grupoAntes) {
    // Mudou de grupo de verdade (entrou, saiu, ou trocou) — religa a
    // réplica (produtos, clientes e fiado iguais em todos os caixas: lê o
    // grupo, casa o que já existe aqui e manda o resto) e o histórico.
    // O estoque inicial do servidor espera a réplica: o contador usa o
    // id do produto NO GRUPO (grupoReplicaService.paraGrupo).
    try {
      const replica = require('./productSyncService').iniciarEscutaProdutos();
      if (novoGrupoId) require('./salesSyncService').pushTodoOHistorico(mesmoGrupoDeAntes ? { apenasPendentes: true } : {});
      if (novoGrupoId && novoServidor) {
        Promise.resolve(replica).finally(() => require('./stockSyncService').pushEstoqueInicial());
      }
      // Usuários e PINs iguais em todos os caixas (ou para, se saiu do grupo).
      require('./userSyncService').iniciar();
    } catch (err) {
      console.error('[syncStateService] falha ao reagir à mudança de grupo:', err);
    }
  } else if (novoGrupoId && novoServidor && novoServidor !== servidorAntes) {
    // Continuou no MESMO grupo, mas acabou de virar a servidor agora
    // (marcado depois, pelo painel, inclusive trocando de servidor para
    // redundância). Só cria o contador dos produtos que o grupo ainda não
    // tem -- nunca regrava os que já existem (ver pushEstoqueInicial).
    try {
      require('./stockSyncService').pushEstoqueInicial();
    } catch (err) {
      console.error('[syncStateService] falha ao mandar estoque inicial ao virar servidor:', err);
    }
  }
}

const ID_DE_GRUPO = /^[A-Za-z0-9_-]{6,128}$/;

/**
 * Grupo vazio aqui, mas o computador tem rastro dele: volta para o grupo
 * sem esperar o Firebase. Chamado ao abrir, ANTES de ligar rede local e
 * réplicas (main.js), e só grava sync_state (quem liga é o fluxo normal).
 *
 * Por que: até a v1.0.32, um documento incompleto do SDK (sem internet,
 * Firebase fora, sem cota) apagava o grupo daqui; sem conseguir ler o
 * Firebase de novo, a máquina ficava sem grupo -- usuários/PIN diferentes,
 * sem fotos, sem a tela da rede local. A Central continua mandando: quando
 * o documento dela chegar, vale o que estiver lá (null = tirada de
 * propósito, e aí não volta mais sozinha -- saiu_do_grupo).
 *
 * Rastros, do mais forte ao mais fraco:
 *   ultimo_grupo_id  o último grupo que a Central confirmou (v1.0.34+)
 *   lan_cliente      caixa pareado com o servidor da loja (é caixa)
 *   lan_meta hub_grupo  foi o servidor da loja deste grupo (é servidor)
 *   grupo_replica    produtos/clientes já casados com o grupo
 */
function recuperarGrupoLocal() {
  const db = getDb();
  const estado = getLocalState();
  if (!estado || estado.grupo_sincronizacao_id || estado.saiu_do_grupo) return null;
  const valido = (g) => (typeof g === 'string' && ID_DE_GRUPO.test(g) ? g : null);
  const consulta = (sql) => { try { return db.prepare(sql).get(); } catch { return undefined; } }; // tabela pode não existir

  let achado = null;
  if (valido(estado.ultimo_grupo_id)) {
    achado = { grupoId: estado.ultimo_grupo_id, servidor: estado.ultimo_servidor ? 1 : 0, origem: 'ultimo_confirmado' };
  }
  if (!achado) {
    const g = valido(consulta(`SELECT grupo_id FROM lan_cliente WHERE id = 'default'`)?.grupo_id);
    if (g) achado = { grupoId: g, servidor: 0, origem: 'rede_local_caixa' };
  }
  if (!achado) {
    const g = valido(consulta(`SELECT valor FROM lan_meta WHERE chave = 'hub_grupo'`)?.valor);
    if (g) achado = { grupoId: g, servidor: 1, origem: 'rede_local_servidor' };
  }
  if (!achado) {
    const g = valido(consulta(`SELECT grupo_id, COUNT(*) AS n FROM grupo_replica GROUP BY grupo_id ORDER BY n DESC LIMIT 1`)?.grupo_id);
    if (g) achado = { grupoId: g, servidor: 0, origem: 'replica' };
  }
  if (!achado) return null;

  db.prepare(`UPDATE sync_state SET grupo_sincronizacao_id = ?, servidor_do_grupo = ?, grupo_recuperado = 1 WHERE id = 'default'`)
    .run(achado.grupoId, achado.servidor);
  console.warn(`[syncStateService] grupo recuperado deste computador (${achado.origem}); a Central confirma quando o Firebase responder.`);
  return achado;
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

module.exports = { getGrupoSincronizacaoId, aplicarGrupoDaInstalacao, ehServidorDoGrupo, recuperarGrupoLocal };
