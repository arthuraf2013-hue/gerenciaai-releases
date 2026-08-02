const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/** device_uid é gerado uma única vez, localmente, na primeira vez que
 * este PDV precisa de uma identidade estável no Firestore (licença,
 * sincronização, etc.). Nunca muda depois — reabrir o app não cria
 * uma instalação nova. */
function getOrCreateDeviceUid() {
  const db = getDb();
  const location = db.prepare('SELECT * FROM locations LIMIT 1').get();
  if (!location) {
    // Não deveria acontecer numa instalação normal — seedIfEmpty()
    // sempre garante pelo menos um local na inicialização — mas se por
    // algum motivo acontecer, isso quebraria checkLicense() inteiro
    // sem aviso nenhum. Melhor um erro claro do que um crash silencioso.
    throw new Error('Nenhum local (location) cadastrado — o banco pode não ter sido inicializado corretamente.');
  }
  if (location.device_uid) return location.device_uid;

  const uid = randomUUID();
  db.prepare('UPDATE locations SET device_uid = ? WHERE id = ?').run(uid, location.id);
  return uid;
}

/** Status local da sincronização entre PDVs — nunca toca a rede, só
 * olha o que já está salvo (atribuído centralmente pelo painel de
 * licenciamento, via o mesmo documento de instalação já escutado em
 * tempo real). */
function getSyncStatus() {
  const syncStateService = require('./syncStateService');
  return { sincronizacaoAtiva: !!syncStateService.getGrupoSincronizacaoId() };
}

module.exports = { getOrCreateDeviceUid, getSyncStatus };
