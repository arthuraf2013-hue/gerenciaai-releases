// Escolher, pelo próprio GerenciaAI, qual computador do grupo é o SERVIDOR
// (Configurações -> Sincronização -> "Servidor do grupo"; admin e suporte).
// O servidor guarda as mesas e o estoque e é onde os outros caixas leem e
// gravam pela rede local.
//
// O campo `servidorDoGrupo` do documento da instalação é de controle: pelas
// regras do Firestore só uma sessão da Central (conta de administrador) grava
// -- sem isso, qualquer PC com o app podia virar servidor do grupo de outra
// loja. Por isso a troca pede o e-mail e a senha da Central, usados só nesta
// gravação, num app do Firebase à parte que é apagado logo em seguida (o resto
// do GerenciaAI continua sem login). Mesma gravação da Central
// (alternarServidorDoGrupo): desmarca o anterior e marca o escolhido, num lote.
// Cada máquina recebe a mudança pela escuta do próprio documento
// (syncStateService.aplicarDaInstalacao) e liga/desliga a rede local sozinha.

const { randomUUID } = require('crypto');

const nomeDaMaquina = (d, id) => d?.nomeComputador || d?.nomeNegocio || `Máquina ${String(id).slice(0, 8)}`;

function grupoAtual() {
  try { return require('./syncStateService').getGrupoSincronizacaoId() || null; } catch { return null; }
}

/** Os computadores do grupo (leitura aberta pelas regras), com quem é o servidor. */
async function listarMaquinas() {
  const grupoId = grupoAtual();
  if (!grupoId) return { ok: false, error: 'Este computador não está em um grupo de sincronização.' };
  const { collection, query, where, getDocs } = require('firebase/firestore');
  const db = require('./licenseService').getLicenseFirestore();
  const euId = require('./pdvRegistryService').getOrCreateDeviceUid();
  try {
    const snap = await getDocs(query(collection(db, 'installations'), where('grupoSincronizacaoId', '==', grupoId)));
    const maquinas = snap.docs
      .map((d) => ({ id: d.id, dados: d.data() }))
      .filter((m) => !m.dados.excluidaEm && m.dados.tipo !== 'celular')
      .map((m) => ({
        id: m.id,
        nome: nomeDaMaquina(m.dados, m.id),
        servidor: m.dados.servidorDoGrupo === true,
        versao: m.dados.versaoApp || null,
        ultimoContato: m.dados.ultimoContato?.toDate ? m.dados.ultimoContato.toDate().toISOString() : (m.dados.ultimoContato || null),
        estaMaquina: m.id === euId,
      }))
      .sort((a, b) => Number(b.servidor) - Number(a.servidor) || a.nome.localeCompare(b.nome));
    return { ok: true, grupoId, maquinas };
  } catch (err) {
    return { ok: false, error: `Não consegui ler os computadores do grupo agora (${err?.message || err}). Confira a internet.` };
  }
}

function mensagemDeErro(err) {
  const code = String(err?.code || '');
  if (/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(code)) return 'E-mail ou senha da Central incorretos.';
  if (/too-many-requests/.test(code)) return 'Muitas tentativas de login. Espere alguns minutos e tente de novo.';
  if (/permission-denied/.test(code)) return 'Essa conta entrou, mas não é administradora da Central: o Firebase recusou a troca.';
  if (/network-request-failed|unavailable/.test(code)) return 'Sem internet para falar com a Central agora. A troca do servidor precisa de internet.';
  return err?.message || String(err);
}

/** Valida e monta a troca (pura, testada): quem desmarca e quem marca. */
function planejarTroca(maquinas, instalacaoId) {
  const alvo = maquinas.find((m) => m.id === instalacaoId);
  if (!alvo) return { ok: false, error: 'Esse computador não está neste grupo.' };
  if (alvo.servidor) return { ok: false, error: `${alvo.nome} já é o servidor do grupo.` };
  return { ok: true, alvo, desmarcar: maquinas.filter((m) => m.servidor && m.id !== instalacaoId) };
}

let backendDeTeste = null;

async function gravarComContaDaCentral({ email, senha, desmarcar, marcar }) {
  if (backendDeTeste) return backendDeTeste({ email, senha, desmarcar, marcar });
  const { initializeApp, deleteApp } = require('firebase/app');
  const { getAuth, signInWithEmailAndPassword, signOut, initializeAuth, inMemoryPersistence } = require('firebase/auth');
  const { getFirestore, writeBatch, doc } = require('firebase/firestore');
  const app = initializeApp(require('./licenseService').LICENSE_FIREBASE_CONFIG, `troca-servidor-${randomUUID()}`);
  try {
    let auth;
    try { auth = initializeAuth(app, { persistence: inMemoryPersistence }); } catch { auth = getAuth(app); }
    await signInWithEmailAndPassword(auth, String(email || '').trim(), String(senha || ''));
    const fs = getFirestore(app);
    const lote = writeBatch(fs);
    for (const id of desmarcar) lote.update(doc(fs, 'installations', id), { servidorDoGrupo: false });
    lote.update(doc(fs, 'installations', marcar), { servidorDoGrupo: true });
    await lote.commit();
    await signOut(auth).catch(() => {});
  } finally {
    await deleteApp(app).catch(() => {});
  }
}

/** Marca `instalacaoId` como servidor do grupo (com a conta da Central). */
async function escolherServidor({ solicitanteId, instalacaoId, email, senha } = {}) {
  const guard = require('./authService').requireRole(solicitanteId, ['admin', 'suporte']);
  if (!guard.ok) return guard;
  if (!email || !senha) return { ok: false, error: 'Informe o e-mail e a senha da Central.' };
  const lista = await module.exports.listarMaquinas();
  if (!lista.ok) return lista;
  const plano = planejarTroca(lista.maquinas, instalacaoId);
  if (!plano.ok) return plano;
  try {
    await gravarComContaDaCentral({ email, senha, desmarcar: plano.desmarcar.map((m) => m.id), marcar: plano.alvo.id });
  } catch (err) {
    return { ok: false, error: mensagemDeErro(err) };
  }
  const { getDb } = require('../db/database');
  try {
    const nome = getDb().prepare('SELECT nome FROM users WHERE id = ?').get(solicitanteId)?.nome || 'usuário';
    getDb().prepare(`INSERT INTO audit_log (id, tipo_evento, solicitante_id, motivo, sucesso) VALUES (?, 'servidor_do_grupo_trocado', ?, ?, 1)`)
      .run(randomUUID(), solicitanteId, `${plano.alvo.nome} virou o servidor do grupo${plano.desmarcar.length ? ` (antes: ${plano.desmarcar.map((m) => m.nome).join(', ')})` : ''} -- por ${nome}, com a conta da Central ${String(email).trim()}`);
  } catch { /* auditoria não trava */ }
  return { ok: true, servidor: plano.alvo.nome, antes: plano.desmarcar.map((m) => m.nome) };
}

function _definirBackendParaTeste(fn) { backendDeTeste = fn || null; }

module.exports = { listarMaquinas, escolherServidor, planejarTroca, mensagemDeErro, _definirBackendParaTeste };
