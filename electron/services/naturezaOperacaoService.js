const { getDb } = require('../db/database');

/**
 * Natureza da operação → CFOP (e finalidade da nota). O lojista escolhe
 * "o que está fazendo" (vender, devolver ao fornecedor, mandar para
 * conserto...) e o sistema devolve o CFOP certo pela UF de destino e por
 * a mercadoria ter ou não ICMS-ST já retido. Tabela semeada pela migração
 * versionada 1 (db/migracoes.js); fonte e regras em docs/ERP-FISCAL-RULES.md §2.
 *
 * Só sugere: a nota ainda passa pelo motor tributário e o contador valida.
 */

const UFS = new Set(['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI',
  'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']);

function listar() {
  try {
    return getDb().prepare('SELECT * FROM natureza_operacao ORDER BY tipo DESC, nome').all();
  } catch (err) {
    if (/no such table/i.test(err.message || '')) return [];
    throw err;
  }
}

/**
 * CFOP da operação.
 * @param {{ codigo: string, ufEmitente: string, ufDestino?: string, comSt?: boolean, regime?: string }} p
 * @returns {{ ok: true, cfop: string, finalidade: number, interestadual: boolean, csosnSugerido: string|null, aviso: string|null } | { ok: false, error: string }}
 */
function cfopPara({ codigo, ufEmitente, ufDestino, comSt = false, regime = null } = {}) {
  const n = listar().find((x) => x.codigo === codigo);
  if (!n) return { ok: false, error: 'Escolha a natureza da operação.' };
  const origem = String(ufEmitente || '').toUpperCase();
  const destino = String(ufDestino || origem).toUpperCase();
  if (!UFS.has(origem)) return { ok: false, error: 'Configure a UF da empresa em Configurações → Fiscal.' };
  if (!UFS.has(destino)) return { ok: false, error: 'UF de destino inválida.' };
  const interestadual = origem !== destino;
  const campo = `cfop_${interestadual ? 'interestadual' : 'interno'}${comSt ? '_st' : ''}`;
  let cfop = n[campo];
  let aviso = null;
  if (!cfop && comSt) {
    // Operação sem par "com ST" (ex.: remessa para conserto): o CFOP é o mesmo.
    cfop = n[`cfop_${interestadual ? 'interestadual' : 'interno'}`];
  }
  if (!cfop) {
    return { ok: false, error: interestadual ? 'Esta operação não existe para outro estado.' : 'Esta operação só existe para outro estado (ex.: venda a não contribuinte de outra UF).' };
  }
  // CSOSN só para venda no Simples/MEI, onde a regra é pacífica (102 sem ST, 500 com ST).
  let csosnSugerido = null;
  if ((regime === 'simples_nacional' || regime === 'mei') && codigo.startsWith('venda_')) csosnSugerido = comSt ? '500' : '102';
  if (n.finalidade === 4) aviso = 'Nota de devolução: informe a chave da nota original (referência) na emissão.';
  return { ok: true, cfop, finalidade: n.finalidade, interestadual, csosnSugerido, aviso, natureza: n.nome };
}

module.exports = { listar, cfopPara, UFS };
