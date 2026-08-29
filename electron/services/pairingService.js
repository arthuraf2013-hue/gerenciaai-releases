const { randomUUID, randomInt } = require('crypto');
const { getDb } = require('../db/database');
const timeService = require('./timeService');

const DURACAO_CODIGO_MINUTOS = 10;

/**
 * Pareamento de celular (PWA do garçom ou consulta remota Adm/Gerente)
 * com esta instalação — self-service, sem depender do suporte, ao
 * contrário da sincronização entre PDVs (essa continua sendo
 * configurada manualmente, ver SettingsScreen). O celular troca um
 * código curto (6 dígitos, expira em 10 minutos, uso único) por um
 * vínculo permanente.
 *
 * Duas coleções no MESMO Firestore de licenciamento (o app só tem um
 * projeto Firebase, compartilhado por todos os clientes — ver
 * licenseService.js):
 *   installations/{installId}/pareamentos/{codigo} — o código em si,
 *     consumido pelo celular (que não tem acesso a este SQLite).
 *   installations/{installId}/dispositivos/{uid} — o vínculo definitivo
 *     depois de trocado, onde {uid} é o uid da autenticação anônima do
 *     Firebase gerado no primeiro uso do celular.
 *
 * Este arquivo cobre só o lado do DESKTOP: gerar o código, espelhar
 * localmente os dispositivos já pareados (pra listar/revogar em
 * Configurações sem depender de rede toda vez que a tela abre), e
 * revogar. A troca do código em si (criar o vínculo) acontece no
 * código do PWA (fora deste repositório Electron).
 */

function gerarCodigoNumerico() {
  return String(randomInt(100000, 1000000));
}

function requireGerenteOuAdmin(requestingUserId) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND ativo = 1').get(requestingUserId);
  if (!user || !['gerente', 'admin', 'suporte'].includes(user.role)) {
    return { ok: false, error: 'Apenas um gerente ou administrador pode gerenciar pareamento de dispositivos.' };
  }
  return { ok: true };
}

/**
 * Gera um código de pareamento novo. `tipo` decide quem pode ser o
 * vínculo: 'garcom' só aceita um usuário com papel garcom; 'consulta'
 * só aceita gerente/admin (é a própria pessoa que vai consultar do
 * celular, não um funcionário à parte).
 */
async function gerarCodigo({ tipo, vinculoUserId, requestingUserId }) {
  const guard = requireGerenteOuAdmin(requestingUserId);
  if (!guard.ok) return guard;

  if (!['garcom', 'consulta'].includes(tipo)) return { ok: false, error: 'Tipo de pareamento inválido.' };

  const db = getDb();
  const vinculo = db.prepare('SELECT * FROM users WHERE id = ? AND ativo = 1').get(vinculoUserId);
  if (!vinculo) return { ok: false, error: 'Usuário do vínculo não encontrado.' };
  if (tipo === 'garcom' && vinculo.role !== 'garcom') {
    return { ok: false, error: 'Um código do tipo "garçom" só pode ser vinculado a um usuário com papel Garçom.' };
  }
  if (tipo === 'consulta' && !['gerente', 'admin', 'suporte'].includes(vinculo.role)) {
    return { ok: false, error: 'Um código de consulta remota só pode ser vinculado a um Gerente ou Administrador.' };
  }

  // Consulta remota e App do garçom são módulos pagos à parte (ver
  // PARTE 1.5 de firestore.rules, onde a checagem de verdade acontece)
  // -- este é só o atalho local: quando já SABEMOS (confirmado com o
  // servidor) que o módulo do cliente está desligado, recusa na hora,
  // sem nem tentar a chamada de rede. Se o espelho local ainda não
  // sincronizou, deixa passar e a regra do Firestore decide (ver
  // modulosPagosService.moduloAtivo).
  const modulo = tipo === 'garcom' ? 'appGarcom' : 'consultaRemota';
  if (!require('./modulosPagosService').moduloAtivo(modulo)) {
    const nomeModulo = tipo === 'garcom' ? 'App do garçom' : 'Consulta remota';
    return { ok: false, error: `O módulo "${nomeModulo}" não está ativo pra este cliente. Fale com o suporte pra contratar.` };
  }

  // Firestore precisa estar acessível pra publicar o código (é ele quem
  // o celular de fato lê) — sem tentar gerar um código "só local" que
  // nunca vai funcionar do outro lado.
  let firestore;
  let installId;
  try {
    const licenseService = require('./licenseService');
    const pdvRegistryService = require('./pdvRegistryService');
    firestore = licenseService.getLicenseFirestore();
    installId = pdvRegistryService.getOrCreateDeviceUid();
  } catch (err) {
    return { ok: false, error: 'Não foi possível preparar o pareamento agora — confira a conexão com a internet.' };
  }

  const codigo = gerarCodigoNumerico();
  const criadoEmMs = Date.now();
  const expiraEmMs = criadoEmMs + DURACAO_CODIGO_MINUTOS * 60 * 1000;
  // Formato "YYYY-MM-DD HH:MM:SS" (mesmo de NOW_SYNCED()/nowSyncedUTCString,
  // ver timeService.js) -- NUNCA `.toISOString()` puro aqui: essa coluna é
  // TEXT e o SQLite compara `>`/`<` byte a byte, não como data de verdade.
  // ISO com "T"/"Z" (ex: "2026-08-29T07:40:21.000Z") sempre soa "maior"
  // que "2026-08-29 07:44:19" (formato do NOW_SYNCED()) na mesma data, só
  // pelo caractere "T" > " " -- o código nunca expirava de verdade na
  // consulta de listarCodigosPendentes enquanto fosse o mesmo dia UTC.
  const expiraEmSql = new Date(expiraEmMs).toISOString().slice(0, 19).replace('T', ' ');

  db.prepare(
    `INSERT INTO pairing_codes (id, tipo, vinculo_user_id, criado_por_id, expira_em) VALUES (?, ?, ?, ?, ?)`
  ).run(codigo, tipo, vinculoUserId, requestingUserId, expiraEmSql);

  try {
    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
    const fiscalService = require('./fiscalService');
    const ref = doc(firestore, 'installations', installId, 'pareamentos', codigo);
    await setDoc(ref, {
      codigo, // duplicado do id do doc de propósito -- permite ao celular
              // achar o código por collectionGroup('pareamentos').where('codigo', '==', ...)
              // sem precisar saber o installId de antemão (fluxo "digitar o código").
      tipo,
      installId,
      vinculoUserId,
      nomeNegocio: fiscalService.getNomeNegocio() || 'Sua loja',
      vinculoNome: vinculo.nome,
      usado: false,
      criadoEm: serverTimestamp(),
      // Timestamp de verdade (não string ISO) -- as regras do Firestore
      // comparam isso direto contra `request.time` na hora de redimir.
      expiraEm: new Date(expiraEmMs),
    });
  } catch (err) {
    // Publicar falhou -- desfaz o registro local pra não deixar um
    // código "fantasma" que nunca vai funcionar aparecendo como pendente.
    db.prepare('DELETE FROM pairing_codes WHERE id = ?').run(codigo);
    return { ok: false, error: 'Não foi possível publicar o código agora — confira a conexão com a internet e tente de novo.' };
  }

  return { ok: true, codigo, expiraEm: expiraEmSql, tipo, vinculoNome: vinculo.nome };
}

/** Códigos gerados por esta instalação ainda dentro da validade e não
 * usados -- pra tela de Configurações mostrar "aguardando o celular".
 * Usa NOW_SYNCED() (não `datetime('now')` puro) pra comparar contra o
 * mesmo relógio sincronizado que o resto do app usa, não o horário cru
 * do sistema operacional -- mesma convenção documentada em
 * timeService.js. */
function listarCodigosPendentes() {
  const db = getDb();
  // substr(replace(...), 1, 19) normaliza expira_em antes de comparar --
  // cobre tanto o formato certo de hoje ("YYYY-MM-DD HH:MM:SS", 19
  // caracteres, replace vira no-op) quanto códigos ANTIGOS gravados
  // antes da correção do bug do "T"/"Z" (formato ISO puro, tipo
  // "2026-08-29T07:40:21.000Z"): troca o "T" por espaço e corta os
  // milissegundos/"Z", virando o mesmo formato de 19 caracteres. Sem
  // isso, um código antigo no formato errado nunca comparava como
  // "menor" que NOW_SYNCED() no mesmo dia UTC e ficava pendente pra
  // sempre na tela, mesmo já tendo expirado de verdade há muito tempo.
  return db.prepare(
    `SELECT pc.*, u.nome as vinculo_nome FROM pairing_codes pc
     JOIN users u ON u.id = pc.vinculo_user_id
     WHERE pc.usado = 0 AND substr(replace(pc.expira_em, 'T', ' '), 1, 19) > NOW_SYNCED()
     ORDER BY pc.criado_em DESC`
  ).all();
}

/** Marca um código como usado no espelho local -- chamado pela escuta
 * em tempo real (iniciarEscutaPareamentos) quando o Firestore confirma
 * que o celular trocou o código por um vínculo de verdade. */
function marcarCodigoComoUsado(codigo) {
  const db = getDb();
  db.prepare(`UPDATE pairing_codes SET usado = 1, usado_em = NOW_SYNCED() WHERE id = ?`).run(codigo);
}

/** Dispositivos (celulares) já pareados com esta instalação -- pra
 * listar/revogar em Configurações. */
function listarDispositivosPareados() {
  const db = getDb();
  return db.prepare(
    `SELECT pd.*, u.nome as vinculo_nome FROM paired_devices pd
     JOIN users u ON u.id = pd.vinculo_user_id
     ORDER BY pd.ativo DESC, pd.criado_em DESC`
  ).all();
}

/** Upsert local do que a escuta em tempo real recebeu do Firestore --
 * nunca cria vínculo NOVO por conta própria (isso só acontece do lado
 * do celular, que sabe o código); aqui só espelha o que já foi criado. */
function espelharDispositivoPareado({ uid, tipo, vinculoUserId, nomeDispositivo, ativo }) {
  const db = getDb();
  const usuarioExiste = db.prepare('SELECT id FROM users WHERE id = ?').get(vinculoUserId);
  if (!usuarioExiste) return; // vínculo apontando pra usuário que não existe mais aqui -- ignora

  const existente = db.prepare('SELECT id FROM paired_devices WHERE id = ?').get(uid);
  if (existente) {
    db.prepare(
      `UPDATE paired_devices SET tipo = ?, vinculo_user_id = ?, nome_dispositivo = ?, ativo = ?, ultimo_acesso = NOW_SYNCED() WHERE id = ?`
    ).run(tipo, vinculoUserId, nomeDispositivo || null, ativo ? 1 : 0, uid);
  } else {
    db.prepare(
      `INSERT INTO paired_devices (id, tipo, vinculo_user_id, nome_dispositivo, ativo) VALUES (?, ?, ?, ?, ?)`
    ).run(uid, tipo, vinculoUserId, nomeDispositivo || null, ativo ? 1 : 0);
  }
}

/**
 * Revoga o acesso de um dispositivo já pareado -- o celular deixa de
 * conseguir ler/escrever assim que notar (regras do Firestore conferem
 * `ativo` antes de liberar qualquer coisa). Nunca apaga o registro
 * (mantém o histórico de quem já usou o quê).
 */
/** Espelha localmente e tenta propagar pro Firestore a troca de `ativo`
 * de um dispositivo -- mesma escrita usada tanto por revogar (desconectar)
 * quanto por reativar (reconectar), só o valor booleano muda. Local
 * sempre aplica na hora; se a propagação falhar por rede, o celular só
 * vai perceber um pouco mais tarde (na próxima reconciliação) -- não é
 * crítico o bastante pra bloquear a ação local. */
async function alterarAtivoDispositivo(deviceId, ativo) {
  const db = getDb();
  db.prepare('UPDATE paired_devices SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, deviceId);

  try {
    const licenseService = require('./licenseService');
    const pdvRegistryService = require('./pdvRegistryService');
    const { doc, setDoc } = require('firebase/firestore');
    const firestore = licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();
    await setDoc(doc(firestore, 'installations', installId, 'dispositivos', deviceId), { ativo }, { merge: true });
  } catch (err) {
    console.error(`[pairingService] falha ao propagar ${ativo ? 'reativação' : 'revogação'} pro Firestore:`, err.message);
  }
}

async function revogarDispositivo({ deviceId, requestingUserId }) {
  const guard = requireGerenteOuAdmin(requestingUserId);
  if (!guard.ok) return guard;

  const db = getDb();
  const dispositivo = db.prepare('SELECT * FROM paired_devices WHERE id = ?').get(deviceId);
  if (!dispositivo) return { ok: false, error: 'Dispositivo não encontrado.' };

  await alterarAtivoDispositivo(deviceId, false);
  return { ok: true };
}

/**
 * Reconecta um dispositivo revogado anteriormente -- sem precisar gerar
 * código novo nem o celular digitar nada, já que o vínculo (tipo +
 * usuário) continua o mesmo, só o acesso tinha sido cortado. As regras
 * do Firestore já permitem essa via de mão dupla (o desktop, sem
 * autenticação, só pode tocar no campo `ativo` de um dispositivo, pra
 * qualquer um dos dois valores -- ver firestore.rules).
 */
async function reativarDispositivo({ deviceId, requestingUserId }) {
  const guard = requireGerenteOuAdmin(requestingUserId);
  if (!guard.ok) return guard;

  const db = getDb();
  const dispositivo = db.prepare('SELECT * FROM paired_devices WHERE id = ?').get(deviceId);
  if (!dispositivo) return { ok: false, error: 'Dispositivo não encontrado.' };

  await alterarAtivoDispositivo(deviceId, true);
  return { ok: true };
}

let pararEscutaPareamentos = null;
let pararEscutaDispositivos = null;

/**
 * Escuta em tempo real os pareamentos e dispositivos desta instalação
 * — reflete no SQLite local assim que o celular troca um código (o
 * código pendente vira "usado" e um dispositivo novo aparece na
 * lista), sem precisar que alguém reabra a tela de Configurações pra
 * ver o resultado. Chamado uma vez no início do app (main.js), mesmo
 * padrão de productSyncService.iniciarEscutaProdutos.
 */
function iniciarEscutaPareamentos() {
  try {
    if (pararEscutaPareamentos) { pararEscutaPareamentos(); pararEscutaPareamentos = null; }
    if (pararEscutaDispositivos) { pararEscutaDispositivos(); pararEscutaDispositivos = null; }

    const licenseService = require('./licenseService');
    const pdvRegistryService = require('./pdvRegistryService');
    const { collection, onSnapshot } = require('firebase/firestore');
    const firestore = licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();

    pararEscutaPareamentos = onSnapshot(
      collection(firestore, 'installations', installId, 'pareamentos'),
      (snap) => {
        snap.docChanges().forEach((change) => {
          const dados = change.doc.data();
          if (dados.usado === true) marcarCodigoComoUsado(change.doc.id);
        });
      },
      (err) => console.error('[pairingService] escuta de pareamentos falhou:', err)
    );

    pararEscutaDispositivos = onSnapshot(
      collection(firestore, 'installations', installId, 'dispositivos'),
      (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'removed') return;
          const dados = change.doc.data();
          espelharDispositivoPareado({
            uid: change.doc.id,
            tipo: dados.tipo,
            vinculoUserId: dados.vinculoUserId,
            nomeDispositivo: dados.nomeDispositivo,
            ativo: dados.ativo !== false,
          });
        });
      },
      (err) => console.error('[pairingService] escuta de dispositivos pareados falhou:', err)
    );
  } catch (err) {
    console.error('[pairingService] não foi possível iniciar a escuta de pareamentos:', err);
  }
}

module.exports = {
  gerarCodigo, listarCodigosPendentes, listarDispositivosPareados, revogarDispositivo,
  reativarDispositivo,
  iniciarEscutaPareamentos,
  // Exportados só pra teste (a parte que não depende de rede).
  marcarCodigoComoUsado, espelharDispositivoPareado,
};
