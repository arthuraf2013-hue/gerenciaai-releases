const crypto = require('crypto');

/**
 * Teste grátis de 14 dias para instalação nova.
 *
 * Como funciona:
 *  - instalação criada a partir desta versão nasce com `teste: { dias: 14 }`
 *    no documento installations/{id} (ver licenseService.checkLicense). O
 *    início é o `criadoEm` do documento -- hora do SERVIDOR, não do relógio
 *    do computador;
 *  - a Central estende (grava `testeAte`) ou converte (vincula a um cliente:
 *    com `clienteId` não existe mais prazo de teste);
 *  - instalação antiga (documento sem `teste`) nunca entra nisso: nada muda
 *    para quem já usa o sistema;
 *  - `maquinaHash` (hash do MachineGuid do Windows, nunca o valor em si)
 *    deixa a Central ver que o mesmo computador já teve um teste antes
 *    (reinstalou ou apagou os dados para ganhar outro prazo).
 *
 * O prazo é conferido no próprio app (computeAccessStatus), com o relógio
 * sincronizado pela internet (timeService.nowMs) e a regra de 3 dias sem
 * contato que já existe -- adiantar o relógio do Windows não estica o teste.
 */

const DIAS_TESTE = 14;
const DIA_MS = 86400000;

const ehTimestamp = (t) => !!t && typeof t.toMillis === 'function';

/**
 * Fim do teste (ms) segundo o documento da instalação, ou null quando ela
 * não está em teste (cliente vinculado, instalação antiga, ou o servidor
 * ainda não devolveu o `criadoEm`).
 */
function fimDoTeste(dados) {
  if (!dados || dados.clienteId) return null;
  if (ehTimestamp(dados.testeAte)) return dados.testeAte.toMillis();
  const dias = Number(dados.teste?.dias);
  if (!Number.isInteger(dias) || dias <= 0 || !ehTimestamp(dados.criadoEm)) return null;
  return dados.criadoEm.toMillis() + dias * DIA_MS;
}

/** Situação do teste num instante. `null` = não está em teste. */
function situacao(fimMs, agoraMs) {
  if (fimMs == null || !Number.isFinite(fimMs)) return null;
  const restanteMs = fimMs - agoraMs;
  return {
    expirado: restanteMs <= 0,
    // Arredonda pra cima: com 30 h restantes, "faltam 2 dias".
    diasRestantes: restanteMs <= 0 ? 0 : Math.ceil(restanteMs / DIA_MS),
    fimEm: new Date(fimMs).toISOString(),
  };
}

/** "5581999999999" -> link de WhatsApp com mensagem; null sem número. */
function linkWhatsapp(numero, mensagem) {
  const digitos = String(numero || '').replace(/\D/g, '');
  if (digitos.length < 10 || digitos.length > 13) return null;
  const comDdi = digitos.length <= 11 ? `55${digitos}` : digitos;
  return `https://wa.me/${comDdi}${mensagem ? `?text=${encodeURIComponent(mensagem)}` : ''}`;
}

let hashEmCache;
/**
 * Hash do MachineGuid do Windows (nunca o GUID em si). Fora do Windows, ou
 * se não der para ler, devolve null -- é só uma ajuda para a Central.
 */
async function maquinaHash() {
  if (hashEmCache !== undefined) return hashEmCache;
  hashEmCache = null;
  if (process.platform !== 'win32') return hashEmCache;
  try {
    const { execFile } = require('child_process');
    const saida = await new Promise((resolve, reject) => {
      execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { timeout: 5000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    });
    const guid = saida.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{20,})/)?.[1];
    if (guid) hashEmCache = crypto.createHash('sha256').update(`gerenciaai-maquina:${guid.toLowerCase()}`).digest('hex').slice(0, 32);
  } catch {
    hashEmCache = null;
  }
  return hashEmCache;
}

module.exports = { DIAS_TESTE, fimDoTeste, situacao, linkWhatsapp, maquinaHash };
