// Estado local do celular (localStorage) -- só o que evita ter que
// digitar o código de novo ou consultar o Firestore antes de saber que
// tela mostrar. A lista "de verdade" de lojas paradas continua sendo
// dispositivos_pareados/{uid} no Firestore (ver pairing.js) -- isto aqui
// é só um espelho rápido/offline dela.

const CHAVE_LOJAS = 'gerenciaai_lojas_pareadas';
const CHAVE_LOJA_ATIVA = 'gerenciaai_loja_ativa_id';

/** Cada loja: { installId, nomeNegocio, tipo ('garcom'|'consulta'),
 * vinculoUserId, vinculoNome, deviceUid } */
function listarLojas() {
  try {
    const bruto = localStorage.getItem(CHAVE_LOJAS);
    return bruto ? JSON.parse(bruto) : [];
  } catch {
    return [];
  }
}

function salvarLojas(lojas) {
  localStorage.setItem(CHAVE_LOJAS, JSON.stringify(lojas));
}

/** Adiciona (ou atualiza, se já pareado com essa mesma loja antes --
 * ex: o código foi gerado de novo pro mesmo vínculo) uma loja à lista
 * local, e a torna a loja ativa. */
function adicionarOuAtualizarLoja(loja) {
  const lojas = listarLojas().filter((l) => l.installId !== loja.installId);
  lojas.push(loja);
  salvarLojas(lojas);
  definirLojaAtiva(loja.installId);
}

function removerLoja(installId) {
  const lojas = listarLojas().filter((l) => l.installId !== installId);
  salvarLojas(lojas);
  if (getLojaAtivaId() === installId) {
    localStorage.removeItem(CHAVE_LOJA_ATIVA);
    if (lojas.length) definirLojaAtiva(lojas[0].installId);
  }
}

function definirLojaAtiva(installId) {
  localStorage.setItem(CHAVE_LOJA_ATIVA, installId);
}

function getLojaAtivaId() {
  return localStorage.getItem(CHAVE_LOJA_ATIVA);
}

function getLojaAtiva() {
  const id = getLojaAtivaId();
  if (!id) return null;
  return listarLojas().find((l) => l.installId === id) || null;
}

export { listarLojas, adicionarOuAtualizarLoja, removerLoja, definirLojaAtiva, getLojaAtivaId, getLojaAtiva };
