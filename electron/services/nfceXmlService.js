const { montarChaveAcesso, gerarCodigoNumericoAleatorio, CODIGO_UF } = require('./nfceChaveService');

/**
 * Gera o XML da NFC-e (modelo 65, layout 4.00). Este arquivo só MONTA o
 * XML; quem assina é nfceSignatureService.js, quem acrescenta o
 * <infNFeSupl> (QR Code + consulta por chave) é `inserirInfNFeSupl` daqui,
 * DEPOIS da assinatura, e quem transmite é nfceTransmissionService.js
 * (ciclo completo em fiscalService.emitirNFCe).
 *
 * Revisão de nov/2026 (auditoria da integração com a SEFAZ) -- o que estava
 * errado e passou a ser feito aqui, cada item com a rejeição que evita:
 *  - XML compacto, sem quebra de linha/espaço entre as tags nem comentário
 *    (588 -- "caracteres de edição"); avisos de revisão saem em `avisos`;
 *  - sem a declaração <?xml?> (o documento vai DENTRO do envelope SOAP);
 *  - desconto rateado por item (det/prod/vDesc) e a taxa de serviço como
 *    "outras despesas" rateada (det/prod/vOutro) -- o total precisa ser a
 *    soma dos itens (rejeições 536/537 e troco errado), contas em centavos;
 *  - homologação: descrição do 1º item com o texto exigido (373);
 *  - código de barras só se for GTIN válido e não interno (prefixo 2) --
 *    senão "SEM GTIN" (611/883);
 *  - cartão e Pix dinâmico com o grupo <card> (391), integrado quando veio
 *    da maquininha/Pix automático (CNPJ da credenciadora + autorização,
 *    392); Pix do QR fixo (chave da loja) é Pix ESTÁTICO = tPag 20, sem
 *    <card> (963);
 *  - grupo do responsável técnico (<infRespTec>, 972) quando configurado;
 *  - AAMM da chave no mesmo fuso da dhEmi; cNF nunca igual ao nNF.
 *
 * O que ainda só se confirma de verdade em homologação: regras de negócio
 * de cada UF e o schema oficial. tests/nfceXml.test.js cobre a estrutura.
 */

const VERSAO_LAYOUT = '4.00';
const XMLNS_NFE = 'http://www.portalfiscal.inf.br/nfe';
const DESCRICAO_HOMOLOGACAO = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

/** CRT da NF-e/NFC-e. MEI usa 4 desde a NT 2024.001 (obrigatório a partir de
 * abril/2025; CRT 1 em nota de MEI é rejeitado pela SEFAZ). */
function crtDoRegime(regimeTributario) {
  if (regimeTributario === 'mei') return '4';
  if (regimeTributario === 'simples_nacional') return '1';
  return '3'; // lucro_presumido, lucro_real
}

/** Forma de pagamento interna do app -> código tPag da tabela oficial.
 * Pix: 17 = dinâmico (Pix automático do provedor), 20 = estático (QR fixo
 * com a chave da loja) -- ver tPagDoPagamento. 91 = pagamento posterior
 * (fiado). */
const TPAG_POR_METODO = {
  dinheiro: '01',
  cartao_credito: '03',
  cartao_debito: '04',
  pix: '17',
  fiado: '91',
  outro: '99',
};
// tPag que exigem o grupo <card> (NT 2023.004 / 2024.003, regra YA04-10).
const TPAG_COM_CARD = new Set(['03', '04', '10', '11', '12', '13', '15', '17', '18']);

// CNPJ das credenciadoras integradas (vai em card/CNPJ com tpIntegra=1).
const CNPJ_CREDENCIADORA = {
  mercadopago: '10573521000191', // Mercado Pago Instituição de Pagamento Ltda.
};

// Bandeira (tBand) a partir do identificador do meio de pagamento do provedor.
const TBAND = {
  visa: '01', master: '02', mastercard: '02', amex: '03', americanexpress: '03', sorocred: '04',
  diners: '05', elo: '06', hipercard: '07', hiper: '07', aura: '08', cabal: '09', alelo: '10',
  banescard: '11', calcard: '12', credz: '13', discover: '14', goodcard: '15', grencard: '16',
  jcb: '20', mais: '21', maxvan: '22', policard: '23', redecompras: '24', sodexo: '25', valecard: '26',
  verocheque: '27', vr: '28', ticket: '29',
};

function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Texto que vai num campo do XML: sem caractere de controle nem espaço
 * duplo/nas pontas (o schema da NF-e recusa espaço no início/fim). */
function textoXml(s, max) {
  const limpo = String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return escapeXml(max ? limpo.slice(0, max).trim() : limpo);
}

/** Valor monetário com 2 casas. */
function fmtValor(v) {
  return (Number(v) || 0).toFixed(2);
}
/** Centavos (inteiro) -> "12.34". */
function fmtCent(c) {
  const sinal = c < 0 ? '-' : '';
  const a = Math.abs(Math.round(c));
  return `${sinal}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
function cent(v) {
  return Math.round((Number(v) || 0) * 100 + (Number(v) >= 0 ? 1e-7 : -1e-7));
}

/** Quantidade com 4 casas (qCom/qTrib). */
function fmtQtd(v) {
  return (Number(v) || 0).toFixed(4);
}

/** Valor unitário (vUnCom/vUnTrib): até 10 casas, no mínimo 2 -- preço por
 * kg com 3 casas não pode ser arredondado aqui, senão vProd deixa de bater
 * com qCom x vUnCom (rejeição 629). */
function fmtUnitario(v) {
  const n = Number(v) || 0;
  let s = n.toFixed(10).replace(/0+$/, '');
  if (s.endsWith('.')) s += '00';
  const casas = s.split('.')[1]?.length || 0;
  return casas < 2 ? n.toFixed(2) : s;
}

/** Fuso horário por UF -- a maioria do Brasil é UTC-3. Não confia no fuso
 * configurado na máquina. */
const TIMEZONE_POR_UF = {
  AC: 'America/Rio_Branco', // UTC-5
  AM: 'America/Manaus', // UTC-4 (a maior parte do estado)
  MT: 'America/Cuiaba', // UTC-4
  MS: 'America/Campo_Grande', // UTC-4
  RR: 'America/Boa_Vista', // UTC-4
  RO: 'America/Porto_Velho', // UTC-4
};
const TIMEZONE_PADRAO = 'America/Sao_Paulo';

function partesNoFuso(data, uf) {
  const d = data instanceof Date ? data : new Date(data);
  const timeZone = TIMEZONE_POR_UF[uf] || TIMEZONE_PADRAO;
  const partesFormatadas = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const p = {};
  for (const x of partesFormatadas) p[x.type] = x.value;
  if (p.hour === '24') p.hour = '00';
  return { p, d };
}

/** Data/hora no formato AAAA-MM-DDThh:mm:ssTZD, no fuso da UF emissora. */
function fmtDataHora(data, uf) {
  const { p, d } = partesNoFuso(data, uf);
  const comoUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const offsetMin = Math.round((comoUTC - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const sinal = offsetMin >= 0 ? '+' : '-';
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sinal}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
}

/** AAMM e dia da emissão no fuso da UF (os mesmos da dhEmi). */
function dataDaEmissao(data, uf) {
  const { p } = partesNoFuso(data, uf);
  return { aamm: `${p.year.slice(2)}${p.month}`, dia: p.day };
}

/** GTIN-8/12/13/14 com dígito verificador certo e fora da faixa interna
 * (prefixo 2 = uso restrito da loja, ex.: balança e código gerado pelo app). */
function gtinValido(codigo) {
  const c = String(codigo || '').trim();
  if (!/^\d+$/.test(c) || ![8, 12, 13, 14].includes(c.length)) return false;
  const gtin13 = c.padStart(14, '0').slice(1);
  if (c.length === 13 && c.startsWith('2')) return false;
  if (c.length === 12 && c.startsWith('2')) return false;
  if (c.length === 14 && gtin13.startsWith('2')) return false;
  if (/^0+$/.test(c)) return false;
  const digitos = c.split('').map(Number);
  const dv = digitos.pop();
  let soma = 0;
  for (let i = digitos.length - 1, peso = 3; i >= 0; i--, peso = peso === 3 ? 1 : 3) soma += digitos[i] * peso;
  return (10 - (soma % 10)) % 10 === dv;
}

/**
 * Grupo de ICMS do item. Simples Nacional, CSOSN 102/103/300/400/500
 * (sem crédito) é o caminho completo; os demais saem com o grupo mínimo e
 * um aviso de revisão (o contador confere antes de usar).
 */
function montarGrupoIcms(product, regimeTributario, avisos) {
  const origem = product.origem_mercadoria || '0';
  const ehSimplesNacional = regimeTributario === 'simples_nacional' || regimeTributario === 'mei';
  const codigo = product.cst_csosn || (ehSimplesNacional ? '102' : '40');
  const csosnsSimples = ['102', '103', '300', '400', '500'];

  if (ehSimplesNacional && csosnsSimples.includes(codigo)) {
    // 102, 103, 300 e 400 usam o mesmo grupo ICMSSN102 (só o CSOSN muda).
    const grupo = codigo === '500' ? 'ICMSSN500' : 'ICMSSN102';
    return `<ICMS><${grupo}><orig>${origem}</orig><CSOSN>${codigo}</CSOSN></${grupo}></ICMS>`;
  }
  if (ehSimplesNacional) {
    avisos.push(`CSOSN ${codigo} (${product.nome || 'produto'}) normalmente exige base de cálculo/crédito: revisar com o contador.`);
    return `<ICMS><ICMSSN${codigo}><orig>${origem}</orig><CSOSN>${codigo}</CSOSN></ICMSSN${codigo}></ICMS>`;
  }
  // Regime normal: 40/41/50 usam o mesmo grupo ICMS40.
  if (['40', '41', '50'].includes(codigo)) {
    return `<ICMS><ICMS40><orig>${origem}</orig><CST>${codigo}</CST></ICMS40></ICMS>`;
  }
  avisos.push(`CST ${codigo} (${product.nome || 'produto'}) pode exigir vBC/pICMS/vICMS: revisar com o contador.`);
  return `<ICMS><ICMS${codigo}><orig>${origem}</orig><CST>${codigo}</CST></ICMS${codigo}></ICMS>`;
}

/** PIS/COFINS -- CST 07 (isenta), padrão do Simples (fica no DAS). */
function montarGrupoPisCofins(regimeTributario, avisos) {
  const ehSimplesNacional = regimeTributario === 'simples_nacional' || regimeTributario === 'mei';
  if (!ehSimplesNacional && !avisos.includes('PIS/COFINS')) avisos.push('PIS/COFINS');
  return {
    pis: '<PIS><PISNT><CST>07</CST></PISNT></PIS>',
    cofins: '<COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>',
  };
}

/** Rateia `totalCent` entre os itens na proporção de `bases` (centavos);
 * o último leva a sobra do arredondamento. */
function ratear(totalCent, bases) {
  const soma = bases.reduce((a, b) => a + b, 0);
  if (!(totalCent > 0) || !(soma > 0)) return bases.map(() => 0);
  let distribuido = 0;
  return bases.map((b, i) => {
    if (i === bases.length - 1) return totalCent - distribuido;
    const parte = Math.floor((totalCent * b) / soma);
    distribuido += parte;
    return parte;
  });
}

function lerDetalhes(p) {
  if (p?.detalhes && typeof p.detalhes === 'object') return p.detalhes;
  try { return JSON.parse(p?.detalhes || '{}') || {}; } catch { return {}; }
}

/** tPag do pagamento: Pix sem cobrança do provedor = QR fixo da chave = Pix estático (20). */
function tPagDoPagamento(p) {
  if (p.metodo === 'pix') {
    const d = lerDetalhes(p);
    return d.pixAutomatico || d.maquininha ? '17' : '20';
  }
  return TPAG_POR_METODO[p.metodo] || null;
}

/** Grupo <card> do pagamento (só para tPag que o exigem). */
function montarCard(p, tPag) {
  if (!TPAG_COM_CARD.has(tPag)) return '';
  const d = lerDetalhes(p);
  const maq = d.maquininha && typeof d.maquininha === 'object' ? d.maquininha : null;
  const pixAuto = d.pixAutomatico && typeof d.pixAutomatico === 'object' ? d.pixAutomatico : null;
  const provedor = maq ? 'mercadopago' : (pixAuto?.provedor === 'mercadopago' ? 'mercadopago' : null);
  const cnpj = provedor ? CNPJ_CREDENCIADORA[provedor] : null;
  const autorizacao = String(maq?.autorizacao || maq?.pagamentoId || pixAuto?.cobranca || '').replace(/[^\w-]/g, '').slice(0, 20);
  if (cnpj && autorizacao) {
    const bandeira = maq?.bandeira ? TBAND[String(maq.bandeira).toLowerCase().replace(/[^a-z]/g, '')] : null;
    return `<card><tpIntegra>1</tpIntegra><CNPJ>${cnpj}</CNPJ>${bandeira ? `<tBand>${bandeira}</tBand>` : ''}<cAut>${escapeXml(autorizacao)}</cAut></card>`;
  }
  // Cobrado fora do sistema (maquininha não integrada): não integrado.
  return '<card><tpIntegra>2</tpIntegra></card>';
}

/** Remove quebras de linha/indentação entre tags e comentários (588). */
function compactarXml(xml) {
  return String(xml).replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').trim();
}

/** Tira a declaração <?xml ...?> (o documento vai dentro do SOAP). */
function semDeclaracao(xml) {
  return String(xml).replace(/^﻿?\s*<\?xml[^>]*\?>\s*/, '');
}

/** cNF aleatório, nunca igual ao nNF nem uma sequência óbvia (regra da SEFAZ). */
function gerarCnf(numero) {
  const proibidos = new Set(['00000000', '11111111', '22222222', '33333333', '44444444', '55555555', '66666666',
    '77777777', '88888888', '99999999', '12345678', '23456789', '34567890', '45678901', '56789012', '67890123',
    '78901234', '89012345', '90123456', '01234567']);
  for (let i = 0; i < 20; i++) {
    const c = gerarCodigoNumericoAleatorio();
    if (c !== String(numero).padStart(8, '0') && !proibidos.has(c)) return c;
  }
  return '13579246';
}

/**
 * Gera o XML completo da NFC-e (sem assinatura e sem infNFeSupl). Devolve o
 * XML compacto, a chave, o cNF, os totais (vNF para o QR da contingência) e
 * os avisos de revisão.
 *
 * `respTec`: { cnpj, contato, email, fone } do responsável técnico pelo
 * sistema (ver nfceRespTecnico.js) -- sem CNPJ, o grupo não sai (e a UF que
 * exige recusa com 972).
 */
function gerarXmlNFCe({ config, sale, items, payments, numero, dataEmissao, tpEmis = '1', justificativaContingencia, respTec }) {
  const dataEmissaoFinal = dataEmissao || new Date();
  const cUF = CODIGO_UF[config.uf];
  if (!cUF) throw new Error(`UF desconhecida na config fiscal: "${config.uf}".`);
  const cNF = gerarCnf(numero);
  const { aamm } = dataDaEmissao(dataEmissaoFinal, config.uf);

  const chaveAcesso = montarChaveAcesso({
    uf: config.uf, dataEmissao: dataEmissaoFinal, aamm, cnpj: config.cnpj,
    serie: config.serie_nfce || '1', numero, codigoNumerico: cNF, tpEmis,
  });

  const cMunFG = config.municipio_codigo_ibge;
  const crt = crtDoRegime(config.regime_tributario);
  const tpAmb = config.ambiente === 'producao' ? '1' : '2';
  const avisos = [];
  const dhEmi = fmtDataHora(dataEmissaoFinal, config.uf);

  const ide = `<ide>
    <cUF>${cUF}</cUF>
    <cNF>${cNF}</cNF>
    <natOp>VENDA</natOp>
    <mod>65</mod>
    <serie>${Number(config.serie_nfce || '1')}</serie>
    <nNF>${Number(numero)}</nNF>
    <dhEmi>${dhEmi}</dhEmi>
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
    <verProc>GerenciaAI</verProc>
    ${tpEmis !== '1' ? `<dhCont>${dhEmi}</dhCont><xJust>${textoXml(justificativaContingencia || 'Falha de comunicacao com a SEFAZ no momento da venda', 256)}</xJust>` : ''}
  </ide>`;

  const end = config.endereco || {};
  const emit = `<emit>
    <CNPJ>${escapeXml(String(config.cnpj).replace(/[^0-9A-Za-z]/g, '').toUpperCase())}</CNPJ>
    <xNome>${textoXml(config.razao_social, 60)}</xNome>
    ${config.nome_fantasia ? `<xFant>${textoXml(config.nome_fantasia, 60)}</xFant>` : ''}
    <enderEmit>
      <xLgr>${textoXml(end.logradouro, 60)}</xLgr>
      <nro>${textoXml(end.numero, 60)}</nro>
      ${end.complemento ? `<xCpl>${textoXml(end.complemento, 60)}</xCpl>` : ''}
      <xBairro>${textoXml(end.bairro, 60)}</xBairro>
      <cMun>${escapeXml(cMunFG)}</cMun>
      <xMun>${textoXml(end.municipio, 60)}</xMun>
      <UF>${escapeXml(config.uf)}</UF>
      <CEP>${escapeXml(String(end.cep || '').replace(/\D/g, ''))}</CEP>
    </enderEmit>
    <IE>${escapeXml(String(config.inscricao_estadual || '').replace(/\D/g, ''))}</IE>
    <CRT>${crt}</CRT>
  </emit>`;

  // --- Itens, com desconto e taxa de serviço rateados (centavos) ---
  const itensAtivos = items.filter((i) => !i.cancelado);
  if (itensAtivos.length === 0) throw new Error('A venda não tem itens para a nota.');
  const vProdItens = itensAtivos.map((i) => cent(Number(i.preco_unitario) * Number(i.quantidade)));
  const vProdTotal = vProdItens.reduce((a, b) => a + b, 0);
  const descontoCent = Math.min(cent((sale.desconto || 0) + (sale.desconto_gerente || 0)), vProdTotal);
  const descontos = ratear(descontoCent, vProdItens);
  // Taxa de serviço: mesma conta de saleService.finalizeSale (sobre o
  // subtotal já com desconto) -- entra como "outras despesas acessórias".
  const taxaPct = Number(sale.taxa_servico_percentual) || 0;
  const taxaCent = taxaPct > 0 ? cent(((vProdTotal - descontoCent) / 100) * (taxaPct / 100)) : 0;
  const outros = ratear(taxaCent, vProdItens.map((v, i) => v - descontos[i]));

  const detBlocos = itensAtivos.map((item, idx) => {
    const nItem = idx + 1;
    const { pis, cofins } = montarGrupoPisCofins(config.regime_tributario, avisos);
    const gtin = gtinValido(item.codigo_barras) ? escapeXml(String(item.codigo_barras).trim()) : 'SEM GTIN';
    const nome = tpAmb === '2' && idx === 0 ? DESCRICAO_HOMOLOGACAO : item.nome;
    const unidade = textoXml(item.unidade || 'UN', 6) || 'UN';
    return `<det nItem="${nItem}">
      <prod>
        <cProd>${textoXml(item.sku || item.product_id, 60)}</cProd>
        <cEAN>${gtin}</cEAN>
        <xProd>${textoXml(nome, 120)}</xProd>
        <NCM>${escapeXml(item.ncm || '00000000')}</NCM>
        ${item.cest ? `<CEST>${escapeXml(String(item.cest).replace(/\D/g, ''))}</CEST>` : ''}
        <CFOP>${escapeXml(item.cfop || '5102')}</CFOP>
        <uCom>${unidade}</uCom>
        <qCom>${fmtQtd(item.quantidade)}</qCom>
        <vUnCom>${fmtUnitario(item.preco_unitario)}</vUnCom>
        <vProd>${fmtCent(vProdItens[idx])}</vProd>
        <cEANTrib>${gtin}</cEANTrib>
        <uTrib>${unidade}</uTrib>
        <qTrib>${fmtQtd(item.quantidade)}</qTrib>
        <vUnTrib>${fmtUnitario(item.preco_unitario)}</vUnTrib>
        ${descontos[idx] > 0 ? `<vDesc>${fmtCent(descontos[idx])}</vDesc>` : ''}
        ${outros[idx] > 0 ? `<vOutro>${fmtCent(outros[idx])}</vOutro>` : ''}
        <indTot>1</indTot>
      </prod>
      <imposto>
        ${montarGrupoIcms(item, config.regime_tributario, avisos)}
        ${pis}
        ${cofins}
      </imposto>
    </det>`;
  }).join('');

  const vNFCent = vProdTotal - descontoCent + taxaCent;
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
      <vProd>${fmtCent(vProdTotal)}</vProd>
      <vFrete>0.00</vFrete>
      <vSeg>0.00</vSeg>
      <vDesc>${fmtCent(descontoCent)}</vDesc>
      <vII>0.00</vII>
      <vIPI>0.00</vIPI>
      <vIPIDevol>0.00</vIPIDevol>
      <vPIS>0.00</vPIS>
      <vCOFINS>0.00</vCOFINS>
      <vOutro>${fmtCent(taxaCent)}</vOutro>
      <vNF>${fmtCent(vNFCent)}</vNF>
    </ICMSTot>
  </total>`;

  // --- Pagamentos ---
  const pagamentosValidos = (payments || []).filter((p) => tPagDoPagamento(p) && Number(p.valor) > 0);
  const totalPagoCent = pagamentosValidos.reduce((acc, p) => acc + cent(p.valor), 0);
  if (pagamentosValidos.length === 0) throw new Error('A venda não tem pagamento registrado para a nota.');
  if (totalPagoCent < vNFCent) {
    throw new Error(`Os pagamentos (R$ ${fmtCent(totalPagoCent)}) somam menos que o total da nota (R$ ${fmtCent(vNFCent)}).`);
  }
  const trocoCent = totalPagoCent - vNFCent;
  const detPagBlocos = pagamentosValidos.map((p) => {
    const tPag = tPagDoPagamento(p);
    return `<detPag>
      <tPag>${tPag}</tPag>
      ${tPag === '99' ? '<xPag>Outros</xPag>' : ''}
      <vPag>${fmtCent(cent(p.valor))}</vPag>
      ${montarCard(p, tPag)}
    </detPag>`;
  }).join('');
  const pag = `<pag>${detPagBlocos}${trocoCent > 0 ? `<vTroco>${fmtCent(trocoCent)}</vTroco>` : ''}</pag>`;

  // --- Responsável técnico (NT 2018.005) ---
  const cnpjResp = String(respTec?.cnpj || '').replace(/\D/g, '');
  const infRespTec = cnpjResp.length === 14
    ? `<infRespTec>
        <CNPJ>${cnpjResp}</CNPJ>
        <xContato>${textoXml(respTec.contato, 60)}</xContato>
        <email>${textoXml(respTec.email, 60)}</email>
        <fone>${escapeXml(String(respTec.fone || '').replace(/\D/g, '').slice(0, 14))}</fone>
      </infRespTec>`
    : '';

  if (avisos.includes('PIS/COFINS')) {
    avisos.splice(avisos.indexOf('PIS/COFINS'), 1, 'Regime normal: PIS/COFINS saem como CST 07; confirme a alíquota com o contador.');
  }

  const infNFeId = `NFe${chaveAcesso}`;
  const xml = compactarXml(`<NFe xmlns="${XMLNS_NFE}">
  <infNFe Id="${infNFeId}" versao="${VERSAO_LAYOUT}">
    ${ide}
    ${emit}
    ${detBlocos}
    ${total}
    <transp><modFrete>9</modFrete></transp>
    ${pag}
    ${infRespTec}
  </infNFe>
</NFe>`);

  return {
    xml, chaveAcesso, codigoNumerico: cNF, infNFeId, avisos,
    vNF: fmtCent(vNFCent), dhEmi, tpAmb,
  };
}

/**
 * Acrescenta o <infNFeSupl> (QR Code e endereço de consulta por chave) ao XML
 * JÁ ASSINADO: ele fica entre </infNFe> e <Signature> (ordem do schema) e não
 * entra na assinatura, que cobre só o infNFe. `qrCode` é a URL completa.
 */
function inserirInfNFeSupl(xmlAssinado, { qrCode, urlChave }) {
  if (!qrCode || !urlChave) throw new Error('QR Code e endereço de consulta por chave são obrigatórios na NFC-e.');
  const supl = `<infNFeSupl><qrCode><![CDATA[${qrCode}]]></qrCode><urlChave>${escapeXml(urlChave)}</urlChave></infNFeSupl>`;
  const xml = String(xmlAssinado).replace(/<infNFeSupl>[\s\S]*?<\/infNFeSupl>/, '');
  const pos = xml.indexOf('</infNFe>');
  if (pos < 0) throw new Error('XML sem </infNFe>.');
  const fim = pos + '</infNFe>'.length;
  return xml.slice(0, fim) + supl + xml.slice(fim);
}

module.exports = {
  gerarXmlNFCe, inserirInfNFeSupl, crtDoRegime, TPAG_POR_METODO, CNPJ_CREDENCIADORA, DESCRICAO_HOMOLOGACAO,
  // Exportados também pra nfceEventoService.js/nfceInutilizacaoService.js e testes.
  escapeXml, fmtDataHora, dataDaEmissao, compactarXml, semDeclaracao, gtinValido, ratear, tPagDoPagamento, montarCard, fmtUnitario,
};
