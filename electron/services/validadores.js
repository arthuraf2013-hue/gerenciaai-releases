/**
 * Validação de documentos (dígitos verificadores), com mensagens que dizem
 * o que fazer. Puro e testável -- sem banco.
 *
 * CNPJ: aceita o formato numérico e o ALFANUMÉRICO (IN RFB 2.229/2024, em
 * vigor a partir de julho/2026): 12 primeiros caracteres 0-9/A-Z, 2 dígitos
 * verificadores numéricos; cada caractere vale (código ASCII − 48).
 * IE: algoritmo de PE e SP (os mais usados pelos clientes do app) e
 * formato (só dígitos, 2 a 14) nas demais UFs, além de "ISENTO".
 */

const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');

function cpfValido(valor) {
  const c = soDigitos(valor);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i += 1) soma += Number(c[i]) * (t + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(c[t])) return false;
  }
  return true;
}

/** Normaliza CNPJ: tira pontuação e passa letras para maiúsculas. */
function normalizarCnpj(valor) {
  return String(valor ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function cnpjValido(valor) {
  const c = normalizarCnpj(valor);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c)) return false;
  if (/^(\d)\1{13}$/.test(c)) return false;
  const v = (ch) => ch.charCodeAt(0) - 48;
  const dv = (base) => {
    const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = [...base].reduce((s, ch, i) => s + v(ch) * pesos[i], 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(c.slice(0, 12));
  const d2 = dv(c.slice(0, 12) + d1);
  return d1 === Number(c[12]) && d2 === Number(c[13]);
}

function iePE(ie) {
  // e-Fisco: 9 dígitos, dois DVs módulo 11 (pesos 8..2 e 9..2).
  if (ie.length !== 9) return false;
  const dv = (base, pesoInicial) => {
    const soma = [...base].reduce((s, d, i) => s + Number(d) * (pesoInicial - i), 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(ie.slice(0, 7), 8);
  const d2 = dv(ie.slice(0, 7) + d1, 9);
  return d1 === Number(ie[7]) && d2 === Number(ie[8]);
}

function ieSP(ie) {
  // Comércio/indústria: 12 dígitos; 9º e 12º são DVs.
  if (ie.length !== 12) return false;
  const p1 = [1, 3, 4, 5, 6, 7, 8, 10];
  const d1 = ([...ie.slice(0, 8)].reduce((s, d, i) => s + Number(d) * p1[i], 0) % 11) % 10;
  if (d1 !== Number(ie[8])) return false;
  const p2 = [3, 2, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  const d2 = ([...ie.slice(0, 11)].reduce((s, d, i) => s + Number(d) * p2[i], 0) % 11) % 10;
  return d2 === Number(ie[11]);
}

/** IE válida para a UF? `null`/vazio é tratado por quem chama (campo opcional). */
function ieValida(valor, uf) {
  const bruto = String(valor ?? '').trim().toUpperCase();
  if (bruto === 'ISENTO') return true;
  const ie = soDigitos(bruto);
  if (!ie || /^0+$/.test(ie)) return false;
  switch (String(uf || '').toUpperCase()) {
    case 'PE': return iePE(ie);
    case 'SP': return ieSP(ie);
    default: return ie.length >= 2 && ie.length <= 14;
  }
}

/** Valida um documento de cliente/fornecedor (CPF ou CNPJ) informado num único campo. */
function documentoValido(valor) {
  const n = normalizarCnpj(valor);
  if (/^\d{11}$/.test(n)) return cpfValido(n);
  return cnpjValido(n);
}

/** Erro pronto ({ ok:false, error }) ou null, para os cadastros. Campos vazios passam. */
function conferirDocumentos({ cpf, cnpj, cpfCnpj, ie, uf } = {}) {
  if (cpf && !cpfValido(cpf)) return { ok: false, error: 'CPF inválido: confira os números (os dois últimos são dígitos verificadores).' };
  if (cnpj && !cnpjValido(cnpj)) return { ok: false, error: 'CNPJ inválido: confira os números e letras (os dois últimos são dígitos verificadores).' };
  if (cpfCnpj && !documentoValido(cpfCnpj)) return { ok: false, error: 'CPF/CNPJ inválido: confira os números (os últimos são dígitos verificadores).' };
  if (ie && !ieValida(ie, uf)) return { ok: false, error: `Inscrição estadual inválida${uf ? ` para ${String(uf).toUpperCase()}` : ''}. Sem inscrição, escreva ISENTO.` };
  return null;
}

module.exports = { soDigitos, cpfValido, cnpjValido, normalizarCnpj, ieValida, documentoValido, conferirDocumentos };
