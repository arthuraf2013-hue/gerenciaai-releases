const { getDb } = require('../db/database');

/**
 * Espelho local de quais módulos pagos (Consulta remota, App do
 * garçom) estão ativos pro cliente desta instalação -- ver PARTE 1.5
 * de firestore.rules, que é onde a checagem de verdade acontece
 * (Firestore rejeita a escrita mesmo que este espelho esteja
 * desatualizado ou nunca tenha sincronizado). O propósito deste
 * arquivo é só dar uma resposta rápida e offline-friendly pro desktop
 * (pairingService.gerarCodigo) recusar NA HORA quando já sabe, com
 * certeza, que o módulo está desligado -- em vez de deixar o vendedor
 * tentar gerar um código, esperar a chamada de rede, e só então
 * descobrir que a regra do servidor recusou.
 *
 * Diferente de sync_state (grupoSincronizacaoId), que vem de graça
 * junto no documento da própria instalação, modulosAtivos mora num
 * documento SEPARADO (clientes/{clienteId}) -- por isso precisa da
 * própria escuta em tempo real, iniciada/reiniciada só quando o
 * clienteId muda (não a cada heartbeat de installations/{installId}).
 */

function getLocalState() {
  const db = getDb();
  let row = db.prepare('SELECT * FROM modulos_pagos_state WHERE id = ?').get('default');
  if (!row) {
    db.prepare(`INSERT INTO modulos_pagos_state (id) VALUES ('default')`).run();
    row = db.prepare('SELECT * FROM modulos_pagos_state WHERE id = ?').get('default');
  }
  return row;
}

function salvarEstado({ clienteId, consultaRemota, appGarcom, jaSincronizado }) {
  const db = getDb();
  getLocalState(); // garante que a linha 'default' existe antes do UPDATE
  db.prepare(
    `UPDATE modulos_pagos_state SET cliente_id = ?, consulta_remota = ?, app_garcom = ?, ja_sincronizado = ? WHERE id = ?`
  ).run(clienteId, consultaRemota ? 1 : 0, appGarcom ? 1 : 0, jaSincronizado ? 1 : 0, 'default');
}

let pararEscutaCliente = null;
let clienteIdComEscutaAtiva = null; // só controla a escuta em si (custosa); o branch sem cliente sempre roda de novo, é barato

/**
 * Chamado pelo listener em tempo real da própria instalação (já existe
 * em licenseService.aplicarDadosDoServidor) -- só extrai o clienteId
 * dali; modulosAtivos em si vem de uma escuta separada, iniciada aqui
 * mesmo. A escuta (onSnapshot, cara de recriar) só é reiniciada quando
 * o clienteId muda de verdade; o branch "sem cliente" sempre roda de
 * novo (é só uma escrita local barata) pra nunca depender de estado em
 * memória do processo pra decidir se o dado local está correto.
 */
function aplicarClienteIdDaInstalacao(dadosInstalacao) {
  const novoClienteId = dadosInstalacao.clienteId || null;

  if (!novoClienteId) {
    // Instalação ainda sem cliente vinculado (ou desvinculada) --
    // resposta CONFIRMADA do servidor: sem cliente, nenhum módulo pago
    // fica ativo (mesma conclusão a que a regra do Firestore chega).
    if (pararEscutaCliente) { pararEscutaCliente(); pararEscutaCliente = null; }
    clienteIdComEscutaAtiva = null;
    salvarEstado({ clienteId: null, consultaRemota: false, appGarcom: false, jaSincronizado: true });
    return;
  }

  if (novoClienteId === clienteIdComEscutaAtiva) return; // escuta certa já rodando, nada a fazer
  clienteIdComEscutaAtiva = novoClienteId;

  if (pararEscutaCliente) { pararEscutaCliente(); pararEscutaCliente = null; }

  try {
    const licenseService = require('./licenseService');
    const { doc, onSnapshot } = require('firebase/firestore');
    const firestore = licenseService.getLicenseFirestore();
    const ref = doc(firestore, 'clientes', novoClienteId);

    pararEscutaCliente = onSnapshot(
      ref,
      (snap) => {
        const modulos = (snap.exists() && snap.data().modulosAtivos) || {};
        salvarEstado({
          clienteId: novoClienteId,
          consultaRemota: modulos.consultaRemota === true,
          appGarcom: modulos.appGarcom === true,
          jaSincronizado: true,
        });
      },
      (err) => {
        // Falha de rede/permissão -- não mexe no que já estava salvo
        // (pode ser um dado antigo, mas ainda é melhor que "desconhecido
        // de novo"); a checagem de verdade continua sendo a regra do
        // Firestore, que roda em cima do dado fresco no servidor.
        console.error('[modulosPagosService] escuta de módulos do cliente falhou:', err);
      }
    );
  } catch (err) {
    console.error('[modulosPagosService] não foi possível iniciar a escuta de módulos pagos:', err);
  }
}

/**
 * Só dado local, sem rede -- usado por pairingService.gerarCodigo pra
 * recusar na hora. Enquanto este espelho nunca recebeu uma resposta
 * confirmada do servidor (ja_sincronizado = 0, ex: instalação nova
 * ainda offline), devolve `true` DE PROPÓSITO -- não é papel deste
 * cache bloquear alguém só por falta de dado local; quem bloqueia de
 * verdade, sempre, é a regra do Firestore (ver PARTE 1.5). Só depois
 * de confirmar com o servidor que o módulo está desligado é que este
 * cache antecipa a recusa.
 */
function moduloAtivo(modulo) {
  const state = getLocalState();
  if (!state.ja_sincronizado) return true;
  return modulo === 'appGarcom' ? state.app_garcom === 1 : state.consulta_remota === 1;
}

module.exports = { aplicarClienteIdDaInstalacao, moduloAtivo };
