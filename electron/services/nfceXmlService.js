const { montarChaveAcesso, gerarCodigoNumericoAleatorio, CODIGO_UF } = require('./nfceChaveService');

/**
 * Gera o XML da NFC-e (modelo 65, layout 4.00) — a estrutura completa,
 * formatada e com os valores calculados. Este arquivo só MONTA o XML;
 * quem assina é nfceSignatureService.js e quem transmite é
 * nfceTransmissionService.js (ambos já implementados e usados por
 * fiscalService.js — ver o comentário de emitirNFCe lá pra saber
 * exatamente o que do ciclo de NFC-e já funciona e o que ainda falta:
 * cancelamento, inutilização de numeração e contingência).
 *
 * Testei a fundo a parte que dá pra testar sem ambiente de homologação
 * real: chave de acesso (módulo 11, ver nfceChaveService.js), formato
 * dos valores, estrutura das tags obrigatórias. O que só vai poder ser
 * confirmado contra a SEFAZ de verdade: se o XML passa na validação do
 * schema XSD oficial e nas regras de negócio deles — isso eu não tenho
 * como simular aqui sem um ambiente de homologação de verdade.
 */

const VERSAO_LAYOUT = '4.00';

/** Regime tributário do cadastro -> Código de Regime Tributário (CRT)
 * exigido no XML. MEI se enquadra como Simples Nacional pra esse fim. */
function crtDoRegime(regimeTributario) {
  if (regimeTributario === 'simples_nacional' || regimeTributario === 'mei') return '1';
  return '3'; // lucro_presumido, lucro_real
}

/** Forma de pagamento interna do app -> código tPag da tabela oficial
 * (atualizada 2024 — inclui 91=Pagamento Posterior, o código certo
 * pra fiado, que antes dessa atualização não tinha equivalente exato). */
const TPAG_POR_METODO = {
  dinheiro: '01',
  cartao_credito: '03',
  cartao_debito: '04',
  pix: '17', // PIX dinâmico — é o que o app gera (QR Code com valor já preenchido)
  fiado: '91', // Pagamento Posterior
  outro: '99',
};

function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Formata valor monetário com 2 casas — padrão exigido em quase todo
 * campo de valor do XML. */
function fmtValor(v) {
  return (Number(v) || 0).toFixed(2);
}

/** Formata quantidade com 4 casas — padrão do schema pra qCom/qTrib. */
function fmtQtd(v) {
  return (Number(v) || 0).toFixed(4);
}

/** Fuso horário por UF — a maioria do Brasil é UTC-3, mas alguns
 * estados têm fuso próprio. Calcular certo importa porque não posso
 * confiar no fuso configurado na máquina que roda isso (podia estar
 * errado ou em UTC por engano, e o XML sairia com hora errada sem
 * ninguém perceber). */
const TIMEZONE_POR_UF = {
  AC: 'America/Rio_Branco', // UTC-5
  AM: 'America/Manaus', // UTC-4 (a maior parte do estado)
  MT: 'America/Cuiaba', // UTC-4
  MS: 'America/Campo_Grande', // UTC-4
  RR: 'America/Boa_Vista', // UTC-4
  RO: 'America/Porto_Velho', // UTC-4
};
const TIMEZONE_PADRAO = 'America/Sao_Paulo'; // UTC-3 — a grande maioria dos estados

/** Data/hora no formato exigido: AAAA-MM-DDThh:mm:ssTZD (com fuso) —
 * calculado pra timezone certa do estado emissor, não pra timezone da
 * máquina que roda o app. */
function fmtDataHora(data, uf) {
  const d = data instanceof Date ? data : new Date(data);
  const timeZone = TIMEZONE_POR_UF[uf] || TIMEZONE_PADRAO;

  // Pega os componentes de data/hora NA timezone certa (não na da máquina)
  const partesFormatadas = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const partes = {};
  for (const p of partesFormatadas) partes[p.type] = p.value;

  // Calcula o offset comparando o timestamp UTC com o mesmo instante
  // interpretado como se fosse hora local da timezone alvo.
  const comoUTC = Date.UTC(
    Number(partes.year), Number(partes.month) - 1, Number(partes.day),
    Number(partes.hour) === 24 ? 0 : Number(partes.hour), Number(partes.minute), Number(partes.second)
  );
  const offsetMin = Math.round((comoUTC - d.getTime()) / 60000);
  const sinal = offsetMin >= 0 ? '+' : '-';
  const pad = (n) => String(n).padStart(2, '0');
  const tzH = pad(Math.floor(Math.abs(offsetMin) / 60));
  const tzM = pad(Math.abs(offsetMin) % 60);

  return `${partes.year}-${partes.month}-${partes.day}T${partes.hour === '24' ? '00' : partes.hour}:${partes.minute}:${partes.second}${sinal}${tzH}:${tzM}`;
}

/**
 * Grupo de ICMS do item — a parte que mais varia por regime tributário
 * e por código de tributação. Implementei a fundo o caminho mais comum
 * (Simples Nacional, CSOSN 102/300/400/500 — que são os que NÃO
 * precisam de base de cálculo de crédito) — é o caso da grande maioria
 * dos pequenos negócios. Regime normal (CST) e CSOSNs que envolvem
 * cálculo de crédito (101, 201, 202, 203, 900) estão implementados de
 * forma mais simples e PRECISAM de revisão antes de confiar — avisa no
 * XML gerado com um comentário.
 */
function montarGrupoIcms(product, regimeTributario) {
  const origem = product.origem_mercadoria || '0';
  const codigo = product.cst_csosn || (regimeTributario === 'simples_nacional' || regimeTributario === 'mei' ? '102' : '40');

  const csosnsSimples = ['102', '103', '300', '400', '500'];
  const ehSimplesNacional = regimeTributario === 'simples_nacional' || regimeTributario === 'mei';

  if (ehSimplesNacional && csosnsSimples.includes(codigo)) {
    return `<ICMS><ICMSSN${codigo}><orig>${origem}</orig><CSOSN>${codigo}</CSOSN></ICMSSN${codigo}></ICMS>`;
  }

  if (ehSimplesNacional) {
    // CSOSN que precisaria de base de cálculo (101, 201, 202, 203, 900)
    // — monta o grupo mínimo, mas isso deve ser revisado por um
    // contador antes de emitir de verdade com um desses códigos.
    return `<ICMS><ICMSSN${codigo}><orig>${origem}</orig><CSOSN>${codigo}</CSOSN></ICMSSN${codigo}></ICMS><!-- REVISAR: CSOSN ${codigo} normalmente precisa de vBC/pCredSN/vCredICMSSN -->`;
  }

  // Regime normal (lucro presumido/real) — CST. Os mais simples
  // (isenta/não tributada/suspensão) não precisam de base de cálculo;
  // CST 00 (tributada integralmente) precisaria de vBC/pICMS/vICMS,
  // que não temos por produto ainda — fica marcado pra revisão.
  const cstsSimples = ['40', '41', '50'];
  if (cstsSimples.includes(codigo)) {
    return `<ICMS><ICMS${codigo}><orig>${origem}</orig><CST>${codigo}</CST></ICMS${codigo}></ICMS>`;
  }
  return `<ICMS><ICMS${codigo}><orig>${origem}</orig><CST>${codigo}</CST></ICMS${codigo}></ICMS><!-- REVISAR: CST ${codigo} pode precisar de vBC/pICMS/vICMS -->`;
}

/** PIS/COFINS — Simples Nacional tipicamente usa CST 07 (isenta), já
 * que PIS/COFINS ficam embutidos no DAS. Regime normal precisaria de
 * alíquota por produto, que ainda não temos cadastrado — fica com CST
 * 07 como padrão seguro (não cobra imposto a mais), mas marcado pra
 * revisão nesse caso. */
function montarGrupoPisCofins(regimeTributario) {
  const ehSimplesNacional = regimeTributario === 'simples_nacional' || regimeTributario === 'mei';
  const comentario = ehSimplesNacional ? '' : '<!-- REVISAR: regime normal pode precisar de alíquota de PIS/COFINS por produto -->';
  return {
    pis: `<PIS><PISNT><CST>07</CST></PISNT></PIS>${comentario}`,
    cofins: `<COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>`,
  };
}

/**
 * Gera o XML completo da NFC-e (ainda sem assinatura). Devolve o XML,
 * a chave de acesso, e o código numérico usado (guardar isso é
 * importante — reemitir com os mesmos parâmetros mas cNF diferente
 * gera uma chave diferente).
 */
function gerarXmlNFCe({ config, sale, items, payments, numero, dataEmissao, tpEmis = '1', justificativaContingencia }) {
  const dataEmissaoFinal = dataEmissao || new Date();
  const cNF = gerarCodigoNumericoAleatorio();
  const cUF = CODIGO_UF[config.uf];
  if (!cUF) throw new Error(`UF desconhecida na config fiscal: "${config.uf}".`);

  const chaveAcesso = montarChaveAcesso({
    uf: config.uf, dataEmissao: dataEmissaoFinal, cnpj: config.cnpj,
    serie: config.serie_nfce || '1', numero, codigoNumerico: cNF, tpEmis,
  });

  const cMunFG = config.municipio_codigo_ibge;
  const crt = crtDoRegime(config.regime_tributario);
  const tpAmb = config.ambiente === 'producao' ? '1' : '2';

  // --- <ide> ---
  const ide = `<ide>
    <cUF>${cUF}</cUF>
    <cNF>${cNF}</cNF>
    <natOp>Venda</natOp>
    <mod>65</mod>
    <serie>${escapeXml(config.serie_nfce || '1')}</serie>
    <nNF>${numero}</nNF>
    <dhEmi>${fmtDataHora(dataEmissaoFinal, config.uf)}</dhEmi>
    <tpNF>1</tpNF>
    <idDest>1</idDest>
    <cMunFG>${escapeXml(cMunFG)}</cMunFG>
    <tpImp>4</tpImp>
    <tpEmis>${tpEmis}</tpEmis>
    <cDV>${chaveAcesso[43]}</cDV>
    <tpAmb>${tpAmb}</tpAmb>
    <finNFe>1</finNFe>
    <indFinal>1</indFinal>
    <indPres>1</indPres>
    <procEmi>0</procEmi>
    <verProc>1.0</verProc>
    ${tpEmis !== '1' ? `<dhCont>${fmtDataHora(dataEmissaoFinal, config.uf)}</dhCont><xJust>${escapeXml(justificativaContingencia || 'Falha de comunicacao com a SEFAZ no momento da venda')}</xJust>` : ''}
  </ide>`;

  // --- <emit> ---
  const end = config.endereco || {};
  const emit = `<emit>
    <CNPJ>${escapeXml(String(config.cnpj).replace(/\D/g, ''))}</CNPJ>
    <xNome>${escapeXml(config.razao_social)}</xNome>
    ${config.nome_fantasia ? `<xFant>${escapeXml(config.nome_fantasia)}</xFant>` : ''}
    <enderEmit>
      <xLgr>${escapeXml(end.logradouro)}</xLgr>
      <nro>${escapeXml(end.numero)}</nro>
      ${end.complemento ? `<xCpl>${escapeXml(end.complemento)}</xCpl>` : ''}
      <xBairro>${escapeXml(end.bairro)}</xBairro>
      <cMun>${escapeXml(cMunFG)}</cMun>
      <xMun>${escapeXml(end.municipio)}</xMun>
      <UF>${escapeXml(config.uf)}</UF>
      <CEP>${escapeXml(String(end.cep || '').replace(/\D/g, ''))}</CEP>
    </enderEmit>
    <IE>${escapeXml(config.inscricao_estadual)}</IE>
    <CRT>${crt}</CRT>
  </emit>`;

  // --- <det> (um por item, ignorando itens cancelados) ---
  const itensAtivos = items.filter((i) => !i.cancelado);
  let vProdTotal = 0;
  const detBlocos = itensAtivos.map((item, idx) => {
    const nItem = idx + 1;
    const vProd = item.preco_unitario * item.quantidade;
    vProdTotal += vProd;
    const { pis, cofins } = montarGrupoPisCofins(config.regime_tributario);

    return `<det nItem="${nItem}">
      <prod>
        <cProd>${escapeXml(item.sku || item.product_id)}</cProd>
        <cEAN>${item.codigo_barras ? escapeXml(item.codigo_barras) : 'SEM GTIN'}</cEAN>
        <xProd>${escapeXml(item.nome)}</xProd>
        <NCM>${escapeXml(item.ncm || '00000000')}</NCM>
        <CFOP>${escapeXml(item.cfop || '5102')}</CFOP>
        <uCom>${escapeXml(item.unidade || 'UN')}</uCom>
        <qCom>${fmtQtd(item.quantidade)}</qCom>
        <vUnCom>${fmtValor(item.preco_unitario)}</vUnCom>
        <vProd>${fmtValor(vProd)}</vProd>
        <cEANTrib>${item.codigo_barras ? escapeXml(item.codigo_barras) : 'SEM GTIN'}</cEANTrib>
        <uTrib>${escapeXml(item.unidade || 'UN')}</uTrib>
        <qTrib>${fmtQtd(item.quantidade)}</qTrib>
        <vUnTrib>${fmtValor(item.preco_unitario)}</vUnTrib>
        <indTot>1</indTot>
      </prod>
      <imposto>
        ${montarGrupoIcms(item, config.regime_tributario)}
        ${pis}
        ${cofins}
      </imposto>
    </det>`;
  }).join('\n');

  // --- <total> ---
  const vDesc = fmtValor((sale.desconto || 0) + (sale.desconto_gerente || 0));
  const vNF = fmtValor(vProdTotal - (sale.desconto || 0) - (sale.desconto_gerente || 0));
  const total = `<total>
    <ICMSTot>
      <vBC>0.00</vBC>
      <vICMS>0.00</vICMS>
      <vICMSDeson>0.00</vICMSDeson>
      <vFCP>0.00</vFCP>
      <vBCST>0.00</vBCST>
      <vST>0.00</vST>
      <vFCPST>0.00</vFCPST>
      <vFCPSTRet>0.00</vFCPSTRet>
      <vProd>${fmtValor(vProdTotal)}</vProd>
      <vFrete>0.00</vFrete>
      <vSeg>0.00</vSeg>
      <vDesc>${vDesc}</vDesc>
      <vII>0.00</vII>
      <vIPI>0.00</vIPI>
      <vIPIDevol>0.00</vIPIDevol>
      <vPIS>0.00</vPIS>
      <vCOFINS>0.00</vCOFINS>
      <vOutro>0.00</vOutro>
      <vNF>${vNF}</vNF>
    </ICMSTot>
  </total>`;

  // --- <pag> ---
  const pagamentosValidos = payments.filter((p) => TPAG_POR_METODO[p.metodo]);
  const totalPago = pagamentosValidos.reduce((acc, p) => acc + p.valor, 0);
  const troco = Math.max(0, totalPago - Number(vNF));
  const detPagBlocos = pagamentosValidos.map((p) => `<detPag>
      <tPag>${TPAG_POR_METODO[p.metodo]}</tPag>
      ${p.metodo === 'outro' ? '<xPag>Outro</xPag>' : ''}
      <vPag>${fmtValor(p.valor)}</vPag>
    </detPag>`).join('\n');
  const pag = `<pag>
    ${detPagBlocos}
    ${troco > 0 ? `<vTroco>${fmtValor(troco)}</vTroco>` : ''}
  </pag>`;

  const infNFeId = `NFe${chaveAcesso}`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="${infNFeId}" versao="${VERSAO_LAYOUT}">
    ${ide}
    ${emit}
    ${detBlocos}
    ${total}
    <transp><modFrete>9</modFrete></transp>
    ${pag}
  </infNFe>
</NFe>`;

  return { xml, chaveAcesso, codigoNumerico: cNF, infNFeId };
}

module.exports = {
  gerarXmlNFCe, crtDoRegime, TPAG_POR_METODO,
  // Exportados também pra nfceEventoService.js/nfceInutilizacaoService.js
  // reaproveitarem em vez de duplicar (mesmo formato de data COM fuso
  // por UF, mesmo escape de XML) -- funções puras, sem estado, não criam
  // acoplamento de verdade entre "montar NFe" e "montar evento/inutilização".
  escapeXml, fmtDataHora,
};
