const { DOMParser } = require('@xmldom/xmldom');
const { calcularDVChaveAcesso } = require('./nfceChaveService');

/**
 * Leitura do XML de uma NF-e de COMPRA (modelo 55, layout 4.00) -- o
 * arquivo que o fornecedor manda por e-mail. Aceita o XML "processado"
 * (<nfeProc>, com o protocolo de autorização da SEFAZ) e o XML só da nota
 * (<NFe>), que vem sem protocolo.
 *
 * Só lê; não grava nada. Função pura de propósito: os testes alimentam
 * XMLs de exemplo e conferem número a número.
 *
 * Os nomes das tags seguem o Manual de Orientação do Contribuinte (MOC);
 * a busca é por nome local, ignorando o namespace
 * (http://www.portalfiscal.inf.br/nfe), que nem todo emissor declara do
 * mesmo jeito.
 */

const TAMANHO_MAXIMO = 5 * 1024 * 1024; // NF-e com milhares de itens fica bem abaixo disso

function filhos(no, nome) {
  const lista = [];
  if (!no) return lista;
  for (let c = no.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && (c.localName || c.nodeName) === nome) lista.push(c);
  }
  return lista;
}

function filho(no, nome) {
  return filhos(no, nome)[0] || null;
}

/** Caminho de filhos diretos: caminho(det, 'prod', 'vProd'). */
function caminho(no, ...nomes) {
  let atual = no;
  for (const n of nomes) {
    atual = filho(atual, n);
    if (!atual) return null;
  }
  return atual;
}

/** Primeiro descendente com esse nome (busca em profundidade). */
function descendente(no, nome) {
  if (!no) return null;
  for (let c = no.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    if ((c.localName || c.nodeName) === nome) return c;
    const achou = descendente(c, nome);
    if (achou) return achou;
  }
  return null;
}

function texto(no) {
  return no ? String(no.textContent || '').trim() : '';
}

function txt(no, ...nomes) {
  return texto(caminho(no, ...nomes));
}

/** Número do XML da NF-e: sempre ponto decimal, sem milhar. Vazio = 0. */
function num(no, ...nomes) {
  const t = txt(no, ...nomes);
  if (!t) return 0;
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`Valor numérico inválido no XML: "${t}".`);
  return n;
}

function soDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

function chaveValida(chave) {
  if (!/^\d{44}$/.test(chave)) return false;
  return calcularDVChaveAcesso(chave.slice(0, 43)) === Number(chave[43]);
}

/** Soma um campo de imposto em qualquer grupo de ICMS do item
 * (ICMS00, ICMS10, ICMSSN201...). Nome exato: vICMSSTRet (ST retida
 * antes, já embutida no preço) NÃO casa com vICMSST. */
function somaNoGrupo(grupo, nome) {
  let total = 0;
  if (!grupo) return 0;
  for (let c = grupo.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    const alvo = filho(c, nome);
    if (alvo) total += Number(texto(alvo)) || 0;
  }
  return total;
}

function endereco(no) {
  if (!no) return null;
  return {
    logradouro: txt(no, 'xLgr'), numero: txt(no, 'nro'), complemento: txt(no, 'xCpl'),
    bairro: txt(no, 'xBairro'), municipio: txt(no, 'xMun'), codigoMunicipio: txt(no, 'cMun'),
    uf: txt(no, 'UF'), cep: txt(no, 'CEP'), telefone: txt(no, 'fone'),
  };
}

/**
 * @returns {{ok: true, nota: object, avisos: string[]} | {ok: false, error: string}}
 */
function parseNFeXml(xml) {
  const conteudo = String(xml || '').replace(/^﻿/, '');
  if (!conteudo.trim()) return { ok: false, error: 'Arquivo vazio.' };
  if (Buffer.byteLength(conteudo, 'utf8') > TAMANHO_MAXIMO) return { ok: false, error: 'Arquivo grande demais para ser um XML de NF-e.' };
  // NF-e nunca tem DTD; recusar evita qualquer truque de entidade no parser.
  if (/<!DOCTYPE/i.test(conteudo)) return { ok: false, error: 'XML com DOCTYPE não é aceito.' };

  let doc;
  try {
    const erros = [];
    doc = new DOMParser({
      onError: (nivel, mensagem) => { if (nivel !== 'warning') erros.push(String(mensagem)); },
    }).parseFromString(conteudo, 'text/xml');
    if (erros.length) return { ok: false, error: `O arquivo não é um XML válido (${erros[0].split('\n')[0]}).` };
  } catch (err) {
    return { ok: false, error: `O arquivo não é um XML válido (${String(err.message || err).split('\n')[0]}).` };
  }

  const raiz = doc.documentElement;
  const infNFe = raiz && ((raiz.localName === 'infNFe' && raiz) || descendente(raiz, 'infNFe'));
  if (!infNFe) return { ok: false, error: 'Não encontrei uma NF-e neste XML (falta o grupo infNFe). Confira se é o XML da nota, e não o de um evento ou de uma NFS-e.' };

  try {
    const avisos = [];
    const ide = filho(infNFe, 'ide');
    const modelo = txt(ide, 'mod');
    if (modelo === '65') return { ok: false, error: 'Este XML é de uma NFC-e (cupom de venda ao consumidor), não de uma nota de compra (NF-e modelo 55).' };
    if (modelo && modelo !== '55') return { ok: false, error: `Modelo de documento ${modelo} não suportado — só NF-e modelo 55.` };

    const chave = soDigitos(infNFe.getAttribute('Id'));
    if (!chaveValida(chave)) return { ok: false, error: 'A chave de acesso desta nota é inválida (dígito verificador não confere). O arquivo pode estar corrompido.' };

    const versao = infNFe.getAttribute('versao') || '';
    if (versao && !versao.startsWith('4.')) avisos.push(`Layout ${versao} — esta leitura foi feita para o layout 4.00; confira os valores com atenção.`);

    const tpNF = txt(ide, 'tpNF');
    if (tpNF === '0') avisos.push('Esta nota está marcada como ENTRADA pelo emitente (tpNF = 0) — normalmente é nota de devolução ou emitida pela própria loja. Confira se é mesmo uma compra.');

    const emitNo = filho(infNFe, 'emit');
    const emitente = {
      cnpj: txt(emitNo, 'CNPJ'), cpf: txt(emitNo, 'CPF'),
      nome: txt(emitNo, 'xNome'), fantasia: txt(emitNo, 'xFant'), ie: txt(emitNo, 'IE'), crt: txt(emitNo, 'CRT'),
      endereco: endereco(filho(emitNo, 'enderEmit')),
    };
    if (!emitente.cnpj && !emitente.cpf) return { ok: false, error: 'A nota não identifica o emitente (fornecedor).' };

    const destNo = filho(infNFe, 'dest');
    const destinatario = destNo ? { cnpj: txt(destNo, 'CNPJ'), cpf: txt(destNo, 'CPF'), nome: txt(destNo, 'xNome') } : null;

    const itens = filhos(infNFe, 'det').map((det, i) => {
      const prod = filho(det, 'prod');
      const imposto = filho(det, 'imposto');
      const icms = filho(imposto, 'ICMS');
      const ean = txt(prod, 'cEAN');
      const eanTrib = txt(prod, 'cEANTrib');
      const lotes = filhos(prod, 'rastro').map((r) => ({
        lote: txt(r, 'nLote'), quantidade: num(r, 'qLote'), fabricacao: txt(r, 'dFab'), validade: txt(r, 'dVal'),
      }));
      const item = {
        nItem: Number(det.getAttribute('nItem')) || i + 1,
        codigo: txt(prod, 'cProd'),
        ean: /^\d{8,14}$/.test(ean) ? ean : '',          // "SEM GTIN" e vazio viram ''
        eanTributavel: /^\d{8,14}$/.test(eanTrib) ? eanTrib : '',
        descricao: txt(prod, 'xProd'),
        ncm: txt(prod, 'NCM'), cest: txt(prod, 'CEST'), cfop: txt(prod, 'CFOP'),
        unidade: txt(prod, 'uCom'), quantidade: num(prod, 'qCom'), valorUnitario: num(prod, 'vUnCom'),
        unidadeTributavel: txt(prod, 'uTrib'), quantidadeTributavel: num(prod, 'qTrib'),
        valorProduto: num(prod, 'vProd'),
        frete: num(prod, 'vFrete'), seguro: num(prod, 'vSeg'), desconto: num(prod, 'vDesc'), outros: num(prod, 'vOutro'),
        ipi: Number(txt(caminho(imposto, 'IPI', 'IPITrib'), 'vIPI')) || 0,
        icmsSt: somaNoGrupo(icms, 'vICMSST') + somaNoGrupo(icms, 'vFCPST'),
        lotes,
      };
      if (!item.descricao) throw new Error(`O item ${item.nItem} da nota está sem descrição.`);
      if (!(item.quantidade > 0)) throw new Error(`O item ${item.nItem} (${item.descricao}) está com quantidade zero.`);
      return item;
    });
    if (itens.length === 0) return { ok: false, error: 'A nota não tem nenhum item.' };

    const tot = caminho(infNFe, 'total', 'ICMSTot');
    const totais = {
      produtos: num(tot, 'vProd'), frete: num(tot, 'vFrete'), seguro: num(tot, 'vSeg'), desconto: num(tot, 'vDesc'),
      outros: num(tot, 'vOutro'), ipi: num(tot, 'vIPI'), icmsSt: num(tot, 'vST') + num(tot, 'vFCPST'), total: num(tot, 'vNF'),
    };

    const cobr = filho(infNFe, 'cobr');
    const duplicatas = filhos(cobr, 'dup').map((d, i) => ({
      numero: txt(d, 'nDup') || String(i + 1).padStart(3, '0'),
      vencimento: txt(d, 'dVenc'),
      valor: num(d, 'vDup'),
    })).filter((d) => d.valor > 0);
    for (const d of duplicatas) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.vencimento)) throw new Error(`Duplicata ${d.numero} sem data de vencimento válida.`);
    }

    // Protocolo de autorização (só existe no XML processado, <nfeProc>).
    const infProt = descendente(raiz, 'infProt');
    let autorizada = null;
    if (!infProt) {
      avisos.push('O XML não traz o protocolo de autorização da SEFAZ (é só a nota assinada). Confirme no portal da NF-e que ela foi autorizada.');
    } else {
      const cStat = txt(infProt, 'cStat');
      const chProt = txt(infProt, 'chNFe');
      autorizada = cStat === '100' || cStat === '150';
      if (!autorizada) avisos.push(`A SEFAZ não autorizou esta nota (situação ${cStat}: ${txt(infProt, 'xMotivo') || 'sem descrição'}).`);
      if (chProt && chProt !== chave) avisos.push('O protocolo de autorização é de outra chave — o arquivo pode ter sido editado.');
    }

    return {
      ok: true,
      avisos,
      nota: {
        chave, versao, modelo: modelo || '55',
        numero: txt(ide, 'nNF'), serie: txt(ide, 'serie'), emissao: txt(ide, 'dhEmi') || txt(ide, 'dEmi'),
        naturezaOperacao: txt(ide, 'natOp'), tipoOperacao: tpNF,
        emitente, destinatario, itens, totais, duplicatas, autorizada,
      },
    };
  } catch (err) {
    return { ok: false, error: `Não foi possível ler a nota: ${err.message}` };
  }
}

module.exports = { parseNFeXml, chaveValida, TAMANHO_MAXIMO };
