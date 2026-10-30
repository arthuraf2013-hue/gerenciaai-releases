const { montarChaveAcesso } = require('../../electron/services/nfceChaveService');

/**
 * XML de NF-e de compra (modelo 55, layout 4.00) montado para teste, no
 * formato real que o fornecedor manda (<nfeProc> com protocolo). A chave
 * tem dígito verificador válido; o resto é o mínimo que a leitura usa.
 *
 * itens: [{ codigo, ean, eanTrib, descricao, ncm, cfop, uCom, qCom, vUnCom, vProd,
 *           uTrib, qTrib, vFrete, vSeg, vDesc, vOutro, vIPI, vICMSST, vFCPST, vICMSSTRet, rastro: [{nLote, qLote, dFab, dVal}] }]
 */
function montarNfeXml({
  numero = 1234, serie = 1, cnpjEmitente = '11222333000181', nomeEmitente = 'DISTRIBUIDORA EXEMPLO LTDA',
  fantasia = 'Distribuidora Exemplo', foneEmitente = '8133334444', cnpjDestinatario = '44555666000199',
  itens, duplicatas = [], vNF, comProtocolo = true, cStat = '100', modelo = '55', tpNF = '1', chaveOverride,
} = {}) {
  const chave = chaveOverride || montarChaveAcesso({
    uf: 'PE', dataEmissao: new Date('2026-10-20T10:00:00-03:00'), cnpj: cnpjEmitente, modelo, serie, numero, codigoNumerico: '12345678',
  });
  const n = (v) => Number(v || 0).toFixed(2);
  let totProd = 0; let totFrete = 0; let totDesc = 0; let totIpi = 0; let totSt = 0; let totSeg = 0; let totOutro = 0;
  const dets = itens.map((it, i) => {
    totProd += it.vProd; totFrete += it.vFrete || 0; totDesc += it.vDesc || 0; totIpi += it.vIPI || 0;
    totSt += (it.vICMSST || 0); totSeg += it.vSeg || 0; totOutro += it.vOutro || 0;
    const rastro = (it.rastro || []).map((r) => `<rastro><nLote>${r.nLote}</nLote><qLote>${r.qLote}</qLote><dFab>${r.dFab}</dFab><dVal>${r.dVal}</dVal></rastro>`).join('');
    const icms = it.vICMSST || it.vFCPST
      ? `<ICMS><ICMSSN201><orig>0</orig><CSOSN>201</CSOSN><vBCST>10.00</vBCST><pICMSST>18.00</pICMSST><vICMSST>${n(it.vICMSST)}</vICMSST>${it.vFCPST ? `<vFCPST>${n(it.vFCPST)}</vFCPST>` : ''}</ICMSSN201></ICMS>`
      : it.vICMSSTRet
        ? `<ICMS><ICMSSN500><orig>0</orig><CSOSN>500</CSOSN><vBCSTRet>10.00</vBCSTRet><vICMSSTRet>${n(it.vICMSSTRet)}</vICMSSTRet></ICMSSN500></ICMS>`
        : '<ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>';
    const ipi = it.vIPI ? `<IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vBC>${n(it.vProd)}</vBC><pIPI>5.00</pIPI><vIPI>${n(it.vIPI)}</vIPI></IPITrib></IPI>` : '';
    return `<det nItem="${i + 1}"><prod><cProd>${it.codigo}</cProd><cEAN>${it.ean || 'SEM GTIN'}</cEAN><xProd>${it.descricao}</xProd>`
      + `<NCM>${it.ncm || '22021000'}</NCM><CFOP>${it.cfop || '5102'}</CFOP><uCom>${it.uCom || 'UN'}</uCom><qCom>${it.qCom}</qCom>`
      + `<vUnCom>${it.vUnCom}</vUnCom><vProd>${n(it.vProd)}</vProd><cEANTrib>${it.eanTrib || 'SEM GTIN'}</cEANTrib><uTrib>${it.uTrib || it.uCom || 'UN'}</uTrib>`
      + `<qTrib>${it.qTrib || it.qCom}</qTrib><vUnTrib>${it.vUnCom}</vUnTrib>`
      + `${it.vFrete ? `<vFrete>${n(it.vFrete)}</vFrete>` : ''}${it.vSeg ? `<vSeg>${n(it.vSeg)}</vSeg>` : ''}${it.vDesc ? `<vDesc>${n(it.vDesc)}</vDesc>` : ''}${it.vOutro ? `<vOutro>${n(it.vOutro)}</vOutro>` : ''}`
      + `<indTot>1</indTot>${rastro}</prod><imposto>${icms}${ipi}</imposto></det>`;
  }).join('');
  const total = vNF ?? (totProd + totFrete + totSeg + totOutro + totIpi + totSt - totDesc);
  const cobr = duplicatas.length
    ? `<cobr><fat><nFat>${numero}</nFat><vOrig>${n(total)}</vOrig><vLiq>${n(total)}</vLiq></fat>${duplicatas.map((d) => `<dup><nDup>${d.nDup}</nDup><dVenc>${d.dVenc}</dVenc><vDup>${n(d.vDup)}</vDup></dup>`).join('')}</cobr>`
    : '';
  const nfe = `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${chave}" versao="4.00">`
    + `<ide><cUF>26</cUF><cNF>12345678</cNF><natOp>VENDA DE MERCADORIA</natOp><mod>${modelo}</mod><serie>${serie}</serie><nNF>${numero}</nNF>`
    + `<dhEmi>2026-10-20T10:00:00-03:00</dhEmi><tpNF>${tpNF}</tpNF><idDest>1</idDest></ide>`
    + `<emit><CNPJ>${cnpjEmitente}</CNPJ><xNome>${nomeEmitente}</xNome><xFant>${fantasia}</xFant><enderEmit><xLgr>Rua A</xLgr><nro>10</nro><xBairro>Centro</xBairro>`
    + `<cMun>2611606</cMun><xMun>Recife</xMun><UF>PE</UF><CEP>50000000</CEP><fone>${foneEmitente}</fone></enderEmit><IE>123456789</IE><CRT>1</CRT></emit>`
    + `<dest><CNPJ>${cnpjDestinatario}</CNPJ><xNome>LOJA TESTE</xNome></dest>`
    + dets
    + `<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vST>${n(totSt)}</vST><vProd>${n(totProd)}</vProd><vFrete>${n(totFrete)}</vFrete><vSeg>${n(totSeg)}</vSeg>`
    + `<vDesc>${n(totDesc)}</vDesc><vIPI>${n(totIpi)}</vIPI><vOutro>${n(totOutro)}</vOutro><vNF>${n(total)}</vNF></ICMSTot></total>`
    + `<transp><modFrete>0</modFrete></transp>${cobr}<pag><detPag><tPag>15</tPag><vPag>${n(total)}</vPag></detPag></pag>`
    + '</infNFe></NFe>';
  const xml = comProtocolo
    ? `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">${nfe}`
      + `<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${chave}</chNFe><dhRecbto>2026-10-20T10:01:00-03:00</dhRecbto>`
      + `<nProt>126260000000001</nProt><cStat>${cStat}</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></nfeProc>`
    : `<?xml version="1.0" encoding="UTF-8"?>${nfe}`;
  return { xml, chave };
}

module.exports = { montarNfeXml };
