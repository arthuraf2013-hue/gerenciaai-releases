// Pix "copia e cola" (BR Code estático com valor) -- portado de
// electron/services/pixService.js. Gerado 100% no aparelho, funciona sem
// internet: o cliente paga pelo app do banco dele e o operador confere o
// recebimento no próprio app do banco e confirma na tela (não há
// confirmação automática -- Pix estático não tem como avisar).
import { lerConfig, gravarConfig, ErroDeNegocio } from './base.js';

function tlv(id, valor) {
  return `${id}${String(valor.length).padStart(2, '0')}${valor}`;
}

function limpar(texto, max) {
  const t = String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, '').toUpperCase().trim();
  return t.slice(0, max) || 'NAO INFORMADO';
}

export function crc16(payload) {
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

export function montarPayloadPix({ chave, nomeRecebedor, cidade, valorCentavos, referencia }) {
  if (!chave) throw new ErroDeNegocio('Nenhuma chave Pix configurada. Cadastre em Ajustes → Pix.', 'pix_sem_chave');
  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) throw new ErroDeNegocio('Valor do Pix inválido.');
  const ref = String(referencia || '***').replace(/[^a-zA-Z0-9]/g, '').slice(0, 25) || '***';
  const payload = tlv('00', '01')
    + tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', String(chave).trim()))
    + tlv('52', '0000')
    + tlv('53', '986')
    + tlv('54', (valorCentavos / 100).toFixed(2))
    + tlv('58', 'BR')
    + tlv('59', limpar(nomeRecebedor, 25))
    + tlv('60', limpar(cidade, 15))
    + tlv('62', tlv('05', ref))
    + '6304';
  return payload + crc16(payload);
}

export async function configPix(db) {
  return {
    chave: await lerConfig(db, 'pix_chave', ''),
    nomeRecebedor: await lerConfig(db, 'pix_nome', ''),
    cidade: await lerConfig(db, 'pix_cidade', ''),
  };
}

export async function salvarConfigPix(db, { chave, nomeRecebedor, cidade }) {
  const c = String(chave || '').trim();
  if (c && c.length > 77) throw new ErroDeNegocio('Chave Pix muito longa.');
  await gravarConfig(db, 'pix_chave', c);
  await gravarConfig(db, 'pix_nome', String(nomeRecebedor || '').trim());
  await gravarConfig(db, 'pix_cidade', String(cidade || '').trim());
}
