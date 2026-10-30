const modulosPagosService = require('./modulosPagosService');

/**
 * Liberação dos módulos do ERP por licença (clientes/{id}.modulosAtivos na
 * Central, espelhado em modulos_pagos_state). Mesma regra dos outros
 * módulos pagos: enquanto a máquina nunca confirmou com o servidor, libera
 * (offline-first); confirmado desligado, recusa.
 *
 * Fase 1 = `erpCompras`: pedido de compra e entrada por XML de NF-e.
 * O custo médio NÃO é pago -- é a conta certa do custo pra todo mundo, e
 * já roda também no Abastecimento.
 */

const MSG_COMPRAS_INATIVO = 'O módulo ERP — Compras não está ativo para esta loja. Fale com o suporte da Vetta Sistemas para liberar.';

function status() {
  return { compras: modulosPagosService.moduloAtivo('erpCompras') };
}

/** null se pode seguir; senão o erro pronto pra devolver pelo IPC. */
function exigirCompras() {
  return modulosPagosService.moduloAtivo('erpCompras') ? null : { ok: false, error: MSG_COMPRAS_INATIVO, moduloInativo: true };
}

module.exports = { status, exigirCompras, MSG_COMPRAS_INATIVO };
