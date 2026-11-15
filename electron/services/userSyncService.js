// Usuários iguais em todos os caixas do grupo de sincronização (multi-PDV).
//
// Cada usuário vira um documento em grupos_sincronizacao/{g}/usuarios/{doc}
// com nome, papel, ativo, o hash bcrypt do PIN e "PIN temporário" -- o
// mesmo PIN entra em qualquer caixa do grupo. Criar, desativar, redefinir
// ou trocar o PIN num caixa chega nos outros.
//
// Regras (testadas em tests/usuariosDoGrupo.test.js):
// - vence a alteração mais nova (versaoMs); o eco da própria gravação não
//   muda nada;
// - caixa que entra no grupo casa os usuários pelo NOME com os do grupo
//   (o "Administrador" de um caixa novo vira o mesmo do grupo e passa a
//   usar o PIN de lá); quem não existe no grupo é publicado;
// - fica de fora: 'suporte' (acesso técnico é por máquina), operadores de
//   demonstração, os criados só para histórico do celular ("(celular)") e
//   o admin de fábrica que ainda está com o PIN 0000 (não entra no grupo
//   enquanto não trocar o PIN -- PIN padrão não se espalha);
// - o que vem do grupo é conferido (papel conhecido, hash bcrypt, nome) e
//   nunca deixa o caixa sem nenhum administrador ativo;
// - tentativas erradas e bloqueio continuam por caixa.
// Falha de rede nunca atrapalha o login nem o cadastro local: o que não
// subiu sobe na próxima sincronização (a versão local fica mais nova).

const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');
const syncStateService = require('./syncStateService');

const PAPEIS = ['operador', 'gerente', 'admin', 'garcom'];
const HASH_BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const SO_DESTE_CAIXA = /\((demonstração|celular)\)\s*$/i;

function normalizarNome(nome) {
  return String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Admin de fábrica que ninguém usou ainda (PIN 0000 temporário). */
function pinDeFabrica(pinHash, pinTemporario) {
  if (!pinTemporario) return false;
  try { return bcrypt.compareSync('0000', pinHash); } catch { return false; }
}

/** Usuário local que pode ir para o grupo. */
function podeSincronizar(u) {
  return !!u && PAPEIS.includes(u.role) && !SO_DESTE_CAIXA.test(u.nome || '') && HASH_BCRYPT.test(u.pin_hash || '');
}

/** Pode entrar no grupo pela PRIMEIRA vez? O admin de fábrica (PIN 0000
 * nunca trocado) fica só neste caixa. Depois de vinculado, tudo sobe --
 * inclusive um PIN redefinido para 0000 (temporário, troca no 1º acesso). */
function podeEntrarNoGrupo(u) {
  return podeSincronizar(u) && !pinDeFabrica(u.pin_hash, u.pin_temporario === 1);
}

/** Documento do grupo em condições de virar usuário neste caixa. */
function docValido(d) {
  return !!d && typeof d.nome === 'string' && d.nome.trim().length > 0 && d.nome.length <= 80
    && PAPEIS.includes(d.role) && typeof d.pinHash === 'string' && HASH_BCRYPT.test(d.pinHash)
    && Number.isFinite(d.versaoMs) && d.versaoMs > 0 && !SO_DESTE_CAIXA.test(d.nome);
}

function paraDoc(u, versaoMs, origem) {
  return {
    nome: u.nome, role: u.role, ativo: u.ativo === 1, pinHash: u.pin_hash,
    pinTemporario: u.pin_temporario === 1, versaoMs, origem: origem || null,
  };
}

function origemDesteCaixa() {
  try { return require('./pdvRegistryService').getOrCreateDeviceUid(); } catch { return null; }
}

function grupoAtual() {
  try { return syncStateService.getGrupoSincronizacaoId() || null; } catch { return null; }
}

/** Mudar este usuário assim deixa o caixa sem administrador ativo? */
function tiraOUltimoAdmin(db, atual, novoPapel, novoAtivo) {
  const eraAdmin = atual.ativo === 1 && ['admin', 'suporte'].includes(atual.role);
  const continuaAdmin = novoAtivo && ['admin', 'suporte'].includes(novoPapel);
  if (!eraAdmin || continuaAdmin) return false;
  const outros = db.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE ativo = 1 AND role IN ('admin','suporte') AND id <> ?`
  ).get(atual.id).n;
  return outros === 0;
}

/**
 * Junta o que veio do grupo com os usuários deste caixa.
 * @param {string} grupoId
 * @param {Map<string, object>} remotos  docId -> dados (todos, ou só os que mudaram)
 * @param {{completo?: boolean}} opcoes  completo = `remotos` é o grupo inteiro
 *        (aí também publica quem ainda não está lá)
 * @returns {Array<{docId:string, dados:object}>} o que este caixa precisa publicar
 */
function mesclar(grupoId, remotos, { completo = false } = {}) {
  const db = getDb();
  const origem = origemDesteCaixa();
  const publicar = [];

  db.transaction(() => {
    const vinculos = db.prepare('SELECT user_id, doc_id, versao_ms FROM user_group_sync WHERE grupo_id = ?').all(grupoId);
    const porDoc = new Map(vinculos.map((v) => [v.doc_id, v]));
    const porUsuario = new Map(vinculos.map((v) => [v.user_id, v]));
    const vincular = db.prepare('INSERT OR REPLACE INTO user_group_sync (user_id, grupo_id, doc_id, versao_ms) VALUES (?, ?, ?, ?)');
    const buscar = db.prepare('SELECT * FROM users WHERE id = ?');

    function guardarVinculo(userId, docId, versao) {
      vincular.run(userId, grupoId, docId, versao);
      const v = { user_id: userId, doc_id: docId, versao_ms: versao };
      porDoc.set(docId, v);
      porUsuario.set(userId, v);
    }

    for (const [docId, r] of remotos) {
      if (!docValido(r)) continue;
      let v = porDoc.get(docId);

      if (!v) {
        // Mesmo nome de um usuário deste caixa ainda sem vínculo = a mesma pessoa.
        const alvo = normalizarNome(r.nome);
        const local = db.prepare('SELECT * FROM users').all().find((u) =>
          !porUsuario.has(u.id) && PAPEIS.includes(u.role) && !SO_DESTE_CAIXA.test(u.nome || '') && normalizarNome(u.nome) === alvo);
        if (local) {
          guardarVinculo(local.id, docId, 0); // versão 0: o do grupo vale
          v = porDoc.get(docId);
        } else {
          if (!r.ativo) continue; // não traz quem já chega desativado
          const id = buscar.get(docId) ? randomUUID() : docId;
          db.prepare('INSERT INTO users (id, nome, role, pin_hash, pin_temporario, ativo) VALUES (?, ?, ?, ?, ?, 1)')
            .run(id, r.nome.trim(), r.role, r.pinHash, r.pinTemporario ? 1 : 0);
          guardarVinculo(id, docId, r.versaoMs);
          continue;
        }
      }

      const atual = buscar.get(v.user_id);
      if (!atual) continue;
      if (r.versaoMs > v.versao_ms) {
        if (tiraOUltimoAdmin(db, atual, r.role, r.ativo === true)) {
          console.warn('[userSyncService] alteração do grupo ignorada: deixaria este caixa sem administrador ativo.');
          continue;
        }
        const trocouPin = atual.pin_hash !== r.pinHash;
        db.prepare(
          `UPDATE users SET nome = ?, role = ?, ativo = ?, pin_hash = ?, pin_temporario = ?
             ${trocouPin ? ', tentativas_falhas = 0, bloqueado_ate = NULL' : ''} WHERE id = ?`
        ).run(r.nome.trim(), r.role, r.ativo === true ? 1 : 0, r.pinHash, r.pinTemporario ? 1 : 0, atual.id);
        guardarVinculo(atual.id, docId, r.versaoMs);
      } else if (r.versaoMs < v.versao_ms && podeSincronizar(atual)) {
        // Este caixa tem a versão mais nova (alteração que não tinha subido).
        publicar.push({ docId, dados: paraDoc(atual, v.versao_ms, origem) });
      }
    }

    if (!completo) return;
    const agora = Date.now();
    for (const u of db.prepare('SELECT * FROM users').all()) {
      if (!podeSincronizar(u)) continue;
      const v = porUsuario.get(u.id);
      if (!v) {
        if (!podeEntrarNoGrupo(u)) continue;
        const docId = porDoc.has(u.id) ? randomUUID() : u.id;
        guardarVinculo(u.id, docId, agora);
        publicar.push({ docId, dados: paraDoc(u, agora, origem) });
      } else if (!remotos.has(v.doc_id)) {
        // Vinculado, mas o documento sumiu do grupo (grupo recriado): publica de novo.
        const versao = Math.max(v.versao_ms, 1);
        publicar.push({ docId: v.doc_id, dados: paraDoc(u, versao, origem) });
      }
    }
  })();

  return publicar;
}

// --- Firestore (trocável nos testes) ----------------------------------------

let backend = {
  async lerTodos(grupoId) {
    const firestore = require('./licenseService').getLicenseFirestore();
    const { collection, getDocs } = require('firebase/firestore');
    const snap = await getDocs(collection(firestore, 'grupos_sincronizacao', grupoId, 'usuarios'));
    return new Map(snap.docs.map((d) => [d.id, d.data()]));
  },
  async gravar(grupoId, docId, dados) {
    const firestore = require('./licenseService').getLicenseFirestore();
    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
    await setDoc(doc(firestore, 'grupos_sincronizacao', grupoId, 'usuarios', docId), { ...dados, atualizadoEm: serverTimestamp() });
  },
  escutar(grupoId, aoMudar, aoErrar) {
    const firestore = require('./licenseService').getLicenseFirestore();
    const { collection, onSnapshot } = require('firebase/firestore');
    return onSnapshot(collection(firestore, 'grupos_sincronizacao', grupoId, 'usuarios'), (snap) => {
      const mudou = new Map();
      for (const ch of snap.docChanges()) if (ch.type !== 'removed') mudou.set(ch.doc.id, ch.doc.data());
      aoMudar(mudou);
    }, aoErrar);
  },
};
function _definirBackendParaTeste(b) { backend = { ...backend, ...b }; }

async function publicarLista(grupoId, lista) {
  for (const { docId, dados } of lista) {
    try {
      await backend.gravar(grupoId, docId, dados);
    } catch (err) {
      console.error('[userSyncService] não foi possível publicar um usuário (vai de novo na próxima sincronização):', err.message);
    }
  }
}

/** Lê o grupo inteiro, junta com este caixa e publica o que falta. */
async function sincronizarTudo() {
  const grupoId = grupoAtual();
  if (!grupoId) return { ok: true, grupo: false };
  try {
    const remotos = await backend.lerTodos(grupoId);
    const publicar = mesclar(grupoId, remotos, { completo: true });
    await publicarLista(grupoId, publicar);
    return { ok: true, grupo: true, publicados: publicar.length };
  } catch (err) {
    console.error('[userSyncService] falha ao sincronizar usuários:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Chamado logo depois de criar, ativar/desativar, redefinir ou trocar o
 * PIN de um usuário NESTE caixa. Nunca lança; a publicação é em segundo plano.
 */
function aoMudarLocalmente(userId) {
  try {
    const grupoId = grupoAtual();
    if (!grupoId || !userId) return null;
    const db = getDb();
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!podeSincronizar(u)) return null;
    const v = db.prepare('SELECT doc_id, versao_ms FROM user_group_sync WHERE user_id = ? AND grupo_id = ?').get(userId, grupoId);
    if (!v && !podeEntrarNoGrupo(u)) return null;
    const versao = Math.max(Date.now(), (v?.versao_ms || 0) + 1);
    let docId = v?.doc_id;
    if (!docId) {
      const ocupado = db.prepare('SELECT 1 FROM user_group_sync WHERE grupo_id = ? AND doc_id = ?').get(grupoId, userId);
      docId = ocupado ? randomUUID() : userId;
    }
    db.prepare('INSERT OR REPLACE INTO user_group_sync (user_id, grupo_id, doc_id, versao_ms) VALUES (?, ?, ?, ?)')
      .run(userId, grupoId, docId, versao);
    const lista = [{ docId, dados: paraDoc(u, versao, origemDesteCaixa()) }];
    return publicarLista(grupoId, lista);
  } catch (err) {
    console.error('[userSyncService] falha ao registrar alteração de usuário:', err.message);
    return null;
  }
}

let pararEscuta = null;
let geracao = 0;

/** Liga (ou religa, ao trocar de grupo) a sincronização de usuários. */
function iniciar() {
  parar();
  const minha = ++geracao;
  const grupoId = grupoAtual();
  if (!grupoId) return Promise.resolve();
  return sincronizarTudo().then((r) => {
    if (minha !== geracao || grupoAtual() !== grupoId) return;
    // Sem internet ao abrir: tenta a sincronização completa de novo a cada minuto.
    const tentarDeNovo = () => {
      const t = setTimeout(async () => {
        if (minha !== geracao) return;
        if (!(await sincronizarTudo()).ok) tentarDeNovo();
      }, 60000);
      t.unref?.();
    };
    if (!r.ok) tentarDeNovo();
    try {
      pararEscuta = backend.escutar(grupoId, (mudou) => {
        try {
          if (grupoAtual() !== grupoId) return;
          publicarLista(grupoId, mesclar(grupoId, mudou)).catch(() => {});
        } catch (err) {
          console.error('[userSyncService] falha ao aplicar usuários do grupo:', err.message);
        }
      }, (err) => console.error('[userSyncService] escuta de usuários falhou:', err?.message || err));
    } catch (err) {
      console.error('[userSyncService] não foi possível escutar os usuários do grupo:', err.message);
    }
  });
}

function parar() {
  geracao++;
  if (pararEscuta) { try { pararEscuta(); } catch { /* já parado */ } }
  pararEscuta = null;
}

module.exports = {
  iniciar, parar, sincronizarTudo, aoMudarLocalmente, mesclar,
  podeSincronizar, podeEntrarNoGrupo, docValido, normalizarNome, _definirBackendParaTeste,
};
