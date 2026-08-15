/**
 * QR Code impresso no DANFE-NFCe (o recibo) — o link que o cliente
 * escaneia pra conferir a nota no site da SEFAZ.
 *
 * Layout 3.00 (NT 2025.001), obrigatório em produção desde 01/09/2025.
 * A versão antiga (2.00) exigia embutir o CSC (Código de Segurança do
 * Contribuinte) e um hash SHA-1 calculado a partir dele direto na URL;
 * a partir da 3.00 isso foi REMOVIDO — pra emissão online (síncrona,
 * que é o único modo que este app usa; não há contingência
 * implementada ainda), o conteúdo do QR Code é só:
 *
 *   <chave de acesso (44 dígitos)>|<versão, sempre "3">|<tpAmb>
 *
 * sem nenhum segredo embutido — a autenticidade é conferida pela
 * própria SEFAZ ao consultar a chave, não por um hash local. Isso
 * também significa que o CSC, hoje, não é mais necessário pra emitir
 * NFC-e válida (só ficou obsoleto pro QR Code — nunca foi usado em
 * nenhuma outra parte do XML ou da transmissão neste app).
 *
 * Fontes conferidas em 14/08/2026: Nota Técnica 2025.001 (mudança
 * confirmada por https://github.com/nfephp-org/sped-nfe/issues/1099,
 * https://gsoft.com.br/artigos/nota-tecnica-2025-001,
 * https://blog.tecnospeed.com.br/nota-tecnica-2025-001-nfc-e-qr-code/
 * e https://inventti.com.br/nf-e-nfc-e-nt-2025-001-versao1-00-novo-leiaute-qr-code-3-00-e-moc-danfe-nfc-e-6-00/).
 * A ficha técnica oficial completa (NT2025.001) não pôde ser lida
 * diretamente aqui — o formato do modo online (chave|3|tpAmb) está
 * confirmado por múltiplas fontes independentes, mas vale conferir de
 * novo contra o Manual de Orientação do Contribuinte antes de confiar
 * 100% em produção, principalmente se já faz tempo desde essa data.
 *
 * O que este app NÃO cobre: contingência (emissão offline) tem um
 * formato de QR diferente na v3 — passa a incluir uma assinatura
 * digital própria em vez do hash antigo — mas como este app não
 * implementa contingência (ver README/LICENCIAMENTO), isso não se
 * aplica ainda.
 */

const VERSAO_QRCODE = '3';

/** Conteúdo (sem a URL base) que vai depois do "?p=" no QR Code. */
function montarConteudoQrCode({ chaveAcesso, ambiente }) {
  if (!/^\d{44}$/.test(String(chaveAcesso || ''))) {
    throw new Error('Chave de acesso inválida para montar o QR Code (precisa de 44 dígitos).');
  }
  const tpAmb = ambiente === 'producao' ? '1' : '2';
  return `${chaveAcesso}|${VERSAO_QRCODE}|${tpAmb}`;
}

/**
 * Monta a URL completa do QR Code — só se a "URL de consulta" da SEFAZ
 * do estado estiver configurada (é diferente por UF, e diferente
 * também da URL do webservice de autorização; não temos como inferir
 * uma a partir da outra com segurança, por isso é campo de
 * configuração, preenchido uma vez em Configurações → Fiscal).
 * Devolve null se não estiver configurada — quem chama decide o que
 * mostrar nesse caso (ex: só a chave em texto, sem QR escaneável).
 */
function montarUrlQrCode({ chaveAcesso, ambiente, urlConsulta }) {
  if (!urlConsulta) return null;
  const conteudo = montarConteudoQrCode({ chaveAcesso, ambiente });
  const base = String(urlConsulta).trim().replace(/\?.*$/, '').replace(/\/$/, '');
  return `${base}?p=${conteudo}`;
}

/** Chave de acesso formatada em grupos de 4 dígitos — só pra exibição
 * (no recibo, embaixo do QR), como o DANFE oficial mostra. */
function formatarChaveAcesso(chaveAcesso) {
  return String(chaveAcesso || '').replace(/(\d{4})(?=\d)/g, '$1 ');
}

module.exports = { VERSAO_QRCODE, montarConteudoQrCode, montarUrlQrCode, formatarChaveAcesso };
