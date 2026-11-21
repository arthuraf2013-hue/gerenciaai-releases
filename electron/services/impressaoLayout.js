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
  // Hora em que cada item foi lançado (só em conta de mesa: no balcão é tudo na mesma hora).
  mostrarHoraItem: true,
};

const PADRAO = {
  nota: {
    ...BASE,
    titulo: '',
    mostrarOperador: false,
    mostrarMesa: true,
    mesaTamanho: 'grande',
    mesaNegrito: true,
    mostrarObservacoes: false,
    mostrarPagamentos: true,
  },
  prenota: {
    ...BASE,
    titulo: 'PRÉ-CONTA · CONFERÊNCIA',
    mostrarOperador: true,
    mostrarMesa: true,
    // Pré-nota já mostrava "Mesa: 7" na linha de informações; continua assim
    // até a loja escolher destacar.
    mesaTamanho: 'normal',
    mesaNegrito: false,
    mostrarObservacoes: true,
    agruparPorPessoa: true,
    mostrarDivisao: false,
    taxaSugeridaPercentual: 0,
    pixQr: false,
    rodape: 'Confira os itens antes de pagar. Qualquer diferença, chame o atendente.',
  },
};

// Comanda da cozinha (impressora da cozinha e prévia do estúdio). A mesa sai
// sempre que a comanda é de mesa; sem mesa, sai a senha ou "BALCÃO".
PADRAO.cozinha = {
  titulo: '',
  fonte: 'sans',
  tamanho: 'grande',
  separador: 'tracejado',
  mostrarDataHora: true,
  mostrarMesa: true,
  mesaTamanho: 'enorme',
  mesaNegrito: true,
  mostrarCliente: true,
  mostrarOperador: true,
  mostrarPessoa: true,
  mostrarObservacoes: true,
  mostrarValores: true,
  mostrarTotal: true,
  rodape: '',
};

// Display do QR de cada mesa (o cliente lê e cai na vitrine SÓ daquela mesa).
PADRAO.qrmesa = {
  papel: 'a4',
  orientacao: 'paisagem',
  porFolha: 6,
  cor: 'verde',
  logo: '',
  mostrarNomeLoja: true,
  nomeLoja: '',
  titulo: 'Peça por aqui',
  instrucao: 'Aponte a câmera do celular, escolha e informe seu nome.',
  rodape: '',
  linhaDeCorte: true,
};

const TIPOS = Object.keys(PADRAO);
const ESCOLHAS = {
  alinhamento: ['centro', 'esquerda'],
  fonte: ['mono', 'sans'],
  tamanho: ['pequena', 'normal', 'grande', 'extra', 'gigante'], // extra = muito grande; gigante = enorme (letra para vista cansada)
  separador: ['tracejado', 'continuo'],
  mesaTamanho: ['normal', 'grande', 'enorme'],
  papel: ['a4', 'carta', 'oficio', 'a6', 'termica'],
  orientacao: ['paisagem', 'retrato'],
  porFolha: [1, 2, 4, 6, 8, 9, 12, 16],
  cor: ['verde', 'azul', 'laranja', 'vinho', 'roxo', 'preto'],
};
const TEXTOS = { nomeLoja: 60, cabecalhoTexto: 400, titulo: 60, rodape: 300, instrucao: 160 };

/** Configuração completa e segura: só as chaves conhecidas, nos limites. */
function normalizarConfig(tipo, entrada) {
  if (!TIPOS.includes(tipo)) throw new Error('Tipo de impressão inválido.');
  const padrao = PADRAO[tipo];
  const e = entrada && typeof entrada === 'object' ? entrada : {};
  const c = {};
  for (const [chave, valorPadrao] of Object.entries(padrao)) {
    const v = e[chave];
    if (chave === 'logo') c.logo = soImagemRaster(v);
    else if (chave === 'porFolha') c[chave] = ESCOLHAS.porFolha.includes(Number(v)) ? Number(v) : valorPadrao;
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
  const fonte = base + ({ pequena: -1, normal: 0, grande: 2, extra: 5, gigante: 9 }[tamanho] || 0);
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
    .hora { font-size: ${fonte - 2}px; white-space: nowrap; }
    .pessoa { font-weight: bold; margin: 8px 0 0; }
    .mesa { text-align: center; margin: 4px 0 2px; line-height: 1.15; overflow-wrap: anywhere; }
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

/** "19:42" (horário de Brasília) de um instante gravado em UTC. */
function horaBR(textoUtc) {
  if (!textoUtc) return '';
  const d = new Date(`${String(textoUtc).replace(' ', 'T').replace(/Z?$/, 'Z')}`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

function dataHoraBR(textoUtc) {
  if (!textoUtc) return '';
  const d = new Date(`${String(textoUtc).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/** Mesa em destaque (linha própria, maior e/ou em negrito). Vazio quando a
 * venda não é de mesa, quando o estúdio esconde a mesa ou quando ela fica
 * do jeito simples, na linha de informações (mesaEmDestaque = false). */
const mesaEmDestaque = (c) => c.mesaTamanho !== 'normal' || c.mesaNegrito;
function blocoMesa(c, mesa, fonte) {
  if (!c.mostrarMesa || !mesa || !mesaEmDestaque(c)) return '';
  const tamanho = { normal: fonte, grande: fonte + 6, enorme: Math.round(fonte * 2.2) }[c.mesaTamanho] || fonte;
  return `<p class="mesa" style="font-size:${tamanho}px;font-weight:${c.mesaNegrito ? 'bold' : 'normal'};">${escHtml(mesa)}</p>`;
}

function linhasDeInfo(config, venda, { rotuloCodigo, dataUtc, extra = [] }) {
  const partes = [];
  if (config.mostrarCodigoVenda && venda?.id) partes.push(`${rotuloCodigo} ${escHtml(String(venda.id).slice(0, 8))}`);
  if (config.mostrarDataHora && dataUtc) partes.push(escHtml(dataHoraBR(dataUtc)));
  const linhas = [partes.join(' — ')].filter(Boolean);
  for (const [rotulo, valor] of extra) if (valor) linhas.push(`${rotulo}: ${escHtml(valor)}`);
  return linhas.map((l) => `<p class="info center">${l}</p>`).join('');
}

function tabelaItens(configOriginal, itens) {
  // Letra enorme não cabe com 4 colunas no rolo (o Total saía cortado): sem o
  // unitário, a conta continua inteira. O valor unitário volta com letra menor.
  const config = configOriginal.tamanho === 'gigante' ? { ...configOriginal, colunaUnitario: false } : configOriginal;
  const cabec = `<thead><tr><th>Item</th><th>Qtd</th>${config.colunaUnitario ? '<th>Unit.</th>' : ''}<th>Total</th></tr></thead>`;
  const linhas = itens.map((i) => `
    <tr><td>${escHtml(i.nome)}${config.mostrarHoraItem && i.criadoEm && horaBR(i.criadoEm) ? ` <span class="hora">${horaBR(i.criadoEm)}</span>` : ''}</td><td class="n">${escHtml(i.quantidade)}</td>${config.colunaUnitario ? `<td class="n">${dinheiro(i.precoUnitario)}</td>` : ''}<td class="n">${dinheiro(i.precoUnitario * i.quantidade)}</td></tr>
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
 *          loja, larguraMm, rodape, operador, cliente, mesa ("Mesa 3 + 4" ou null), fiscalHtml, senha{numero,nome},
 *          ajustadoManualmente, totalFinal, descontoFidelidade, descontoGerente, taxaServicoValor, taxaServicoPercentual }
 */
function montarNota(config, dados) {
  const c = normalizarConfig('nota', config);
  const { fonte } = medidas(dados.larguraMm, c.tamanho);
  const senha = dados.senha
    ? `<div class="center" style="border:2px solid #000;padding:4px;margin-bottom:6px;"><div>SUA SENHA</div><div style="font-size:${fonte * 3}px;font-weight:bold;line-height:1.1;">${escHtml(dados.senha.numero)}</div>${dados.senha.nome ? `<div>${escHtml(dados.senha.nome)}</div>` : ''}<div class="pequeno">Aguarde ser chamado no painel</div></div>`
    : '';
  const extra = [];
  if (c.mostrarMesa && !mesaEmDestaque(c)) extra.push(['Mesa', dados.mesa]);
  if (c.mostrarOperador) extra.push(['Atendente', dados.operador]);
  if (c.mostrarCliente) extra.push(['Cliente', dados.cliente]);
  return `<!doctype html>
  <html><head><meta charset="utf-8"><style>${estilo(c, dados.larguraMm)}</style></head>
  <body>
    ${senha}
    ${cabecalho(c, dados.loja)}
    ${c.titulo ? `<p class="titulo">${escHtml(c.titulo)}</p>` : ''}
    ${blocoMesa(c, dados.mesa, fonte)}
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
  if (c.mostrarMesa && !mesaEmDestaque(c)) extra.push(['Mesa', dados.mesa]);
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
    ${blocoMesa(c, dados.mesa, medidas(dados.larguraMm, c.tamanho).fonte)}
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

// ------------------------------------------------------------ comanda da cozinha

const qtdDaComanda = (q, unidade) => {
  const n = Number(q) || 0;
  if (unidade === 'kg' || !Number.isInteger(n)) return `${n.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}${unidade === 'kg' ? ' kg' : ''}`;
  return `${n}x`;
};

/** "2 x R$ 8,00" / "0,750 kg x R$ 70,00/kg" (vazio quando é 1 unidade). */
function detalheDoValor(i) {
  const n = Number(i.quantidade) || 0;
  if (!(Number(i.precoUnitario) >= 0) || i.precoUnitario === null || i.precoUnitario === undefined) return '';
  if (i.unidade === 'kg') return `${qtdDaComanda(n, 'kg')} x ${dinheiro(i.precoUnitario)}/kg`;
  return n === 1 ? '' : `${n.toLocaleString('pt-BR')} x ${dinheiro(i.precoUnitario)}`;
}

const valorDoItem = (i) => (Number.isFinite(Number(i.precoUnitario)) && i.precoUnitario !== null ? arred(Number(i.precoUnitario) * (Number(i.quantidade) || 0)) : null);

/** Total da comanda (só itens com preço). */
function totalDaComanda(itens) {
  return arred((itens || []).reduce((s, i) => s + (valorDoItem(i) || 0), 0));
}

/**
 * Comanda da cozinha em HTML (impressora do Windows e prévia do estúdio).
 * comanda: { mesa ("MESA 4 + 5" ou null), titulo (senha/BALCÃO/PEDIDO), subtitulo (cliente),
 *            hora, operador, itens[{ quantidade, unidade, nome, precoUnitario, pessoa, observacao }], rodape }
 */
function montarComandaCozinha(config, comanda, { larguraMm = 80 } = {}) {
  const c = normalizarConfig('cozinha', config);
  const estreita = larguraMm === 58;
  const largura = estreita ? 54 : 74;
  const fonteItem = ({ pequena: 15, normal: 17, grande: 20, extra: 24, gigante: 28 }[c.tamanho] || 17) - (estreita ? 2 : 0);
  const familia = c.fonte === 'mono' ? "'Courier New', monospace" : 'Arial, Helvetica, sans-serif';
  const linha = c.separador === 'continuo' ? 'solid' : 'dashed';
  const tamMesa = { normal: fonteItem + 4, grande: fonteItem + 10, enorme: Math.round(fonteItem * 2) }[c.mesaTamanho] || fonteItem + 10;
  const temMesa = c.mostrarMesa && comanda.mesa;
  const destaque = temMesa ? comanda.mesa : (comanda.titulo || 'COMANDA');
  // Comanda de mesa com senha (pedido pelo QR): a senha sai embaixo da mesa.
  const segunda = temMesa && comanda.titulo && comanda.titulo !== comanda.mesa ? comanda.titulo : '';
  const itens = (comanda.itens || []).map((i) => {
    const valor = c.mostrarValores ? valorDoItem(i) : null;
    const detalhe = c.mostrarValores ? detalheDoValor(i) : '';
    return `<div class="item">
      <div class="linha"><span><span class="qtd">${escHtml(qtdDaComanda(i.quantidade, i.unidade))}</span> ${escHtml(i.nome)}</span>${valor !== null ? `<span class="valor">${dinheiro(valor)}</span>` : ''}</div>
      ${detalhe ? `<div class="det">${escHtml(detalhe)}</div>` : ''}
      ${c.mostrarPessoa && i.pessoa ? `<div class="pessoa">para: ${escHtml(i.pessoa)}</div>` : ''}
      ${c.mostrarObservacoes && i.observacao ? `<div class="obs">&gt;&gt; ${escHtml(i.observacao)}</div>` : ''}
    </div>`;
  }).join('');
  const total = c.mostrarValores && c.mostrarTotal && (comanda.itens || []).some((i) => valorDoItem(i) !== null)
    ? `<p class="total">Total desta comanda: ${dinheiro(totalDaComanda(comanda.itens))}</p>` : '';
  const info = [c.mostrarDataHora && comanda.hora ? escHtml(comanda.hora) : '', c.mostrarOperador && comanda.operador ? `Atendente: ${escHtml(comanda.operador)}` : '']
    .filter(Boolean).join(' · ');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${larguraMm}mm auto; margin: 2mm; }
    body { font-family: ${familia}; width: ${largura}mm; margin: 0 auto; color: #000; background: #fff; }
    .tit { font-size: ${fonteItem - 3}px; font-weight: bold; text-align: center; margin: 0; letter-spacing: .5px; }
    h1 { font-size: ${temMesa ? tamMesa : fonteItem + 8}px; font-weight: ${!temMesa || c.mesaNegrito ? 'bold' : 'normal'}; margin: 0; text-align: center; line-height: 1.1; overflow-wrap: anywhere; }
    .seg { font-size: ${fonteItem}px; font-weight: bold; text-align: center; margin: 2px 0; }
    .sub { font-size: ${fonteItem - 4}px; font-weight: bold; text-align: center; margin: 2px 0; }
    .hora { font-size: ${fonteItem - 6}px; text-align: center; margin: 2px 0 6px; }
    .item { padding: 5px 0; border-top: 1px ${linha} #000; }
    .linha { display: flex; justify-content: space-between; gap: 6px; font-size: ${fonteItem}px; font-weight: bold; }
    .qtd { display: inline-block; min-width: 30px; }
    .valor { white-space: nowrap; }
    .det { font-size: ${fonteItem - 5}px; margin-left: 30px; }
    .pessoa { font-size: ${fonteItem - 5}px; margin-left: 30px; }
    .obs { font-size: ${fonteItem - 3}px; font-weight: bold; margin-left: 30px; }
    .total { border-top: 1px ${linha} #000; font-size: ${fonteItem - 3}px; font-weight: bold; text-align: right; margin: 0; padding-top: 4px; }
    .rodape { border-top: 1px ${linha} #000; font-size: ${fonteItem - 5}px; text-align: center; padding-top: 4px; margin: 4px 0 0; white-space: pre-line; }
  </style></head><body>
    ${c.titulo ? `<p class="tit">${escHtml(c.titulo)}</p>` : ''}
    <h1>${escHtml(destaque)}</h1>
    ${segunda ? `<p class="seg">${escHtml(segunda)}</p>` : ''}
    ${c.mostrarCliente && comanda.subtitulo ? `<p class="sub">${escHtml(comanda.subtitulo)}</p>` : ''}
    ${info ? `<p class="hora">${info}</p>` : ''}
    ${itens}
    ${total}
    ${comanda.rodape ? `<p class="rodape">${escHtml(comanda.rodape)}</p>` : ''}
    ${c.rodape ? `<p class="rodape">${escHtml(c.rodape)}</p>` : ''}
  </body></html>`;
}

// ------------------------------------------------------------ display do QR da mesa

const CORES_QR = { verde: '#0f6e56', azul: '#185fa5', laranja: '#b5521d', vinho: '#8a2337', roxo: '#4b3fa8', preto: '#141a26' };
// Papel (mm) e grade de cartões por folha (colunas x linhas). A6 e térmica: 1 por folha/cupom.
const PAPEIS_QR = { a4: [210, 297], carta: [216, 279], oficio: [216, 356], a6: [105, 148], termica: [80, null] };
// colunas x linhas. Folha deitada (paisagem) com 6 = 3 x 2: cartões em pé.
const GRADES_QR = {
  retrato: { 1: [1, 1], 2: [1, 2], 4: [2, 2], 6: [2, 3], 8: [2, 4], 9: [3, 3], 12: [3, 4], 16: [4, 4] },
  paisagem: { 1: [1, 1], 2: [2, 1], 4: [2, 2], 6: [3, 2], 8: [4, 2], 9: [3, 3], 12: [4, 3], 16: [4, 4] },
};
const PAGINA_CSS = { a4: 'A4', carta: 'letter', oficio: '216mm 356mm', a6: 'A6', termica: '80mm auto' };

/** Medidas de cada cartão para o papel e a quantidade por folha. Exportada pra teste. */
function medidasDoCartao(papel, porFolha, orientacao = 'paisagem') {
  const termica = papel === 'termica';
  const umPorFolha = termica || papel === 'a6';
  const deitada = orientacao === 'paisagem' && !umPorFolha;
  const grades = GRADES_QR[deitada ? 'paisagem' : 'retrato'];
  const [cols, linhas] = umPorFolha ? [1, 1] : (grades[porFolha] || grades[6]);
  const [l0, a0] = PAPEIS_QR[papel] || PAPEIS_QR.a4;
  const [lp, ap] = deitada ? [a0, l0] : [l0, a0];
  const margem = termica ? 2 : papel === 'a6' ? 5 : 8;
  const vao = 3;
  const largura = (lp - 2 * margem - (cols - 1) * vao) / cols;
  const altura = termica ? largura * 1.55 : (ap - 2 * margem - (linhas - 1) * vao) / linhas;
  // QR: o maior que cabe deixando espaço para mesa, título e instrução.
  const qr = Math.max(18, Math.min(largura * 0.78, altura * 0.5));
  const escala = Math.min(largura / 90, altura / 110);
  return {
    cols, linhas, porPagina: cols * linhas, margem, vao, largura, altura, qr, termica, deitada,
    mesa: Math.max(11, 34 * escala), titulo: Math.max(7, 15 * escala), texto: Math.max(6, 10.5 * escala),
  };
}

/**
 * Cartões com o QR de cada mesa, vários por folha para recortar, com a
 * aparência do estúdio. dados: { loja, mesas: [{ rotulo, qrDataUrl }] }.
 */
function montarCartoesQr(config, { loja = {}, mesas = [] } = {}) {
  const c = normalizarConfig('qrmesa', config);
  const m = medidasDoCartao(c.papel, Number(c.porFolha), c.orientacao);
  const cor = CORES_QR[c.cor] || CORES_QR.verde;
  const nome = (c.nomeLoja || '').trim() || loja.nome || '';
  const logo = soImagemRaster(c.logo);
  const pequeno = m.largura < 60; // 12 ou 16 por folha: corta o texto longo
  // QR do Wi-Fi da loja ao lado do QR da mesa (pedido pela rede da loja):
  // primeiro o cliente entra no Wi-Fi, depois aponta para o QR da mesa.
  const wifi = loja.wifi && /^data:image\/png;base64,/.test(loja.wifi.qrDataUrl || '') && !pequeno ? loja.wifi : null;
  const qrImg = (url) => (url && /^data:image\/png;base64,/.test(url) ? `<img class="qr" src="${url}" alt="">` : '<div class="qr semqr">QR indisponível</div>');
  const qrDaMesa = (mesa) => qrImg(mesa.qrDataUrl);
  // Cartão com dois caminhos: Wi-Fi da loja (QR local) ou a internet do cliente
  // (QR da vitrine). Cartão pequeno (12/16 por folha) leva só o da internet,
  // que funciona em qualquer lugar.
  const duplo = (mesa) => !!mesa.qrInternetDataUrl && /^data:image\/png;base64,/.test(mesa.qrInternetDataUrl);
  const blocoQr = (mesa) => {
    if (duplo(mesa) && pequeno) return qrImg(mesa.qrInternetDataUrl);
    if (duplo(mesa)) {
      return `<div class="qrs dual">
        <div class="passo">${wifi ? `<div class="rotulo">Na loja, com o Wi-Fi</div><div class="par"><img class="qrwifi" src="${wifi.qrDataUrl}" alt=""><span class="legenda">Wi-Fi<br><b>${escHtml(wifi.nome)}</b></span></div>` : '<div class="rotulo">Na loja, com o Wi-Fi</div>'}${qrDaMesa(mesa)}</div>
        <div class="passo"><div class="rotulo">Sem Wi-Fi? Use a sua internet</div>${qrImg(mesa.qrInternetDataUrl)}</div>
      </div>`;
    }
    return wifi
      ? `<div class="qrs">
        <div class="passo"><span class="num">1</span><img class="qrwifi" src="${wifi.qrDataUrl}" alt=""><span class="legenda">Wi-Fi<br><b>${escHtml(wifi.nome)}</b></span></div>
        <div class="passo"><span class="num">2</span>${qrDaMesa(mesa)}</div>
      </div>`
      : qrDaMesa(mesa);
  };
  const cartao = (mesa) => `
    <div class="cartao">
      ${logo && !pequeno ? `<img class="logo" src="${logo}" alt="">` : ''}
      ${c.mostrarNomeLoja && nome ? `<div class="loja">${escHtml(nome)}</div>` : ''}
      <div class="mesa">${escHtml(mesa.rotulo)}</div>
      ${c.titulo ? `<div class="titulo">${escHtml(c.titulo)}</div>` : ''}
      ${blocoQr(mesa)}
      ${c.instrucao && !pequeno ? `<div class="instrucao">${escHtml(c.instrucao)}</div>` : ''}
      ${c.rodape ? `<div class="rodape">${escHtml(c.rodape)}</div>` : ''}
    </div>`;
  // Uma grade por folha: a quebra de página nunca corta um cartão ao meio.
  const folhas = [];
  for (let i = 0; i < mesas.length; i += m.porPagina) folhas.push(mesas.slice(i, i + m.porPagina));
  const mm = (v) => `${Math.round(v * 10) / 10}mm`;
  const pt = (v) => `${Math.round(v * 10) / 10}pt`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>QR das mesas</title><style>
    @page { size: ${PAGINA_CSS[c.papel] || 'A4'}${m.deitada ? ' landscape' : ''}; margin: ${mm(m.margem)}; }
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; color: #141a26; }
    .folha { display: grid; grid-template-columns: repeat(${m.cols}, ${mm(m.largura)}); grid-auto-rows: ${mm(m.altura)}; gap: ${mm(m.vao)}; page-break-after: always; break-after: page; }
    .folha:last-child { page-break-after: auto; break-after: auto; }
    .cartao {
      width: ${mm(m.largura)}; height: ${mm(m.altura)}; padding: ${mm(Math.min(4, m.largura * 0.05))}; text-align: center; overflow: hidden;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${mm(Math.max(0.8, m.altura * 0.012))};
      border: ${c.linhaDeCorte && !m.termica ? '1px dashed #9aa4b2' : 'none'}; border-radius: 2mm;
    }
    .logo { max-width: 45%; max-height: ${mm(m.altura * 0.13)}; object-fit: contain; }
    .loja { font-size: ${pt(m.texto + 1)}; color: #4a5568; }
    .mesa { font-size: ${pt(m.mesa)}; font-weight: 800; line-height: 1.05; color: ${m.termica ? '#000' : cor}; overflow-wrap: anywhere; }
    .titulo { font-size: ${pt(m.titulo)}; font-weight: 700; color: #fff; background: ${m.termica ? '#000' : cor}; padding: 0.6mm 3mm; border-radius: 1.5mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .qr { width: ${mm(m.qr)}; height: ${mm(m.qr)}; }
    .qrs { display: flex; align-items: flex-end; justify-content: center; gap: ${mm(Math.max(2, m.largura * 0.04))}; }
    .passo { display: flex; flex-direction: column; align-items: center; gap: 0.6mm; }
    .num { font-size: ${pt(m.texto)}; font-weight: 800; color: #fff; background: ${m.termica ? '#000' : cor}; border-radius: 50%; width: ${pt(m.texto * 1.7)}; height: ${pt(m.texto * 1.7)}; line-height: ${pt(m.texto * 1.7)}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .dual { align-items: flex-start; gap: ${mm(Math.max(1.5, m.largura * 0.03))}; }
    .dual .qr { width: ${mm(Math.min(m.qr * 0.8, (m.largura - 2 * Math.min(4, m.largura * 0.05)) / 2 - 2))}; height: ${mm(Math.min(m.qr * 0.8, (m.largura - 2 * Math.min(4, m.largura * 0.05)) / 2 - 2))}; }
    .dual .qrwifi { width: ${mm(m.qr * 0.28)}; height: ${mm(m.qr * 0.28)}; }
    .dual .legenda { max-width: ${mm(m.qr * 0.5)}; text-align: left; }
    .rotulo { font-size: ${pt(Math.max(6, m.texto - 1))}; font-weight: 700; line-height: 1.1; max-width: ${mm(m.qr * 1.1)}; }
    .par { display: flex; align-items: center; gap: 1mm; }
    .qrwifi { width: ${mm(m.qr * 0.45)}; height: ${mm(m.qr * 0.45)}; }
    .legenda { font-size: ${pt(Math.max(6, m.texto - 1))}; line-height: 1.15; max-width: ${mm(m.qr * 0.6)}; overflow-wrap: anywhere; }
    .semqr { display: flex; align-items: center; justify-content: center; border: 1px solid #999; font-size: 8pt; }
    .instrucao { font-size: ${pt(m.texto)}; max-width: 92%; line-height: 1.25; }
    .rodape { font-size: ${pt(Math.max(6, m.texto - 1))}; color: #4a5568; }
  </style></head><body>${folhas.map((f) => `<div class="folha">${f.map(cartao).join('')}</div>`).join('')}</body></html>`;
}

/** Comanda de exemplo para a prévia do estúdio. */
function exemploComanda() {
  return {
    mesa: 'MESA 5', titulo: 'MESA 5', subtitulo: null,
    hora: new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }),
    operador: 'Carla',
    itens: [
      { quantidade: 1, unidade: 'un', nome: 'Peixe frito (inteiro)', precoUnitario: 60, pessoa: 'Ana', observacao: 'bem passado' },
      { quantidade: 1, unidade: 'un', nome: 'Peixe frito (posta)', precoUnitario: 45, pessoa: 'Bruno', observacao: '' },
      { quantidade: 0.75, unidade: 'kg', nome: 'Peixe no peso', precoUnitario: 70, pessoa: null, observacao: '' },
      { quantidade: 2, unidade: 'un', nome: 'Suco de laranja', precoUnitario: 8, pessoa: null, observacao: 'sem gelo' },
    ],
    rodape: null,
  };
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
  // Hora de cada item na prévia: lançados ao longo da mesa.
  const minutosAtras = [52, 50, 21, 6];
  itens.forEach((i, k) => { i.criadoEm = new Date(Date.now() - minutosAtras[k] * 60000).toISOString().slice(0, 19).replace('T', ' '); });
  if (tipo === 'nota') {
    const total = soma(itens);
    return {
      venda: { id: 'a1b2c3d4e5', finalizada_em: agora }, itens, larguraMm, loja,
      pagamentos: [{ metodo: 'pix', valor: arred(total) }], rodape: rodapeNota,
      operador: 'Carla', cliente: 'João Silva', mesa: 'Mesa 7', fiscalHtml: '', senha: null,
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

module.exports = {
  PADRAO, TIPOS, LOGO_MAX_CARACTERES, normalizarConfig, horaBR, montarNota, montarPreNota, valoresDaPreNota, exemplo, escHtml,
  montarComandaCozinha, exemploComanda, totalDaComanda, detalheDoValor, qtdDaComanda,
  montarCartoesQr, medidasDoCartao, CORES_QR,
};
