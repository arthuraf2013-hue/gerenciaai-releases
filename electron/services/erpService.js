const modulosPagosService = require('./modulosPagosService');

/**
 * Liberação dos módulos do ERP por licença (clientes/{id}.modulosAtivos na
 * Central, espelhado em modulos_pagos_state). Mesma regra dos outros
 * módulos pagos: enquanto a máquina nunca confirmou com o servidor, libera
 * (offline-first); confirmado desligado, recusa.
 *
 *  - erpCompras    pedido de compra e entrada por XML de NF-e (Fase 1)
 *  - erpFinanceiro contas a receber, recorrências, fluxo de caixa e DRE
 *  - erpEstoque    inventário (contagem) e movimentação por produto
 *  - erpFiscal     assistente fiscal: cadastro, limites, DAS, calendário,
 *                  relatório do MEI e pacote do contador
 *
 * O custo médio e o custo na hora da venda NÃO são pagos -- são a conta
 * certa pra todo mundo.
 */

const NOMES = {
  erpCompras: 'ERP — Compras',
  erpFinanceiro: 'ERP — Financeiro',
  erpEstoque: 'ERP — Estoque',
  erpFiscal: 'ERP — Fiscal',
};

function mensagem(modulo) {
  return `O módulo ${NOMES[modulo]} não está ativo para esta loja. Fale com o suporte da Vetta Sistemas para liberar.`;
}
const MSG_COMPRAS_INATIVO = mensagem('erpCompras');

/** Módulos liberados pela licença e, com usuário, o que ELE pode abrir
 * (permissaoService). A tela usa os dois para mostrar o aviso certo. */
function status(usuarioId) {
  const r = {
    compras: modulosPagosService.moduloAtivo('erpCompras'),
    financeiro: modulosPagosService.moduloAtivo('erpFinanceiro'),
    estoque: modulosPagosService.moduloAtivo('erpEstoque'),
    fiscal: modulosPagosService.moduloAtivo('erpFiscal'),
  };
  if (usuarioId) {
    const permissaoService = require('./permissaoService');
    r.permissoes = {
      compras: permissaoService.temPermissao(usuarioId, 'erp.compras'),
      financeiro: permissaoService.temPermissao(usuarioId, 'erp.financeiro'),
      estoque: permissaoService.temPermissao(usuarioId, 'erp.estoque'),
      fiscal: permissaoService.temPermissao(usuarioId, 'erp.fiscal'),
    };
  }
  return r;
}

/** null se pode seguir; senão o erro pronto pra devolver pelo IPC. */
function exigir(modulo) {
  if (!NOMES[modulo]) throw new Error(`Módulo desconhecido: ${modulo}`);
  return modulosPagosService.moduloAtivo(modulo) ? null : { ok: false, error: mensagem(modulo), moduloInativo: true };
}

const exigirCompras = () => exigir('erpCompras');

module.exports = { status, exigir, exigirCompras, MSG_COMPRAS_INATIVO, NOMES };
