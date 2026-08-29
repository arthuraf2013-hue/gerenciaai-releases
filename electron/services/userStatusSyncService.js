const { getDb } = require('../db/database');

// Lista de funcionários muda pouco (criar/desativar usuário é raro perto
// de vendas/pedidos) -- intervalo bem mais longo que o de
// liveStatusSyncService (25s) pra não gastar escrita/rede à toa com um
// dado que quase nunca muda entre uma publicação e outra.
const INTERVALO_PUBLICACAO_MS = 60 * 1000;

/**
 * Retrato dos funcionários pra consulta remota (celular pareado como
 * "Consulta remota" -- ver firestore.rules, match
 * installations/{installId}/gestao_usuarios/{docId}). Só os campos que
 * já aparecem na tela Usuários do desktop (nome/papel/status) -- NUNCA
 * pin_hash, pin_temporario, tentativas_falhas nem bloqueado_ate, que são
 * dados de segurança da própria conta e não tem por que sair do SQLite
 * local (ver comentário equivalente em electron/db/schema.sql sobre
 * pin_hash nunca ir pro renderer -- aqui a barra é ainda mais alta,
 * porque isto sai do próprio computador).
 *
 * Traz TODOS os usuários (ativos e inativos) -- a tela de Usuários do
 * desktop também mostra os dois com um selo de status, e "quem está
 * desativado" é justamente parte do controle que quem pediu essa
 * funcionalidade quer enxergar remotamente.
 */
function getUsuariosParaConsulta() {
  const db = getDb();
  return db.prepare(
    `SELECT id, nome, role, ativo FROM users ORDER BY nome`
  ).all().map((u) => ({
    id: u.id, nome: u.nome, role: u.role, ativo: !!u.ativo,
  }));
}

/**
 * Publica o retrato dos funcionários pro Firestore, num documento
 * separado de status_ao_vivo/atual DE PROPÓSITO: a regra de
 * status_ao_vivo autoriza QUALQUER dispositivo pareado e ativo (garçom
 * OU consulta) a ler, porque o garçom precisa do catalogoProdutos de lá
 * pra montar pedido -- mas a lista de funcionários (nome, papel de
 * cada um) não deveria vazar pra um celular pareado como garçom, que
 * hoje nunca teve visibilidade nenhuma sobre outros usuários (nem no
 * desktop: o menu "Usuários" nem aparece pra role 'garcom' —
 * ver AppShell.jsx). Por isso um documento com regra própria
 * (gestao_usuarios/atual), restrita a dispositivo tipo === 'consulta'
 * -- ver firestore.rules.
 *
 * best-effort igual liveStatusSyncService: falha de rede aqui nunca
 * pode virar erro na tela do PDV, só um dado remoto levemente
 * desatualizado até a próxima publicação.
 */
async function publicarUsuarios() {
  try {
    const usuarios = getUsuariosParaConsulta();

    const licenseService = require('./licenseService');
    const pdvRegistryService = require('./pdvRegistryService');
    const firestore = licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();

    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
    await setDoc(doc(firestore, 'installations', installId, 'gestao_usuarios', 'atual'), {
      usuarios,
      atualizadoEm: serverTimestamp(),
    });
  } catch (err) {
    // Rede fora, Firestore indisponível, ou nenhum dispositivo pareado
    // ainda -- best-effort, sem alarde (mesmo critério de
    // liveStatusSyncService.publicarStatusAoVivo).
  }
}

let intervalo = null;

function iniciarPublicacaoContinua() {
  if (intervalo) clearInterval(intervalo);
  publicarUsuarios();
  intervalo = setInterval(publicarUsuarios, INTERVALO_PUBLICACAO_MS);
}

module.exports = { publicarUsuarios, iniciarPublicacaoContinua, getUsuariosParaConsulta };
