const { getDb } = require('../db/database');

/**
 * Formatos de etiqueta de peso variável documentados pelos fabricantes
 * brasileiros (baseado no manual técnico da Urano, que também cobrem
 * variações usadas por Toledo/Filizola). Não existe "o" formato único —
 * cada balança é configurada pelo lojista/técnico com um desses.
 */
const FORMATOS = {
  peso_cod6: { prefixo: '2', codigoIni: 1, codigoLen: 6, valorIni: 7, valorLen: 5, label: 'Prefixo 2 + código (6 dígitos) + valor (5 dígitos) — "Cod6"' },
  peso_cod5b: { prefixo: '2', codigoIni: 1, codigoLen: 5, valorIni: 7, valorLen: 5, label: 'Prefixo 2 + código (5 dígitos) + zero + valor (5 dígitos) — "Cod5B"' },
  peso_prefixo20: { prefixo: '20', codigoIni: 2, codigoLen: 4, valorIni: 6, valorLen: 6, label: 'Prefixo 20 + código (4 dígitos) + valor (6 dígitos)' },
};

function calcularDigitoVerificador(doze_digitos) {
  let somaImpar = 0;
  let somaPar = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(doze_digitos[i]);
    if (i % 2 === 0) somaImpar += d;
    else somaPar += d;
  }
  const total = somaImpar + somaPar * 3;
  return (10 - (total % 10)) % 10;
}

function getConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM scale_barcode_config WHERE id = ?').get('default');
}

function updateConfig({ formato, campo }) {
  if (formato && !FORMATOS[formato]) return { ok: false, error: 'Formato desconhecido.' };
  if (campo && !['peso', 'preco_total'].includes(campo)) return { ok: false, error: 'Campo inválido.' };
  const db = getDb();
  const current = getConfig();
  db.prepare('UPDATE scale_barcode_config SET formato = ?, campo = ? WHERE id = ?').run(
    formato || current.formato, campo || current.campo, 'default'
  );
  return { ok: true };
}

/**
 * Tenta interpretar um código de barras escaneado como uma etiqueta de
 * peso variável, usando o formato configurado. Devolve null se não
 * bater com o padrão (nesse caso, quem chamou trata como código de
 * barras normal) — nunca lança erro pra não travar o fluxo de venda.
 */
function parseWeightBarcode(barcode) {
  if (!barcode || barcode.length !== 13 || !/^\d{13}$/.test(barcode)) return null;

  const config = getConfig();
  const formato = FORMATOS[config.formato];
  if (!formato) return null;

  if (!barcode.startsWith(formato.prefixo)) return null;

  const doze = barcode.slice(0, 12);
  const digitoInformado = Number(barcode[12]);
  const digitoCalculado = calcularDigitoVerificador(doze);
  if (digitoInformado !== digitoCalculado) return null;

  const codigoBalanca = barcode.slice(formato.codigoIni, formato.codigoIni + formato.codigoLen);
  const valorBruto = Number(barcode.slice(formato.valorIni, formato.valorIni + formato.valorLen));

  if (config.campo === 'peso') {
    return { codigoBalanca, pesoKg: valorBruto / 1000, precoTotal: null };
  }
  return { codigoBalanca, pesoKg: null, precoTotal: valorBruto / 100 };
}

module.exports = { FORMATOS, getConfig, updateConfig, parseWeightBarcode, calcularDigitoVerificador };
