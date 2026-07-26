const { getDb } = require('../db/database');

function getPaymentConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM payment_config WHERE id = ?').get('default');
}

function updatePaymentConfig(payload) {
  const db = getDb();
  const current = getPaymentConfig();
  db.prepare(
    `UPDATE payment_config SET pix_chave = ?, pix_tipo_chave = ?, pix_nome_recebedor = ?, pix_cidade = ? WHERE id = 'default'`
  ).run(
    payload.pixChave ?? current.pix_chave,
    payload.pixTipoChave ?? current.pix_tipo_chave,
    payload.pixNomeRecebedor ?? current.pix_nome_recebedor,
    payload.pixCidade ?? current.pix_cidade
  );
  return { ok: true };
}

// Campo TLV (Tag-Length-Value) do padrão EMV usado pelo BR Code do Pix.
function tlv(id, value) {
  const len = String(value.length).padStart(2, '0');
  return `${id}${len}${value}`;
}

// Remove acentos e caracteres fora do padrão aceito pelo BR Code (o Pix
// exige texto simples, sem acentuação, em maiúsculas para nome/cidade).
function sanitize(text, maxLength) {
  const normalized = (text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-zA-Z0-9 ]/g, '') // só letras/números/espaço
    .toUpperCase()
    .trim();
  return normalized.slice(0, maxLength) || 'NAO INFORMADO';
}

// CRC16-CCITT (polinômio 0x1021, valor inicial 0xFFFF) — exigido como
// último campo do payload, calculado sobre a própria string (com "6304"
// já anexado no lugar do checksum final).
function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Monta o payload Pix "Copia e Cola" (BR Code) com valor fixo — qualquer
 * app de banco consegue ler isso via QR Code ou colar o texto direto.
 * Não há confirmação automática de recebimento: o operador confere no
 * próprio aplicativo do banco e confirma manualmente na tela de venda.
 */
function buildPixPayload({ valor, txid }) {
  const config = getPaymentConfig();
  if (!config.pix_chave) {
    return { ok: false, error: 'Nenhuma chave Pix configurada. Cadastre em Configurações → Pagamento (Pix).' };
  }

  const nome = sanitize(config.pix_nome_recebedor, 25);
  const cidade = sanitize(config.pix_cidade, 15);
  const referencia = (txid || '***').replace(/[^a-zA-Z0-9]/g, '').slice(0, 25) || '***';
  const valorFormatado = Number(valor).toFixed(2);

  const merchantAccountInfo = tlv('00', 'br.gov.bcb.pix') + tlv('01', config.pix_chave);
  const additionalData = tlv('05', referencia);

  let payload = ''
    + tlv('00', '01')
    + tlv('26', merchantAccountInfo)
    + tlv('52', '0000')
    + tlv('53', '986')
    + tlv('54', valorFormatado)
    + tlv('58', 'BR')
    + tlv('59', nome)
    + tlv('60', cidade)
    + tlv('62', additionalData)
    + '6304';

  const checksum = crc16(payload);
  return { ok: true, payload: payload + checksum, valor: Number(valorFormatado) };
}

module.exports = { getPaymentConfig, updatePaymentConfig, buildPixPayload };
