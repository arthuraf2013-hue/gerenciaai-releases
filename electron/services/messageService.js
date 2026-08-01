const { getDb } = require('../db/database');

function getLocalState() {
  const db = getDb();
  return db.prepare('SELECT * FROM home_message_state WHERE id = ?').get('default');
}

function saveGlobalMessage({ texto, imagemUrl, ativa }) {
  const db = getDb();
  const atual = getLocalState();
  db.prepare(
    `UPDATE home_message_state SET global_texto = ?, global_imagem_url = ?, global_ativa = ? WHERE id = ?`
  ).run(
    texto !== undefined ? texto : atual.global_texto,
    imagemUrl !== undefined ? imagemUrl : atual.global_imagem_url,
    ativa !== undefined ? (ativa ? 1 : 0) : atual.global_ativa,
    'default'
  );
}

/** Chamado pelo listener da própria instalação (já existe em
 * licenseService) — não abre uma conexão nova, só aproveita o dado que
 * já veio junto no mesmo documento, pra não duplicar leitura. */
function aplicarMensagemDaInstalacao(dadosInstalacao) {
  const db = getDb();
  db.prepare(
    `UPDATE home_message_state SET mensagem_personalizada = ?, motivo_bloqueio = ? WHERE id = ?`
  ).run(dadosInstalacao.mensagemPersonalizada || null, dadosInstalacao.motivoBloqueio || null, 'default');
}

/** O que a tela inicial do app deve mostrar agora — só dado local, sem
 * rede, pode ser chamado a qualquer momento. */
function getMensagensParaExibir() {
  const state = getLocalState();
  return {
    global: state.global_ativa === 1 && (state.global_texto || state.global_imagem_url)
      ? { texto: state.global_texto, imagemUrl: state.global_imagem_url }
      : null,
    personalizada: state.mensagem_personalizada || null,
  };
}

/** Motivo customizado de bloqueio (se o admin escreveu um) — usado na
 * tela de bloqueio do LicenseGate, no lugar da mensagem genérica. */
function getMotivoBloqueio() {
  return getLocalState().motivo_bloqueio || null;
}

let pararEscutaGlobal = null;

/** Escuta em tempo real o documento único de mensagem global — o
 * mesmo padrão já usado pra config de atualização. */
function iniciarEscutaMensagemGlobal() {
  try {
    const licenseService = require('./licenseService');
    const { doc, onSnapshot } = require('firebase/firestore');
    const firestore = licenseService.getLicenseFirestore();
    const ref = doc(firestore, 'config', 'mensagem');

    if (pararEscutaGlobal) pararEscutaGlobal();
    pararEscutaGlobal = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const d = snap.data();
          saveGlobalMessage({ texto: d.texto || null, imagemUrl: d.imagemUrl || null, ativa: d.ativa === true });
        } else {
          saveGlobalMessage({ texto: null, imagemUrl: null, ativa: false });
        }
      },
      (err) => console.error('[messageService] escuta de mensagem global falhou:', err)
    );
  } catch (err) {
    console.error('[messageService] não foi possível iniciar a escuta de mensagem global:', err);
  }
}

module.exports = {
  getMensagensParaExibir, getMotivoBloqueio, aplicarMensagemDaInstalacao, iniciarEscutaMensagemGlobal,
};
