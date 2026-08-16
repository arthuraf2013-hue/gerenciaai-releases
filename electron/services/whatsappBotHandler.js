const { getDb } = require('../db/database');
const botOrderService = require('./botOrderService');

/**
 * Motor da conversa do chatbot de WhatsApp — sabe processar UMA
 * mensagem de texto e devolver a resposta certa, mas nunca fala com o
 * WhatsApp diretamente (isso é responsabilidade de quem chama, o
 * whatsappBotService, que de fato tem a conexão Baileys). Separado
 * assim de propósito: dá pra testar a conversa inteira sem precisar de
 * uma conexão de verdade.
 *
 * Estado de cada conversa fica em memória, num Map por telefone — se o
 * app reiniciar no meio de uma conversa, o cliente simplesmente
 * recomeça do zero na próxima mensagem que mandar. Aceitável: são
 * conversas curtas, e recomeçar não perde nada que já tinha sido
 * confirmado (pedidos só são criados no fim, em finalizarPedido).
 *
 * A "inteligência" de interpretar perguntas soltas ("vocês tem
 * dipirona?", "quanto custa o xarope?") é baseada em palavras-chave e
 * busca por texto -- NÃO é um modelo de linguagem de verdade (esse
 * app roda 100% local, sem chamar nenhuma IA externa). Funciona bem
 * pra perguntas diretas, mas não entende frases muito indiretas ou
 * fora do padrão -- nesses casos ela simplesmente não encontra nada e
 * sugere ver as categorias, sem travar a conversa.
 */
const conversas = new Map();

function getLocationIdPadrao() {
  const db = getDb();
  return db.prepare('SELECT id FROM locations LIMIT 1').get()?.id || null;
}

function novaConversa() {
  return { estado: 'inicio', categorias: [], produtos: [], categoriaAtual: null, itens: [] };
}

function formatarPreco(preco) {
  return `R$ ${Number(preco || 0).toFixed(2).replace('.', ',')}`;
}

// ---------- Nome "humanizado" do produto pro cliente ver ----------
// O nome cadastrado no sistema é pensado pra quem trabalha na loja
// (com siglas tipo "CPR", "C/10", "FR") -- pro cliente no WhatsApp a
// gente expande essas abreviações comuns de farmácia/mercado e deixa
// em formato de título. É uma lista heurística (não é um dicionário
// completo nem entende toda abreviação que existe) -- dá pra
// complementar essa lista se aparecer algum termo comum faltando; o
// nome cadastrado no sistema em si NUNCA é alterado, isso só muda o
// texto mostrado pro cliente.
const ABREVIACOES_PRODUTO = {
  cpr: 'comprimidos', cp: 'comprimidos', comp: 'comprimidos',
  cx: 'caixa', ct: 'cartela',
  fr: 'frasco', frs: 'frascos',
  sol: 'solução', susp: 'suspensão',
  inj: 'injetável',
  gts: 'gotas', gt: 'gotas',
  xpe: 'xarope',
  pom: 'pomada', crem: 'creme', cr: 'creme',
  env: 'envelope', sch: 'sachê', sache: 'sachê',
  un: 'unidade', unid: 'unidade', und: 'unidade',
  cap: 'cápsula', caps: 'cápsulas',
  drg: 'drágea', drag: 'drágea',
  rev: 'revestido',
  sl: 'sublingual',
  sod: 'sódica',
  po: 'pó',
};

// Marcas/laboratórios conhecidos -- mantidos em maiúsculo (siglas)
// em vez de virarem "Ems", "Ache" etc. no meio do nome.
const MARCAS_CONHECIDAS = new Set([
  'ems', 'ache', 'medley', 'germed', 'teuto', 'prati', 'eurofarma',
  'cimed', 'hipolabor', 'geolab', 'sanofi', 'gsk', 'bayer', 'pfizer',
  'natulab', 'biosintetica', 'legrand', 'multilab', 'neoquimica',
]);

function humanizarNomeProduto(nomeOriginal) {
  let texto = (nomeOriginal || '').trim();
  if (!texto) return texto;

  // Padrões compostos primeiro (ex: "C/10" -> "com 10").
  texto = texto.replace(/\bC\/(\d+)\b/gi, 'com $1');

  const palavras = texto.split(/\s+/).map((palavraOriginal) => {
    const palavraLimpa = palavraOriginal.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    if (ABREVIACOES_PRODUTO[palavraLimpa]) {
      const expandida = ABREVIACOES_PRODUTO[palavraLimpa];
      return expandida.charAt(0).toUpperCase() + expandida.slice(1);
    }
    if (MARCAS_CONHECIDAS.has(palavraLimpa)) return palavraLimpa.toUpperCase();
    // Título: primeira letra maiúscula, resto minúsculo -- funciona
    // também pra algo como "500MG" -> "500mg" (o primeiro caractere
    // sendo número não muda em .toUpperCase()).
    return palavraOriginal.charAt(0).toUpperCase() + palavraOriginal.slice(1).toLowerCase();
  });

  return palavras.join(' ').replace(/\s+/g, ' ').trim();
}

// ---------- "Inteligência" pra responder perguntas soltas sobre produto ----------
const GATILHO_PERGUNTA_PRODUTO = /\b(tem|t[eê]m|vend\w*|disponi?v[ei]l|estoque|quanto|cust\w*|pre[çc]o|valor)\b/i;

const PADROES_TERMO_PRODUTO = [
  /\b(?:voc[eê]s?\s+)?(?:tem|t[eê]m|vend\w*)\s+(.+)/i,
  /quanto\s+(?:custa|custam|[ée]|t[áa]|est[áa])\s+(?:o|a|os|as)?\s*(.+)/i,
  /\b(?:qual|quais)\s+(?:[ée]\s+)?(?:o|a)?\s*(?:pre[çc]o|valor)(?:\s+d[oea]s?)?\s*(.+)/i,
  /\bpre[çc]o\s+d[oea]?s?\s*(.+)/i,
  /^(.+?)\s+(?:tem|t[eê]m|h[áa])\s+(?:dispon[ií]vel|em\s+estoque)/i,
  /^(.+?)\s+est[áa]\s+dispon[ií]vel/i,
  // "e o xarope pra tosse, tem?" -- pergunta com o verbo no final da frase.
  /^(.+?),?\s+(?:tem|t[eê]m|vend\w*)\s*\??$/i,
];

const PALAVRAS_IGNORAR_NO_TERMO = /\b(o|a|os|as|um|uma|de|do|da|dos|das|para|pra|esse|essa|esses|essas|isso|aquele|aquela|a[íi]|ele|ela|tem|t[eê]m|voc[eê]s?|vcs?|por favor|pfv+)\b/gi;

function limparTermoBusca(bruto) {
  return (bruto || '')
    .replace(/[?!.,]+$/g, '')
    .replace(/,/g, ' ')
    .replace(/^\s*e\s+/i, '') // "e o xarope..." -- conjunção solta no início não ajuda a busca
    .replace(PALAVRAS_IGNORAR_NO_TERMO, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizarBusca(txt) {
  return (txt || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos
    .toLowerCase()
    .trim();
}

/** Busca produtos comparando com o nome JÁ HUMANIZADO (ex: query
 * "xarope" precisa achar um produto cadastrado como "XPE ...") --
 * por isso mora aqui, e não em botOrderService, que não conhece as
 * abreviações. Não filtra por estoque > 0 de propósito: permite
 * responder "temos cadastrado mas sem estoque agora" em vez de
 * simplesmente dizer que não existe. */
function buscarProdutos({ locationId, termo, limite = 5 }) {
  const alvo = normalizarBusca(termo);
  if (!alvo || alvo.length < 2) return [];

  const palavrasAlvo = alvo.split(/\s+/).filter((p) => p.length >= 3);
  const candidatos = botOrderService.listarAtivosParaBusca({ locationId })
    .map((p) => ({ produto: p, nomeNormalizado: normalizarBusca(humanizarNomeProduto(p.nome)) }))
    .filter(({ nomeNormalizado }) =>
      nomeNormalizado.includes(alvo) ||
      (palavrasAlvo.length > 0 && palavrasAlvo.every((palavra) => nomeNormalizado.includes(palavra)))
    );

  candidatos.sort((a, b) => {
    const aComeca = a.nomeNormalizado.startsWith(alvo) ? 0 : 1;
    const bComeca = b.nomeNormalizado.startsWith(alvo) ? 0 : 1;
    if (aComeca !== bComeca) return aComeca - bComeca;
    return a.nomeNormalizado.length - b.nomeNormalizado.length;
  });

  return candidatos.slice(0, limite).map((c) => c.produto);
}

function ehPerguntaSobreProduto(textoLimpo) {
  if (/^\d+\s*(?:x\s*\d+)?$/i.test(textoLimpo)) return false; // não confunde com seleção de menu ("2" ou "2x3")
  return GATILHO_PERGUNTA_PRODUTO.test(textoLimpo);
}

function extrairTermoProduto(textoLimpo) {
  for (const padrao of PADROES_TERMO_PRODUTO) {
    const m = textoLimpo.match(padrao);
    if (m?.[1]) {
      const termo = limparTermoBusca(m[1]);
      if (termo.length >= 2) return termo;
    }
  }
  const generico = limparTermoBusca(textoLimpo);
  return generico.length >= 2 ? generico : null;
}

/** Responde uma pergunta livre sobre disponibilidade/preço de um
 * produto e, na sequência, retoma o fluxo normal de onde a conversa
 * estava (mostra o menu de novo se ainda não tinha mostrado, ou só
 * lembra a pessoa do que digitar se já estava no meio do pedido). */
function responderPerguntaProduto({ locationId, textoLimpo, conversa }) {
  const termo = extrairTermoProduto(textoLimpo);
  if (!termo) return null;

  const encontrados = buscarProdutos({ locationId, termo });

  let resposta;
  if (encontrados.length === 0) {
    resposta = `Hmm, não encontrei nada parecido com "${termo}" 🤔 Pode ser que a gente não tenha esse item, ou eu não tenha entendido certinho o nome.`;
  } else {
    const linhas = encontrados.map((p) => {
      const nome = humanizarNomeProduto(p.nome);
      return p.estoqueAtual > 0
        ? `✅ *${nome}* — ${formatarPreco(p.preco)} (temos em estoque!)`
        : `⚠️ *${nome}* — ${formatarPreco(p.preco)} (cadastrado, mas sem estoque agora)`;
    });
    resposta = `Encontrei isso pra você 👇\n${linhas.join('\n')}`;
  }

  if (conversa.estado === 'inicio') {
    const menu = montarMenuCategorias(locationId);
    conversa.categorias = menu.categorias;
    if (menu.categorias.length) conversa.estado = 'aguardando_categoria';
    return { resposta: `${resposta}\n\n${menu.texto}` };
  }
  if (conversa.estado === 'aguardando_categoria') {
    return { resposta: `${resposta}\n\nPra continuar, é só me dizer o número de uma categoria 😊:\n${conversa.categorias.map((c, i) => `${i + 1} - ${c}`).join('\n')}` };
  }
  if (conversa.estado === 'aguardando_produto') {
    return { resposta: `${resposta}\n\nQuer adicionar? Digite o número do produto da lista, "finalizar" pra fechar o pedido, ou "categorias" pra ver outra opção. 🙂` };
  }
  if (conversa.estado === 'aguardando_tipo_entrega') {
    return { resposta: `${resposta}\n\nPra continuar seu pedido, digite 1 pra retirada ou 2 pra entrega.` };
  }
  return { resposta };
}

function montarMenuCategorias(locationId) {
  const categorias = botOrderService.listCategoriasComEstoque({ locationId });
  const linhas = categorias.map((c, i) => `${i + 1} - ${c}`);
  return {
    categorias,
    texto: linhas.length
      ? `O que você está procurando hoje? Escolha uma categoria digitando o número 👇\n${linhas.join('\n')}`
      : 'No momento não temos produtos em estoque disponíveis para pedido 😕 Tenta de novo daqui a pouco?',
  };
}

function montarMenuProdutos(locationId, categoria) {
  const produtos = botOrderService.listInStockByCategory({ locationId, categoria });
  const linhas = produtos.map((p, i) => `${i + 1} - ${humanizarNomeProduto(p.nome)} — ${formatarPreco(p.preco)} (estoque: ${p.estoqueAtual})`);
  return {
    produtos,
    texto: linhas.length
      ? `${categoria} 🧾:\n${linhas.join('\n')}\n\nDigite o número do produto que quer (ex: "2", ou "2x3" pra 3 unidades). Quando terminar, digite "finalizar" ✅, "categorias" pra ver outra categoria, ou "cancelar".`
      : `Poxa, nenhum produto de "${categoria}" em estoque no momento 😕 Digite "categorias" pra ver outra opção.`,
  };
}

function resumoCarrinho(itens) {
  if (itens.length === 0) return '';
  const linhas = itens.map((i) => `• ${humanizarNomeProduto(i.nome)} x${i.quantidade}`);
  return `\n\n🛒 Seu pedido até agora:\n${linhas.join('\n')}`;
}

function finalizarPedido({ telefone, nomeExibicao, tipoEntrega, endereco, conversa, locationId, estadoConversas }) {
  const resultado = botOrderService.createOrder({
    locationId,
    clienteNome: (nomeExibicao || '').trim() || 'Cliente WhatsApp',
    clienteTelefone: telefone,
    tipoEntrega,
    endereco,
    origem: 'whatsapp_bot',
    itens: conversa.itens.map((i) => ({ productId: i.productId, quantidade: i.quantidade })),
  });
  estadoConversas.delete(telefone);
  if (!resultado.ok) {
    return { resposta: `Ih, não consegui registrar seu pedido agora (${resultado.error}) 😕 Pode mandar uma mensagem pra gente tentar de novo?` };
  }
  return {
    resposta: `Pedido confirmado! ✅🎉${resumoCarrinho(conversa.itens)}\n\n${
      tipoEntrega === 'entrega'
        ? 'Assim que estiver pronto pra entrega, alguém te avisa por aqui mesmo 🛵💨'
        : 'Assim que estiver pronto pra retirada, alguém te avisa por aqui mesmo 🏬😊'
    }`,
    pedidoCriado: true,
    pedidoId: resultado.id,
  };
}

/**
 * Processa uma mensagem de um cliente e devolve `{ resposta, pedidoCriado?, pedidoId? }`.
 * `estadoConversas` é injetável só para os testes (cada teste começa
 * com um Map novo, sem interferir num com o outro); em produção usa o
 * Map do módulo mesmo.
 */
function processarMensagem({ telefone, texto, nomeExibicao, locationId, estadoConversas = conversas }) {
  const location = locationId || getLocationIdPadrao();
  if (!location) return { resposta: 'Sistema ainda não configurado — tente novamente mais tarde.' };
  if (!telefone) return { resposta: 'Não consegui identificar seu número — tente novamente.' };

  const textoLimpo = (texto || '').trim();
  if (!textoLimpo) {
    return { resposta: 'Por enquanto só consigo entender mensagens de texto 🙏 Pode escrever o que você precisa?' };
  }

  if (/^(cancelar|sair)$/i.test(textoLimpo)) {
    estadoConversas.delete(telefone);
    return { resposta: 'Pedido cancelado 👍 Quando quiser fazer um novo pedido, é só mandar uma mensagem por aqui!' };
  }

  let conversa = estadoConversas.get(telefone);
  if (!conversa) {
    conversa = novaConversa();
    estadoConversas.set(telefone, conversa);
  }
  // Guarda o nome assim que aparecer pela primeira vez -- o WhatsApp
  // (via Baileys) manda o `pushName` em toda mensagem, mas não custa
  // não depender disso continuar vindo em toda mensagem da conversa.
  if (nomeExibicao && !conversa.nomeExibicao) conversa.nomeExibicao = nomeExibicao;

  // Perguntas soltas sobre disponibilidade/preço podem acontecer a
  // qualquer momento -- exceto enquanto a pessoa está no meio de
  // digitar o endereço de entrega, onde qualquer texto livre É o
  // endereço, não uma pergunta.
  if (conversa.estado !== 'aguardando_endereco' && ehPerguntaSobreProduto(textoLimpo)) {
    const respostaPergunta = responderPerguntaProduto({ locationId: location, textoLimpo, conversa });
    if (respostaPergunta) return respostaPergunta;
  }

  switch (conversa.estado) {
    case 'inicio': {
      const menu = montarMenuCategorias(location);
      conversa.categorias = menu.categorias;
      if (menu.categorias.length) conversa.estado = 'aguardando_categoria';
      return { resposta: `Oi${conversa.nomeExibicao ? ', ' + conversa.nomeExibicao : ''}! 👋😊 Seja bem-vindo(a)! ${menu.texto}` };
    }

    case 'aguardando_categoria': {
      const n = parseInt(textoLimpo, 10);
      if (!n || n < 1 || n > conversa.categorias.length) {
        return {
          resposta: `Não entendi 🤔 Digite o número de uma das categorias:\n${conversa.categorias.map((c, i) => `${i + 1} - ${c}`).join('\n')}`,
        };
      }
      const categoria = conversa.categorias[n - 1];
      const menuProdutos = montarMenuProdutos(location, categoria);
      conversa.produtos = menuProdutos.produtos;
      conversa.categoriaAtual = categoria;
      conversa.estado = 'aguardando_produto';
      return { resposta: menuProdutos.texto };
    }

    case 'aguardando_produto': {
      if (/^categorias?$/i.test(textoLimpo)) {
        const menu = montarMenuCategorias(location);
        conversa.categorias = menu.categorias;
        conversa.estado = 'aguardando_categoria';
        return { resposta: menu.texto };
      }
      if (/^finalizar$/i.test(textoLimpo)) {
        if (conversa.itens.length === 0) {
          return { resposta: 'Você ainda não adicionou nenhum item 🛒 Digite o número de um produto da lista pra adicionar.' };
        }
        conversa.estado = 'aguardando_tipo_entrega';
        return { resposta: `Perfeito! Como você prefere receber? 😊\n1 - Retirada no local\n2 - Entrega${resumoCarrinho(conversa.itens)}` };
      }
      const match = textoLimpo.match(/^(\d+)\s*(?:x\s*(\d+))?$/i);
      if (!match) {
        return { resposta: 'Não entendi 🤔 Digite o número do produto (ex: "2" ou "2x3" pra 3 unidades), "finalizar" pra concluir, ou "categorias" pra trocar de categoria.' };
      }
      const idx = parseInt(match[1], 10);
      const qtd = match[2] ? parseInt(match[2], 10) : 1;
      if (!idx || idx < 1 || idx > conversa.produtos.length || qtd < 1) {
        return { resposta: `Número inválido 😕 Escolha entre 1 e ${conversa.produtos.length}.` };
      }
      const produto = conversa.produtos[idx - 1];
      const existente = conversa.itens.find((i) => i.productId === produto.id);
      if (existente) existente.quantidade += qtd;
      else conversa.itens.push({ productId: produto.id, nome: produto.nome, quantidade: qtd });
      return {
        resposta: `Adicionado: ${humanizarNomeProduto(produto.nome)} x${qtd}. ✅${resumoCarrinho(conversa.itens)}\n\nDigite outro número pra adicionar mais, "finalizar" pra concluir o pedido, ou "categorias" pra trocar de categoria.`,
      };
    }

    case 'aguardando_tipo_entrega': {
      if (/^1$/.test(textoLimpo) || /retirada/i.test(textoLimpo)) {
        return finalizarPedido({ telefone, nomeExibicao: conversa.nomeExibicao, tipoEntrega: 'retirada', conversa, locationId: location, estadoConversas });
      }
      if (/^2$/.test(textoLimpo) || /entrega/i.test(textoLimpo)) {
        conversa.estado = 'aguardando_endereco';
        return { resposta: 'Show! Qual o endereço completo pra entrega? 📍' };
      }
      return { resposta: 'Não entendi 🤔 Digite 1 para retirada no local, ou 2 para entrega.' };
    }

    case 'aguardando_endereco': {
      return finalizarPedido({ telefone, nomeExibicao: conversa.nomeExibicao, tipoEntrega: 'entrega', endereco: textoLimpo, conversa, locationId: location, estadoConversas });
    }

    default: {
      estadoConversas.delete(telefone);
      return processarMensagem({ telefone, texto, nomeExibicao, locationId: location, estadoConversas });
    }
  }
}

module.exports = { processarMensagem, humanizarNomeProduto, _conversasEmMemoria: conversas };
