const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');

const xmlService = require('../electron/services/nfceXmlService');
const qr = require('../electron/services/nfceQrCodeService');
const { assinarXmlNFCe, assinarTexto } = require('../electron/services/nfceSignatureService');
const transmissao = require('../electron/services/nfceTransmissionService');

// Auditoria da integração com a SEFAZ (nov/2026): cada teste aqui é uma
// rejeição real que a versão anterior do XML provocava.

let certificadoCache = null;
function certificadoDeTeste() {
  if (certificadoCache) return certificadoCache;
  const chaves = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = chaves.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000 * 365);
  const attrs = [{ name: 'commonName', value: 'EMPRESA TESTE:00000000000191' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(chaves.privateKey, forge.md.sha256.create());
  certificadoCache = {
    chavePrivadaPem: forge.pki.privateKeyToPem(chaves.privateKey),
    certificadoPem: forge.pki.certificateToPem(cert),
  };
  return certificadoCache;
}

const CONFIG = {
  uf: 'PE', cnpj: '00000000000191', razao_social: 'Empresa Teste Ltda', nome_fantasia: 'Teste',
  inscricao_estadual: '0000000-00', regime_tributario: 'simples_nacional', municipio_codigo_ibge: '2611606',
  ambiente: 'homologacao', serie_nfce: '1',
  endereco: { logradouro: 'Rua A', numero: '10', bairro: 'Boa Vista', cep: '50000-000', municipio: 'Recife' },
};

function item(over = {}) {
  return {
    product_id: 'p1', sku: 'SKU1', nome: 'Café   coado', codigo_barras: null, ncm: '21011110', cfop: '5102',
    cst_csosn: '102', origem_mercadoria: '0', unidade: 'UN', quantidade: 1, preco_unitario: 10, cancelado: 0, ...over,
  };
}

function gerar(over = {}) {
  return xmlService.gerarXmlNFCe({
    config: CONFIG, numero: 7, dataEmissao: new Date('2026-11-06T15:00:00Z'),
    sale: { desconto: 0, desconto_gerente: 0, taxa_servico_percentual: 0 },
    items: [item()], payments: [{ metodo: 'dinheiro', valor: 10, detalhes: '{}' }],
    ...over,
  });
}

const tags = (xml, nome) => [...xml.matchAll(new RegExp(`<${nome}>([^<]*)</${nome}>`, 'g'))].map((m) => m[1]);
const soma = (lista) => lista.reduce((a, v) => a + Math.round(Number(v) * 100), 0);

test('XML compacto, sem declaração nem comentário (rejeição 588)', () => {
  const { xml } = gerar({ items: [item({ cst_csosn: '900' })] });
  assert.doesNotMatch(xml, />\s+</);
  assert.doesNotMatch(xml, /<!--/);
  assert.doesNotMatch(xml, /<\?xml/);
  assert.match(xml, /^<NFe xmlns="http:\/\/www\.portalfiscal\.inf\.br\/nfe"><infNFe Id="NFe\d{44}" versao="4\.00">/);
});

test('o aviso de revisão sai em `avisos`, não dentro do XML', () => {
  const { avisos } = gerar({ items: [item({ cst_csosn: '900' })] });
  assert.ok(avisos.some((a) => /CSOSN 900/.test(a)));
});

test('homologação: primeiro item com a descrição exigida (373); produção mantém o nome', () => {
  const { xml } = gerar({ items: [item(), item({ product_id: 'p2', nome: 'Pão' })], payments: [{ metodo: 'dinheiro', valor: 20 }] });
  assert.deepEqual(tags(xml, 'xProd'), [xmlService.DESCRICAO_HOMOLOGACAO, 'Pão']);
  const prod = xmlService.gerarXmlNFCe({
    config: { ...CONFIG, ambiente: 'producao' }, numero: 1, sale: {}, items: [item()], payments: [{ metodo: 'pix', valor: 10 }],
  });
  assert.deepEqual(tags(prod.xml, 'xProd'), ['Café coado']);
  assert.match(prod.xml, /<tpAmb>1<\/tpAmb>/);
});

test('desconto rateado nos itens: soma dos vDesc = total (536) e vNF fecha', () => {
  const { xml, vNF } = gerar({
    sale: { desconto: 1, desconto_gerente: 0.33, taxa_servico_percentual: 0 },
    items: [item({ preco_unitario: 3.33, quantidade: 3 }), item({ product_id: 'p2', preco_unitario: 7.01 }), item({ product_id: 'p3', preco_unitario: 0.99 })],
    payments: [{ metodo: 'dinheiro', valor: 50 }],
  });
  const descItens = [...xml.matchAll(/<prod>[\s\S]*?<\/prod>/g)].map((m) => (m[0].match(/<vDesc>([^<]*)<\/vDesc>/) || [])[1] || '0');
  const vDescTotal = xml.match(/<ICMSTot>[\s\S]*<vDesc>([^<]*)<\/vDesc>/)[1];
  assert.equal(soma(descItens), soma([vDescTotal]));
  assert.equal(vDescTotal, '1.33');
  const vProd = xml.match(/<ICMSTot>[\s\S]*?<vProd>([^<]*)<\/vProd>/)[1];
  assert.equal(soma([vProd]) - 133, soma([vNF]));
  assert.equal(xml.match(/<vTroco>([^<]*)<\/vTroco>/)[1], (50 - Number(vNF)).toFixed(2));
});

test('taxa de serviço entra como vOutro rateado e não vira troco', () => {
  const { xml, vNF } = gerar({
    sale: { desconto: 0, desconto_gerente: 0, taxa_servico_percentual: 10 },
    items: [item({ preco_unitario: 25 }), item({ product_id: 'p2', preco_unitario: 12.5 })],
    payments: [{ metodo: 'cartao_debito', valor: 41.25 }],
  });
  assert.equal(vNF, '41.25');
  const outrosItens = [...xml.matchAll(/<prod>[\s\S]*?<\/prod>/g)].map((m) => (m[0].match(/<vOutro>([^<]*)<\/vOutro>/) || [])[1] || '0');
  assert.equal(soma(outrosItens), 375);
  assert.match(xml, /<ICMSTot>[\s\S]*<vOutro>3\.75<\/vOutro><vNF>41\.25<\/vNF>/);
  assert.doesNotMatch(xml, /<vTroco>/);
});

test('pagamentos abaixo do total da nota não geram XML (865)', () => {
  assert.throws(() => gerar({ payments: [{ metodo: 'dinheiro', valor: 9.98 }] }), /somam menos/);
});

test('GTIN: só código válido e fora da faixa interna (611); senão SEM GTIN', () => {
  // DV calculado: 789100031550 -> 7
  assert.equal(xmlService.gtinValido('7891000315507'), true);
  assert.equal(xmlService.gtinValido('7891000315508'), false);
  assert.equal(xmlService.gtinValido('2900001000013'), false); // interno (balança/app)
  assert.equal(xmlService.gtinValido('abc'), false);
  const { xml } = gerar({ items: [item({ codigo_barras: '2900001000013' })] });
  assert.deepEqual(tags(xml, 'cEAN'), ['SEM GTIN']);
  const ok = gerar({ items: [item({ codigo_barras: '7891000315507' })] });
  assert.deepEqual(tags(ok.xml, 'cEAN'), ['7891000315507']);
  assert.deepEqual(tags(ok.xml, 'cEANTrib'), ['7891000315507']);
});

test('ICMS do Simples: 102/103/300/400 usam o grupo ICMSSN102; 500 o ICMSSN500', () => {
  for (const c of ['102', '103', '300', '400']) {
    const { xml } = gerar({ items: [item({ cst_csosn: c })] });
    assert.match(xml, new RegExp(`<ICMS><ICMSSN102><orig>0</orig><CSOSN>${c}</CSOSN></ICMSSN102></ICMS>`));
  }
  assert.match(gerar({ items: [item({ cst_csosn: '500' })] }).xml, /<ICMSSN500><orig>0<\/orig><CSOSN>500<\/CSOSN><\/ICMSSN500>/);
  const normal = xmlService.gerarXmlNFCe({
    config: { ...CONFIG, regime_tributario: 'lucro_presumido' }, numero: 1, sale: {}, items: [item({ cst_csosn: '41' })], payments: [{ metodo: 'dinheiro', valor: 10 }],
  });
  assert.match(normal.xml, /<ICMS40><orig>0<\/orig><CST>41<\/CST><\/ICMS40>/);
});

test('cartão sem integração: <card> com tpIntegra 2 (391)', () => {
  const { xml } = gerar({ payments: [{ metodo: 'cartao_credito', valor: 10, detalhes: '{}' }] });
  assert.match(xml, /<detPag><tPag>03<\/tPag><vPag>10\.00<\/vPag><card><tpIntegra>2<\/tpIntegra><\/card><\/detPag>/);
});

test('cartão da maquininha integrada: tpIntegra 1 + CNPJ da credenciadora + bandeira + autorização (392)', () => {
  const detalhes = JSON.stringify({ maquininha: { provedor: 'mercadopago_point', bandeira: 'master', autorizacao: 'A1B2C3' } });
  const { xml } = gerar({ payments: [{ metodo: 'cartao_debito', valor: 10, detalhes }] });
  assert.match(xml, /<card><tpIntegra>1<\/tpIntegra><CNPJ>10573521000191<\/CNPJ><tBand>02<\/tBand><cAut>A1B2C3<\/cAut><\/card>/);
});

test('Pix: QR fixo é estático (20, sem card); Pix automático é dinâmico (17, com card)', () => {
  const fixo = gerar({ payments: [{ metodo: 'pix', valor: 10, detalhes: '{}' }] }).xml;
  assert.match(fixo, /<tPag>20<\/tPag><vPag>10\.00<\/vPag><\/detPag>/);
  assert.doesNotMatch(fixo, /<card>/);
  const auto = gerar({ payments: [{ metodo: 'pix', valor: 10, detalhes: JSON.stringify({ pixAutomatico: { provedor: 'mercadopago', cobranca: '123456789' } }) }] }).xml;
  assert.match(auto, /<tPag>17<\/tPag><vPag>10\.00<\/vPag><card><tpIntegra>1<\/tpIntegra><CNPJ>10573521000191<\/CNPJ><cAut>123456789<\/cAut><\/card>/);
});

test('outros pagamentos: 99 com xPag; fiado 91', () => {
  const { xml } = gerar({ payments: [{ metodo: 'outro', valor: 5 }, { metodo: 'fiado', valor: 5 }] });
  assert.match(xml, /<detPag><tPag>99<\/tPag><xPag>Outros<\/xPag><vPag>5\.00<\/vPag><\/detPag><detPag><tPag>91<\/tPag><vPag>5\.00<\/vPag><\/detPag>/);
});

test('responsável técnico: grupo no fim do infNFe quando há CNPJ (972)', () => {
  const sem = gerar().xml;
  assert.doesNotMatch(sem, /infRespTec/);
  const com = gerar({ respTec: { cnpj: '11.222.333/0001-81', contato: 'Fulano', email: 'a@b.com', fone: '(81) 99999-0000' } }).xml;
  assert.match(com, /<\/pag><infRespTec><CNPJ>11222333000181<\/CNPJ><xContato>Fulano<\/xContato><email>a@b\.com<\/email><fone>81999990000<\/fone><\/infRespTec><\/infNFe>/);
});

test('chave: AAMM no fuso da UF (mesmo da dhEmi) e cNF diferente do nNF', () => {
  // 01/12 01:30 UTC = 30/11 22:30 em Recife
  const { xml, chaveAcesso } = gerar({ dataEmissao: new Date('2026-12-01T01:30:00Z') });
  assert.equal(chaveAcesso.slice(2, 6), '2611');
  assert.match(xml, /<dhEmi>2026-11-30T22:30:00-03:00<\/dhEmi>/);
  assert.notEqual(tags(xml, 'cNF')[0], '00000007');
  assert.equal(chaveAcesso.slice(35, 43), tags(xml, 'cNF')[0]);
});

test('preço unitário com 3 casas não é arredondado (629)', () => {
  const { xml } = gerar({ items: [item({ unidade: 'KG', quantidade: 0.355, preco_unitario: 39.995 })], payments: [{ metodo: 'dinheiro', valor: 20 }] });
  assert.deepEqual(tags(xml, 'vUnCom'), ['39.995']);
  assert.deepEqual(tags(xml, 'qCom'), ['0.3550']);
  assert.deepEqual(tags(xml, 'vProd').slice(0, 1), ['14.20']);
});

test('assinatura + infNFeSupl: ordem infNFe → infNFeSupl → Signature e assinatura válida', () => {
  const cert = certificadoDeTeste();
  const { xml, chaveAcesso } = gerar();
  const assinado = assinarXmlNFCe(xml, cert);
  const conteudo = qr.montarConteudoQrCode({ chaveAcesso, ambiente: 'homologacao' });
  const final = xmlService.inserirInfNFeSupl(assinado, {
    qrCode: qr.montarUrlQrCodeDeConteudo({ conteudo, urlConsulta: qr.urlQrCodeDaUf({ uf: 'PE', ambiente: 'homologacao' }) }),
    urlChave: qr.urlChaveDaUf({ uf: 'PE', ambiente: 'homologacao' }),
  });
  assert.match(final, /<\/infNFe><infNFeSupl><qrCode><!\[CDATA\[http:\/\/nfcehomolog\.sefaz\.pe\.gov\.br\/nfce\/consulta\?p=\d{44}\|3\|2\]\]><\/qrCode><urlChave>nfce\.sefaz\.pe\.gov\.br\/nfce\/consulta<\/urlChave><\/infNFeSupl><Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">/);
  assert.doesNotMatch(final, />\s+</);

  const doc = new DOMParser().parseFromString(final, 'text/xml');
  const sig = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
  const verificador = new SignedXml({ publicCert: cert.certificadoPem });
  verificador.loadSignature(sig);
  assert.equal(verificador.checkSignature(final), true);
  assert.match(final, /<Reference URI="#NFe\d{44}">/);
});

test('QR Code v3 da contingência: parâmetros e assinatura RSA-SHA1 conferem (583)', () => {
  const cert = certificadoDeTeste();
  const chave = '26261100000000019165001000000007912345678'.padEnd(44, '0');
  const conteudo = qr.montarConteudoQrCodeContingencia({
    chaveAcesso: chave, ambiente: 'homologacao', dia: '06', vNF: '41.2', destinatario: '',
    assinar: (t) => assinarTexto(t, cert),
  });
  const partes = conteudo.split('|');
  assert.equal(partes.length, 8);
  assert.deepEqual(partes.slice(0, 7), [chave, '3', '2', '06', '41.20', '', '']);
  const assinado = partes.slice(0, 7).join('|');
  const pub = crypto.createPublicKey(cert.certificadoPem);
  assert.equal(crypto.verify('sha1', Buffer.from(assinado), pub, Buffer.from(partes[7], 'base64')), true);
  const comCpf = qr.montarConteudoQrCodeContingencia({
    chaveAcesso: chave, ambiente: 'producao', dia: '06', vNF: 10, destinatario: '123.456.789-09', assinar: (t) => assinarTexto(t, cert),
  });
  assert.deepEqual(comCpf.split('|').slice(1, 7), ['3', '1', '06', '10.00', '2', '12345678909']);
});

test('URLs de consulta: padrão de PE e a configurada pela loja vence', () => {
  assert.equal(qr.urlQrCodeDaUf({ uf: 'PE', ambiente: 'producao' }), 'http://nfce.sefaz.pe.gov.br/nfce/consulta');
  assert.equal(qr.urlChaveDaUf({ uf: 'PE', ambiente: 'producao' }), 'nfce.sefaz.pe.gov.br/nfce/consulta');
  assert.equal(qr.urlQrCodeDaUf({ uf: 'XX', ambiente: 'producao' }), null);
  assert.equal(qr.urlChaveDaUf({ uf: 'PE', ambiente: 'producao', urlConfigurada: ' outra/consulta ' }), 'outra/consulta');
});

test('envelope SOAP: documento sem declaração dentro e mensagem compacta', () => {
  const env = transmissao.montarEnvelopeAutorizacao('<?xml version="1.0" encoding="UTF-8"?><NFe xmlns="x"><a>1</a></NFe>', 12);
  assert.equal((env.match(/<\?xml/g) || []).length, 1);
  assert.ok(env.startsWith('<?xml'));
  assert.match(env, /<idLote>12<\/idLote><indSinc>1<\/indSinc><NFe xmlns="x">/);
  assert.doesNotMatch(env, />\s+</);
  assert.doesNotMatch(transmissao.montarEnvelopeEvento('<?xml version="1.0"?><envEvento/>'), /<nfeDadosMsg[^>]*><\?xml/);
});

test('resposta síncrona: vale o cStat da nota (100), não o do lote (104)', () => {
  const resposta = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4"><retEnviNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>2</tpAmb><cStat>104</cStat><xMotivo>Lote processado</xMotivo><protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><chNFe>${'1'.repeat(44)}</chNFe><nProt>126260000000001</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></retEnviNFe></nfeResultMsg></soap:Body></soap:Envelope>`;
  const r = transmissao.extrairResultado(resposta);
  assert.equal(r.cStat, '100');
  assert.equal(r.cStatLote, '104');
  assert.equal(r.protocoloAutorizacao, '126260000000001');
  const rejeitada = transmissao.extrairResultado(resposta.replace('<cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>', '<cStat>778</cStat><xMotivo>Rejeicao: NCM inexistente</xMotivo>'));
  assert.equal(rejeitada.cStat, '778');
  const lote = transmissao.extrairResultado('<retEnviNFe><cStat>225</cStat><xMotivo>Falha no Schema</xMotivo></retEnviNFe>');
  assert.equal(lote.cStat, '225');
  const evento = transmissao.extrairResultado('<retEnvEvento><cStat>128</cStat><xMotivo>Lote de evento processado</xMotivo><retEvento versao="1.00"><infEvento><cStat>135</cStat><xMotivo>Evento registrado</xMotivo><nProt>1</nProt></infEvento></retEvento></retEnvEvento>');
  assert.equal(evento.cStat, '135');
});

test('SOAP Fault é recusa da mensagem (não vira contingência)', () => {
  const fault = '<soap:Envelope><soap:Body><soap:Fault><soap:Code><soap:Value>soap:Sender</soap:Value></soap:Code><soap:Reason><soap:Text xml:lang="en">Mensagem invalida</soap:Text></soap:Reason></soap:Fault></soap:Body></soap:Envelope>';
  assert.equal(transmissao.motivoDoSoapFault(fault), 'Mensagem invalida');
  assert.equal(transmissao.motivoDoSoapFault('<retEnviNFe/>'), null);
});
