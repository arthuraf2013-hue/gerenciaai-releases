// Layout da NOTA (recibo da venda) e da PRÉ-NOTA (conferência da conta antes
// de pagar), montado a partir da configuração do Estúdio de impressão.
//
// Função pura: recebe os dados prontos e devolve o HTML. A mesma função
// gera a impressão e a prévia do estúdio, então o que se vê no estúdio é o
// que sai na impressora.
//
// Partes FIXAS, que o estúdio não tira:
// - pré-nota: "NÃO É DOCUMENTO FISCAL" (pré-conta não pode se passar por
//   cupom fiscal);
// - nota: bloco da NFC-e (chave, protocolo, QR) quando a venda tem NFC-e, e a
//   senha do balcão quando existe.
// Todo texto vindo de cadastro passa por escHtml; imagem só PNG/JPEG em data URL.

const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const soImagemRaster = (v) => (typeof v === 'string' && v.length <= LOGO_MAX_CARACTERES
  && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : '');
const dinheiro = (v) => `R$ ${(Number(v) || 0).toFixed(2).replace('.', ',')}`;
const arred = (v) => Math.round((Number(v) || 0) * 100) / 100;
const NOME_DO_METODO = { dinheiro: 'Dinheiro', cartao_credito: 'Cartão de crédito', cartao_debito: 'Cartão de débito', pix: 'Pix', fiado: 'Fiado', outro: 'Outro' };
const nomeDoMetodo = (m) => NOME_DO_METODO[m] || m;

// ~300 KB de imagem (base64). O estúdio reduz a imagem antes de enviar.
const LOGO_MAX_CARACTERES = 420000;

const BASE = {
  logo: '',
  logoLarguraPct: 60,
  logoPretoBranco: true,
  mostrarNomeLoja: true,
  nomeLoja: '',
  cabecalhoTexto: '',
  alinhamento: 'centro',
  fonte: 'mono',
  tamanho: 'normal',
  separador: 'tracejado',
  mostrarCodigoVenda: true,
  mostrarDataHora: true,
  mostrarCliente: true,
  colunaUnitario: true,
};

const PADRAO = {
  nota: {
    ...BASE,
    titulo: '',
    mostrarOperador: false,
    mostrarObservacoes: false,
    mostrarPagamentos: true,
  },
  prenota: {
    ...BASE,
    titulo: 'PRÉ-CONTA · CONFERÊNCIA',
    mostrarOperador: true,
    mostrarMesa: true,
    mostrarObservacoes: true,
    agruparPorPessoa: true,
    mostrarDivisao: false,
    taxaSugeridaPercentual: 0,
    pixQr: false,
    rodape: 'Confira os itens antes de pagar. Qualquer diferença, chame o atendente.',
  },
};

const TIPOS = Object.keys(PADRAO);
const ESCOLHAS = {
  alinhamento: ['centro', 'esquerda'],
  fonte: ['mono', 'sans'],
  tamanho: ['pequena', 'normal', 'grande'],
  separador: ['tracejado', 'continuo'],
};
const TEXTOS = { nomeLoja: 60, cabecalhoTexto: 400, titulo: 60, rodape: 300 };

/** Configuração completa e segura: só as chaves conhecidas, nos limites. */
function normalizarConfig(tipo, entrada) {
  if (!TIPOS.includes(tipo)) throw new Error('Tipo de impressão inválido.');
  const padrao = PADRAO[tipo];
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const c = {};
  for (const [chave, valorPadrao] of Object.entries(padrao)) {
    const v = e[chave];
    if (chave === 'logo') c.logo = soImagemRaster(v);
    else if (ESCOLHAS[chave]) c[chave] = ESCOLHAS[chave].includes(v) ? v : valorPadrao;
    else if (typeof valorPadrao === 'boolean') c[chave] = typeof v === 'boolean' ? v : valorPadrao;
    else if (chave === 'logoLarguraPct') c[chave] = Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(100, Math.max(20, Math.round(Number(v)))) : valorPadrao;
    else if (chave === 'taxaSugeridaPercentual') c[chave] = Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(30, Math.max(0, arred(Number(v)))) : valorPadrao;
    else if (TEXTOS[chave]) c[chave] = typeof v === 'string' ? v.replace(/\r\n/g, '\n').slice(0, TEXTOS[chave]) : valorPadrao;
    else c[chave] = valorPadrao;
  }
  return c;
}

function medidas(larguraMm, tamanho) {
  const isTermica = larguraMm === 58 || larguraMm === 80;
  const base = larguraMm === 58 ? 10 : isTermica ? 11 : 12;
  const fonte = base + ({ pequena: -1, normal: 0, grande: 2 }[tamanho] || 0);
  return { isTermica, fonte, larguraCss: isTermica ? `${larguraMm}mm` : '190mm' };
}

function estilo(config, larguraMm) {
  const { isTermica, fonte, larguraCss } = medidas(larguraMm, config.tamanho);
  const familia = config.fonte === 'sans' ? "Arial, Helvetica, sans-serif" : "'Courier New', monospace";
  const linha = config.separador === 'continuo' ? 'solid' : 'dashed';
  return `
    @page { size: ${isTermica ? `${larguraMm}mm auto` : 'A4'}; margin: ${isTermica ? '2mm' : '15mm'}; }
    body { font-family: ${familia}; font-size: ${fonte}px; width: ${larguraCss}; margin: 0 auto; padding: ${isTermica ? '4px' : '16px'}; color: #000; background: #fff; }
    h1 { font-size: ${fonte + 2}px; margin: 0 0 4px; }
    .cab { text-align: ${config.alinhamento === 'esquerda' ? 'left' : 'center'}; }
    .cab p { margin: 0; white-space: pre-line; }
    .logo { display: block; max-width: ${config.logoLarguraPct}%; height: auto; margin: 0 ${config.alinhamento === 'esquerda' ? 'auto 6px 0' : 'auto 6px'}; ${config.logoPretoBranco ? 'filter: grayscale(1) contrast(1.4);' : ''} }
    .center { text-align: center; }
    .titulo { text-align: center; font-weight: bold; font-size: ${fonte + 1}px; margin: 6px 0 2px; letter-spacing: .5px; }
    .info { margin: 2px 0; }
    table { width: 100%; border-collapse: collapse; margin: 6px 0; }
    th, td { padding: 2px 0; font-size: ${fonte - 1}px; vertical-align: top; }
    th { text-align: right; } th:first-child { text-align: left; }
    td.n { text-align: right; white-space: nowrap; padding-left: 4px; }
    .obs { font-size: ${fonte - 2}px; padding-left: 8px; }
    .pessoa { font-weight: bold; margin: 8px 0 0; }
    .sub { display: flex; justify-content: space-between; gap: 6px; }
    hr { border: none; border-top: 1px ${linha} #000; margin: 6px 0; }
    .total { font-size: ${fonte + 2}px; font-weight: bold; display: flex; justify-content: space-between; margin-top: 4px; }
    .aviso { text-align: center; font-weight: bold; border: 1px solid #000; padding: 3px; margin: 6px 0; font-size: ${fonte - 1}px; }
    .pequeno { font-size: ${fonte - 2}px; }
    .pix img { width: 130px; height: 130px; }
    .pix p { word-break: break-all; }`;
}

function cabecalho(config, loja) {
  const nome = (config.nomeLoja || '').trim() || loja?.nome || '';
  const logo = soImagemRaster(config.logo);
  return `<div class="cab">
    ${logo ? `<img class="logo" src="${logo}" alt="">` : ''}
    ${config.mostrarNomeLoja && nome ? `<h1>${escHtml(nome)}</h1>` : ''}
    ${config.cabecalhoTexto ? `<p>${escHtml(config.cabecalhoTexto)}</p>` : ''}
  </div>`;
}

function dataHoraBR(textoUtc) {
  if (!textoUtc) return '';
  const d = new Date(`${String(textoUtc).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function linhasDeInfo(config, venda, { rotuloCodigo, dataUtc, extra = [] }) {
  const partes = [];
  if (config.mostrarCodigoVenda && venda?.id) partes.push(`${rotuloCodigo} ${escHtml(String(venda.id).slice(0, 8))}`);
  if (config.mostrarDataHora && dataUtc) partes.push(escHtml(dataHoraBR(dataUtc)));
  const linhas = [partes.join(' — ')].filter(Boolean);
  for (const [rotulo, valor] of extra) if (valor) linhas.push(`${rotulo}: ${escHtml(valor)}`);
  return linhas.map((l) => `<p class="info center">${l}</p>`).join('');
}

function tabelaItens(config, itens) {
  const cabec = `<thead><tr><th>Item</th><th>Qtd</th>${config.colunaUnitario ? '<th>Unit.</th>' : ''}<th>Total</th></tr></thead>`;
  const linhas = itens.map((i) => `
    <tr><td>${escHtml(i.nome)}</td><td class="n">${escHtml(i.quantidade)}</td>${config.colunaUnitario ? `<td class="n">${dinheiro(i.precoUnitario)}</td>` : ''}<td class="n">${dinheiro(i.precoUnitario * i.quantidade)}</td></tr>
    ${config.mostrarObservacoes && i.observacao ? `<tr><td class="obs" colspan="${config.colunaUnitario ? 4 : 3}">↳ ${escHtml(i.observacao)}</td></tr>` : ''}`).join('');
  return `<table>${cabec}<tbody>${linhas}</tbody></table>`;
}

const soma = (itens) => itens.reduce((acc, i) => acc + i.precoUnitario * i.quantidade, 0);

/** Valores da conta, iguais aos do PaymentPanel / contaPorPessoa.js. */
function contaDe({ subtotalItens, desconto, taxaServicoPercentual }) {
  const base = Math.max(0, subtotalItens - desconto);
  const taxa = taxaServicoPercentual > 0 ? base * (taxaServicoPercentual / 100) : 0;
  return { base, taxa, total: base + taxa };
}

/**
 * NOTA — recibo de uma venda finalizada.
 * dados: { venda, itens[{nome,quantidade,precoUnitario,observacao}], pagamentos[{metodo,valor}],
 *          loja, larguraMm, rodape, operador, cliente, fiscalHtml, senha{numero,nome},
 *          ajustadoManualmente, totalFinal, descontoFidelidade, descontoGerente, taxaServicoValor, taxaServicoPercentual }
 */
function montarNota(config, dados) {
  const c = normalizarConfig('nota', config);
  const { fonte } = medidas(dados.larguraMm, c.tamanho);
  const senha = dados.senha
    ? `<div class="center" style="border:2px solid #000;padding:4px;margin-bottom:6px;"><div>SUA SENHA</div><div style="font-size:${fonte * 3}px;font-weight:bold;line-height:1.1;">${escHtml(dados.senha.numero)}</div>${dados.senha.nome ? `<div>${escHtml(dados.senha.nome)}</div>` : ''}<div class="pequeno">Aguarde ser chamado no painel</div></div>`
    : '';
  const extra = [];
  if (c.mostrarOperador) extra.push(['Atendente', dados.operador]);
  if (c.mostrarCliente) extra.push(['Cliente', dados.cliente]);
  return `<!doctype html>
  <html><head><meta charset="utf-8"><style>${estilo(c, dados.larguraMm)}</style></head>
  <body>
    ${senha}
    ${cabecalho(c, dados.loja)}
    ${c.titulo ? `<p class="titulo">${escHtml(c.titulo)}</p>` : ''}
    ${linhasDeInfo(c, dados.venda, { rotuloCodigo: 'Venda', dataUtc: dados.venda?.finalizada_em, extra })}
    <hr>
    ${tabelaItens(c, dados.itens)}
    <hr>
    ${dados.descontoFidelidade > 0 ? `<div class="sub"><span>Desconto fidelidade</span><span>-${dinheiro(dados.descontoFidelidade)}</span></div>` : ''}
    ${dados.descontoGerente > 0 ? `<div class="sub"><span>Desconto autorizado</span><span>-${dinheiro(dados.descontoGerente)}</span></div>` : ''}
    ${dados.taxaServicoPercentual > 0 ? `<div class="sub"><span>Taxa de serviço (${escHtml(dados.taxaServicoPercentual)}%)</span><span>${dinheiro(dados.taxaServicoValor)}</span></div>` : ''}
    <div class="total"><span>Total</span><span>${dinheiro(dados.totalFinal)}</span></div>
    ${dados.ajustadoManualmente ? '<div class="pequeno" style="text-align:right">(valor ajustado manualmente após a venda)</div>' : ''}
    ${c.mostrarPagamentos && dados.pagamentos?.length ? `<hr>${dados.pagamentos.map((p) => `<div class="sub"><span>${escHtml(nomeDoMetodo(p.metodo))}</span><span>${dinheiro(p.valor)}</span></div>`).join('')}` : ''}
    ${dados.fiscalHtml || ''}
    <hr>
    <p class="center">${escHtml(dados.rodape || 'Obrigado pela preferência!')}</p>
  </body></html>`;
}

/**
 * PRÉ-NOTA — conferência da conta aberta (balcão ou mesa), antes de pagar.
 * dados: { venda, itens[{nome,quantidade,precoUnitario,observacao,pessoaNumero}], pessoas[{numero,nome}],
 *          pagoPorPessoa{n:valor}, totalPago, desconto, taxaServicoPercentual, loja, larguraMm,
 *          operador, cliente, mesa, qtdPessoasMesa, pessoaNumero (só a parte dessa pessoa),
 *          pix: { qrDataUrl, copiaCola } | null, agoraUtc }
 */
/**
 * Valores da pré-nota (conta inteira ou a parte de uma pessoa), na mesma
 * conta do PaymentPanel / contaPorPessoa.js: itens − desconto + taxa; a parte
 * da pessoa leva desconto e taxa na proporção do que ela consumiu.
 */
function valoresDaPreNota(dados) {
  const todos = dados.itens || [];
  const subtotalItens = soma(todos);
  const desconto = Number(dados.desconto) || 0;
  const taxaPct = Number(dados.taxaServicoPercentual) || 0;
  const conta = contaDe({ subtotalItens, desconto, taxaServicoPercentual: taxaPct });
  const soUma = Number.isInteger(dados.pessoaNumero) && dados.pessoaNumero > 0 ? dados.pessoaNumero : null;
  const itens = soUma ? todos.filter((i) => i.pessoaNumero === soUma) : todos;
  const fator = subtotalItens > 0 ? conta.total / subtotalItens : 0;
  const parcial = soUma ? soma(itens) : subtotalItens;
  const totalDoc = soUma ? arred(parcial * fator) : arred(conta.total);
  const pago = soUma ? (Number(dados.pagoPorPessoa?.[soUma]) || 0) : (Number(dados.totalPago) || 0);
  const falta = Math.max(0, arred(totalDoc - pago));
  return { todos, subtotalItens, desconto, taxaPct, conta, soUma, itens, fator, parcial, totalDoc, pago, falta };
}

function montarPreNota(config, dados) {
  const c = normalizarConfig('prenota', config);
  const { todos, subtotalItens, desconto, taxaPct, conta, soUma, itens, fator, parcial, totalDoc, pago, falta } = valoresDaPreNota(dados);
  const pessoas = dados.pessoas || [];
  const nomeDa = (n) => pessoas.find((p) => p.numero === n)?.nome || `Pessoa ${n}`; // igual à tela da mesa

  let corpo;
  const comPessoas = !soUma && c.agruparPorPessoa && pessoas.length > 0 && todos.some((i) => i.pessoaNumero);
  if (comPessoas) {
    const grupos = [];
    for (const p of pessoas) {
      const lista = todos.filter((i) => i.pessoaNumero === p.numero);
      if (lista.length) grupos.push({ rotulo: nomeDa(p.numero), lista, numero: p.numero });
    }
    const numeros = new Set(pessoas.map((p) => p.numero));
    const semPessoa = todos.filter((i) => !i.pessoaNumero || !numeros.has(i.pessoaNumero));
    if (semPessoa.length) grupos.push({ rotulo: 'Sem pessoa', lista: semPessoa, numero: null });
    corpo = grupos.map((g) => {
      const parte = arred(soma(g.lista) * fator);
      const pagoDela = g.numero ? (Number(dados.pagoPorPessoa?.[g.numero]) || 0) : 0;
      return `<p class="pessoa">${escHtml(g.rotulo)}</p>${tabelaItens(c, g.lista)}
        <div class="sub"><span>${g.numero ? `Parte de ${escHtml(g.rotulo)}` : 'Total sem pessoa'}${taxaPct > 0 ? ' (c/ serviço)' : ''}</span><span>${dinheiro(parte)}</span></div>
        ${pagoDela > 0.005 ? `<div class="sub pequeno"><span>Já pago</span><span>${dinheiro(pagoDela)}</span></div>` : ''}`;
    }).join('<hr>');
  } else {
    corpo = tabelaItens(c, itens);
  }

  const extra = [];
  if (c.mostrarMesa) extra.push(['Mesa', dados.mesa]);
  if (soUma) extra.push(['Conta de', nomeDa(soUma)]);
  if (c.mostrarOperador) extra.push(['Atendente', dados.operador]);
  if (c.mostrarCliente) extra.push(['Cliente', dados.cliente]);

  const valores = soUma
    ? `<div class="sub"><span>Itens de ${escHtml(nomeDa(soUma))}</span><span>${dinheiro(parcial)}</span></div>`
    : `<div class="sub"><span>Subtotal (${todos.reduce((a, i) => a + (Number(i.quantidade) || 0), 0)} itens)</span><span>${dinheiro(subtotalItens)}</span></div>
       ${desconto > 0 ? `<div class="sub"><span>Desconto</span><span>-${dinheiro(desconto)}</span></div>` : ''}
       ${taxaPct > 0 ? `<div class="sub"><span>Taxa de serviço (${escHtml(taxaPct)}%)</span><span>${dinheiro(conta.taxa)}</span></div>` : ''}`;

  // Sugestão de serviço quando a conta ainda não tem taxa.
  let sugestao = '';
  if (!soUma && !(taxaPct > 0) && c.taxaSugeridaPercentual > 0 && conta.base > 0) {
    const t = conta.base * (c.taxaSugeridaPercentual / 100);
    sugestao = `<div class="sub pequeno"><span>Serviço opcional (${escHtml(c.taxaSugeridaPercentual)}%)</span><span>${dinheiro(t)}</span></div>
      <div class="sub pequeno"><span>Total com serviço</span><span>${dinheiro(conta.base + t)}</span></div>`;
  }

  const divisao = !soUma && c.mostrarDivisao && Number(dados.qtdPessoasMesa) > 1
    ? `<div class="sub pequeno"><span>Dividido por ${escHtml(dados.qtdPessoasMesa)}</span><span>${dinheiro(totalDoc / Number(dados.qtdPessoasMesa))} cada</span></div>`
    : '';

  const pix = c.pixQr && dados.pix?.qrDataUrl && falta > 0
    ? `<hr><div class="center pix"><p><strong>Pague com Pix: ${dinheiro(falta)}</strong></p><img src="${soImagemRaster(dados.pix.qrDataUrl)}" alt="">
       ${dados.pix.copiaCola ? `<p class="pequeno">${escHtml(dados.pix.copiaCola)}</p>` : ''}</div>`
    : '';

  return `<!doctype html>
  <html><head><meta charset="utf-8"><style>${estilo(c, dados.larguraMm)}</style></head>
  <body>
    ${cabecalho(c, dados.loja)}
    ${c.titulo ? `<p class="titulo">${escHtml(c.titulo)}</p>` : ''}
    <p class="aviso">NÃO É DOCUMENTO FISCAL</p>
    ${linhasDeInfo(c, dados.venda, { rotuloCodigo: 'Conta', dataUtc: dados.agoraUtc, extra })}
    <hr>
    ${corpo}
    <hr>
    ${valores}
    <div class="total"><span>${soUma ? 'Total da parte' : 'Total'}</span><span>${dinheiro(totalDoc)}</span></div>
    ${pago > 0.005 ? `<div class="sub"><span>Já pago</span><span>${dinheiro(pago)}</span></div><div class="total"><span>Falta pagar</span><span>${dinheiro(falta)}</span></div>` : ''}
    ${sugestao}
    ${divisao}
    ${pix}
    <hr>
    ${c.rodape ? `<p class="center">${escHtml(c.rodape)}</p>` : ''}
    <p class="center pequeno">NÃO É DOCUMENTO FISCAL</p>
  </body></html>`;
}

/** Venda de exemplo para a prévia do estúdio (nada do banco). */
function exemplo(tipo, { larguraMm = 80, loja = { nome: 'Minha Loja' }, rodapeNota = '' } = {}) {
  const itens = [
    { nome: 'Feijoada completa', quantidade: 1, precoUnitario: 54.9, observacao: 'sem torresmo', pessoaNumero: 1 },
    { nome: 'Suco de laranja 500ml', quantidade: 2, precoUnitario: 9.5, observacao: '', pessoaNumero: 1 },
    { nome: 'Picanha na chapa', quantidade: 1, precoUnitario: 79.9, observacao: 'ao ponto', pessoaNumero: 2 },
    { nome: 'Refrigerante lata', quantidade: 1, precoUnitario: 6.5, observacao: '', pessoaNumero: 2 },
  ];
  const agora = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (tipo === 'nota') {
    const total = soma(itens);
    return {
      venda: { id: 'a1b2c3d4e5', finalizada_em: agora }, itens, larguraMm, loja,
      pagamentos: [{ metodo: 'pix', valor: arred(total) }], rodape: rodapeNota,
      operador: 'Carla', cliente: 'João Silva', fiscalHtml: '', senha: null,
      totalFinal: total, descontoFidelidade: 0, descontoGerente: 0, taxaServicoPercentual: 0, taxaServicoValor: 0,
    };
  }
  return {
    venda: { id: 'a1b2c3d4e5' }, itens, larguraMm, loja, agoraUtc: agora,
    pessoas: [{ numero: 1, nome: 'Ana' }, { numero: 2, nome: 'Bruno' }], pagoPorPessoa: {}, totalPago: 0,
    desconto: 0, taxaServicoPercentual: 10, operador: 'Carla', cliente: '', mesa: 'Mesa 7', qtdPessoasMesa: 2,
    pix: null,
  };
}

module.exports = { PADRAO, TIPOS, LOGO_MAX_CARACTERES, normalizarConfig, montarNota, montarPreNota, valoresDaPreNota, exemplo, escHtml };
