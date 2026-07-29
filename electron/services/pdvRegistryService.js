const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

let firebaseApp = null;
let firestoreDb = null;
let authInstance = null;

function getFirebaseConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM firebase_config WHERE id = ?').get('default');
}

function getFirebaseConfigPublic() {
  const config = getFirebaseConfig();
  return {
    apiKey: config.api_key || '',
    authDomain: config.auth_domain || '',
    projectId: config.project_id || '',
    appId: config.app_id || '',
    ativado: !!config.ativado,
  };
}

function updateFirebaseConfig(payload) {
  const db = getDb();
  const current = getFirebaseConfig();
  db.prepare(
    `UPDATE firebase_config SET api_key = ?, auth_domain = ?, project_id = ?, app_id = ?, ativado = ? WHERE id = 'default'`
  ).run(
    payload.apiKey ?? current.api_key,
    payload.authDomain ?? current.auth_domain,
    payload.projectId ?? current.project_id,
    payload.appId ?? current.app_id,
    payload.ativado ? 1 : 0
  );
  // Config mudou — descarta qualquer conexão anterior pra reconectar com os dados novos.
  firebaseApp = null;
  firestoreDb = null;
  authInstance = null;
  return { ok: true };
}

/** device_uid é gerado uma única vez, localmente, na primeira vez que
 * alguém tenta registrar este PDV. Nunca muda depois — é o que garante
 * que reabrir o app ou reconectar não crie um PDV novo no Firebase. */
function getOrCreateDeviceUid() {
  const db = getDb();
  const location = db.prepare('SELECT * FROM locations LIMIT 1').get();
  if (location.device_uid) return location.device_uid;

  const uid = randomUUID();
  db.prepare('UPDATE locations SET device_uid = ? WHERE id = ?').run(uid, location.id);
  return uid;
}

async function getFirestoreConnection() {
  if (firestoreDb && authInstance?.currentUser) return { db: firestoreDb, auth: authInstance };

  const config = getFirebaseConfig();
  if (!config.ativado || !config.api_key || !config.project_id) {
    throw new Error('Sincronização entre PDVs não configurada. Ative em Configurações → Sincronização.');
  }

  // Import tardio — só carrega o SDK do Firebase se essa funcionalidade
  // opcional realmente for usada.
  const { initializeApp } = require('firebase/app');
  const { getFirestore } = require('firebase/firestore');
  const { getAuth, signInAnonymously } = require('firebase/auth');

  if (!firebaseApp) {
    firebaseApp = initializeApp({
      apiKey: config.api_key,
      authDomain: config.auth_domain,
      projectId: config.project_id,
      appId: config.app_id,
    });
    firestoreDb = getFirestore(firebaseApp);
    authInstance = getAuth(firebaseApp);
  }

  if (!authInstance.currentUser) {
    await signInAnonymously(authInstance);
  }

  return { db: firestoreDb, auth: authInstance };
}

/** Status local — nunca toca a rede, só olha o que já está salvo. */
function getStatus() {
  const db = getDb();
  const location = db.prepare('SELECT numero_pdv, device_uid FROM locations LIMIT 1').get();
  const fiscal = db.prepare('SELECT cnpj FROM fiscal_config WHERE id = ?').get('default');
  return {
    numeroPdv: location.numero_pdv || null,
    cnpjConfigurado: !!fiscal?.cnpj,
  };
}

/**
 * Registra (ou recupera) o número deste PDV para o CNPJ configurado em
 * Fiscal. Idempotente: se este device_uid já tem um número para esse
 * CNPJ, devolve o mesmo número em vez de gerar um novo. A numeração é
 * sequencial e atômica via transação do Firestore — dois PDVs
 * registrando ao mesmo tempo nunca recebem o mesmo número.
 */
async function registerPdv() {
  const db = getDb();
  const fiscal = db.prepare('SELECT cnpj FROM fiscal_config WHERE id = ?').get('default');
  if (!fiscal?.cnpj) {
    return { ok: false, error: 'Configure o CNPJ em Configurações → Fiscal antes de registrar este PDV.' };
  }
  const cnpjLimpo = fiscal.cnpj.replace(/[^\d]/g, '');
  if (!cnpjLimpo) {
    return { ok: false, error: 'CNPJ inválido em Configurações → Fiscal.' };
  }

  let connection;
  try {
    connection = await getFirestoreConnection();
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const { doc, runTransaction } = require('firebase/firestore');
  const deviceUid = getOrCreateDeviceUid();
  const location = db.prepare('SELECT * FROM locations LIMIT 1').get();

  const counterRef = doc(connection.db, 'cnpjs', cnpjLimpo);
  const pdvRef = doc(connection.db, 'cnpjs', cnpjLimpo, 'pdvs', deviceUid);

  let numero;
  try {
    numero = await runTransaction(connection.db, async (tx) => {
      const pdvSnap = await tx.get(pdvRef);
      if (pdvSnap.exists()) {
        // Já registrado antes — devolve o mesmo número, não cria outro.
        return pdvSnap.data().numero;
      }

      const counterSnap = await tx.get(counterRef);
      const proximo = counterSnap.exists() ? (counterSnap.data().proximoNumero || 1) : 1;
      const numeroFormatado = `PDV${String(proximo).padStart(3, '0')}`;

      tx.set(counterRef, { proximoNumero: proximo + 1 }, { merge: true });
      tx.set(pdvRef, {
        numero: numeroFormatado,
        nomeLocal: location.nome,
        registradoEm: new Date().toISOString(),
      });

      return numeroFormatado;
    });
  } catch (err) {
    return { ok: false, error: `Falha ao registrar no Firebase: ${err.message}` };
  }

  db.prepare('UPDATE locations SET numero_pdv = ? WHERE id = ?').run(numero, location.id);
  return { ok: true, numero };
}

function getCnpjLimpo() {
  const db = getDb();
  const fiscal = db.prepare('SELECT cnpj FROM fiscal_config WHERE id = ?').get('default');
  return fiscal?.cnpj ? fiscal.cnpj.replace(/[^\d]/g, '') : null;
}

/** Checagem leve — só confirma que dá pra falar com o Firebase agora,
 * sem buscar nenhum dado. Usado pro indicador de conexão na tela. */
async function checkConnection() {
  try {
    await getFirestoreConnection();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getFirebaseConfigPublic, updateFirebaseConfig, getStatus, registerPdv,
  getFirestoreConnection, getCnpjLimpo, checkConnection, getOrCreateDeviceUid,
};
