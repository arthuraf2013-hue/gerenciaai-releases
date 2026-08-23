const { getDb } = require('../db/database');
const botOrderService = require('./botOrderService');
const reservationService = require('./reservationService');
const profileService = require('./profileService');
const tableService = require('./tableService');

// Perfis que fazem sentido oferecer "reservar mesa" pelo chatbot --
// mesmo critério do frontend (ver PERFIS_RESTAURANTE em AppShell.jsx).
const PERFIS_ACEITAM_RESERVA = ['restaurante', 'padaria'];

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

function finalizarPedido({ telefone, nomeExibicao, tipoEntrega, endereco, mesaNumero, conversa, locationId, estadoConversas }) {
  const resultado = botOrderService.createOrder({
    locationId,
    clienteNome: (nomeExibicao || '').trim() || 'Cliente WhatsApp',
    clienteTelefone: telefone,
    tipoEntrega,
    endereco,
    mesaNumero,
    origem: 'whatsapp_bot',
    itens: conversa.itens.map((i) => ({ productId: i.productId, quantidade: i.quantidade, precoUnitario: i.precoUnitario })),
  });
  estadoConversas.delete(telefone);
  if (!resultado.ok) {
    return { resposta: `Ih, não consegui registrar seu pedido agora (${resultado.error}) 😕 Pode mandar uma mensagem pra gente tentar de novo?` };
  }
  let mensagemFinal;
  if (mesaNumero) {
    mensagemFinal = `Já mandei pra cozinha 👨‍🍳🔥 Assim que estiver pronto, alguém leva até a Mesa ${mesaNumero}.`;
  } else if (tipoEntrega === 'entrega') {
    // Informa a taxa de entrega já aqui, na confirmação -- no modo
    // "fixa" o valor já é conhecido (foi ele mesmo que decidiu o
    // pedido); no modo "personalizada" ainda não tem valor (ver
    // botOrderService.createOrder/getConfig), então avisa que o
    // atendente vai definir e o cliente é avisado automaticamente
    // assim que isso acontecer (ver setTaxaEntrega).
    const taxaTexto = resultado.taxaEntrega != null
      ? `Taxa de entrega: ${formatarPreco(resultado.taxaEntrega)}.`
      : 'A taxa de entrega vai ser confirmada em breve por um atendente — te aviso assim que tiver o valor! 💬';
    mensagemFinal = `Assim que estiver pronto pra entrega, alguém te avisa por aqui mesmo 🛵💨\n${taxaTexto}`;
  } else {
    mensagemFinal = 'Assim que estiver pronto pra retirada, alguém te avisa por aqui mesmo 🏬😊';
  }
  return {
    resposta: `Pedido confirmado! ✅🎉${resumoCarrinho(conversa.itens)}\n\n${mensagemFinal}`,
    pedidoCriado: true,
    pedidoId: resultado.id,
  };
}

/** Acrescenta os itens escolhidos pelo cliente (num pedido em
 * andamento, ver estado "pedido_ativo_menu" abaixo) a um pedido que já
 * existe, em vez de criar um pedido novo -- ver
 * botOrderService.adicionarItensAoPedido. */
function finalizarAdicaoItens({ orderId, conversa, telefone, estadoConversas }) {
  const resultado = botOrderService.adicionarItensAoPedido({
    orderId,
    itens: conversa.itens.map((i) => ({ productId: i.productId, quantidade: i.quantidade, precoUnitario: i.precoUnitario })),
  });
  estadoConversas.delete(telefone);
  if (!resultado.ok) {
    return { resposta: `Ih, não consegui adicionar os itens agora (${resultado.error}) 😕 Pode mandar uma mensagem pra gente ver o que houve?` };
  }
  return { resposta: `Prontinho! Adicionei ao seu pedido:${resumoCarrinho(conversa.itens)}\n\nQualquer coisa, é só chamar por aqui! 😊` };
}

/** Menu mostrado quando o cliente manda mensagem de novo já tendo um
 * pedido em andamento (ver buscarPedidoEmAndamento) -- reaproveitado
 * tanto na primeira mensagem da conversa quanto sempre que a resposta
 * não bate com nenhuma das opções. */
function menuPedidoAtivo(nomeExibicao) {
  return `Oi${nomeExibicao ? ', ' + nomeExibicao : ''}! 👋 Você já tem um pedido em andamento. O que deseja fazer?\n1 - Consultar status do meu pedido\n2 - Adicionar itens ao pedido\n3 - Pedir uma alteração (trocar/remover item)\n4 - Fazer um novo pedido`;
}

// ---------- Fluxo de reserva de mesa (perfil Restaurante/Padaria) ----------

const MESES_2D = (n) => String(n).padStart(2, '0');

/** Formata 'YYYY-MM-DD HH:MM:SS' (hora local, mesmo padrão de
 * appointments.data_hora_inicio) pra algo natural tipo "hoje às 20h"
 * ou "15/03 às 20h30". */
function formatarDataHoraReserva(dataHoraStr, agora = new Date()) {
  const [dataParte, horaParte] = dataHoraStr.split(/[ T]/);
  const [ano, mes, dia] = dataParte.split('-').map(Number);
  const [hora, minuto] = horaParte.split(':').map(Number);
  const horaFormatada = minuto ? `${hora}h${MESES_2D(minuto)}` : `${hora}h`;

  const hojeStr = `${agora.getFullYear()}-${MESES_2D(agora.getMonth() + 1)}-${MESES_2D(agora.getDate())}`;
  const amanha = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1);
  const amanhaStr = `${amanha.getFullYear()}-${MESES_2D(amanha.getMonth() + 1)}-${MESES_2D(amanha.getDate())}`;

  if (dataParte === hojeStr) return `hoje às ${horaFormatada}`;
  if (dataParte === amanhaStr) return `amanhã às ${horaFormatada}`;
  return `${MESES_2D(dia)}/${MESES_2D(mes)} às ${horaFormatada}`;
}

/**
 * Interpreta um horário de reserva digitado em texto livre e devolve
 * 'YYYY-MM-DD HH:MM:SS' (hora local) -- ou null se não conseguiu
 * entender. NÃO é IA/modelo de linguagem, é um parser baseado em
 * regex, igual ao resto da "inteligência" deste arquivo (ver
 * comentário no topo). Aceita:
 *   "20h", "20:00", "20h30", "8 da noite" (não -- só formato 24h ou
 *   com "h") prefixado opcionalmente por "hoje"/"amanhã" ou uma data
 *   "dd/mm". Sem prefixo de data, assume hoje -- e se esse horário já
 *   passou hoje, rola pra amanhã sozinho (comportamento mais natural
 *   pra quem só disse "reservar pra 20h" de noite).
 */
function parseHorarioReserva(textoBruto, agora = new Date()) {
  const texto = (textoBruto || '').trim().toLowerCase();

  let diasAFrente = null; // null = ainda não decidido (decide depois, olhando se já passou)
  let dataExplicita = null; // { dia, mes }
  let resto = texto;

  const mHoje = resto.match(/^hoje\b\s*/);
  // Sem \b depois de "ã": \b exige um lado ser char de "palavra" (\w,
  // que no JS não inclui acentos) -- "ã" seguido de espaço são os dois
  // não-\w, então \b nunca bateria ali e "amanhã" nunca seria reconhecido.
  const mAmanha = resto.match(/^amanh[ãa](?:\s+|$)/);
  const mData = resto.match(/^(\d{1,2})\/(\d{1,2})\b\s*/);

  if (mHoje) { diasAFrente = 0; resto = resto.slice(mHoje[0].length); }
  else if (mAmanha) { diasAFrente = 1; resto = resto.slice(mAmanha[0].length); }
  else if (mData) {
    dataExplicita = { dia: parseInt(mData[1], 10), mes: parseInt(mData[2], 10) };
    resto = resto.slice(mData[0].length);
  }

  resto = resto.replace(/^(para|pra|às|as|de|do dia)\s+/, '').trim();

  const mHora = resto.match(/^(\d{1,2})(?:[:h](\d{2}))?\s*h?\s*$/);
  if (!mHora) return null;

  const hora = parseInt(mHora[1], 10);
  const minuto = mHora[2] ? parseInt(mHora[2], 10) : 0;
  if (hora > 23 || minuto > 59) return null;

  let base;
  if (dataExplicita) {
    const ano = agora.getFullYear();
    base = new Date(ano, dataExplicita.mes - 1, dataExplicita.dia, hora, minuto, 0);
    // Data explícita já passou esse ano (ex: pediu "10/01" em dezembro) -- assume o ano que vem.
    if (base.getTime() < agora.getTime()) base = new Date(ano + 1, dataExplicita.mes - 1, dataExplicita.dia, hora, minuto, 0);
  } else if (diasAFrente !== null) {
    base = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + diasAFrente, hora, minuto, 0);
  } else {
    // Sem prefixo de data -- tenta hoje; se já passou, rola pra amanhã.
    base = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), hora, minuto, 0);
    if (base.getTime() < agora.getTime()) base = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1, hora, minuto, 0);
  }

  if (isNaN(base.getTime())) return null;
  return `${base.getFullYear()}-${MESES_2D(base.getMonth() + 1)}-${MESES_2D(base.getDate())} ${MESES_2D(base.getHours())}:${MESES_2D(base.getMinutes())}:00`;
}

function finalizarReserva({ telefone, conversa, locationId, estadoConversas }) {
  const resultado = reservationService.create({
    locationId,
    clienteNome: conversa.reserva.nome,
    clienteTelefone: telefone,
    pessoas: conversa.reserva.pessoas,
    dataHora: conversa.reserva.dataHora,
    origem: 'whatsapp',
  });
  estadoConversas.delete(telefone);
  if (!resultado.ok) {
    return { resposta: `Ih, não consegui registrar sua reserva agora (${resultado.error}) 😕 Pode mandar uma mensagem pra gente tentar de novo?` };
  }
  const quando = formatarDataHoraReserva(conversa.reserva.dataHora);
  return {
    resposta: `Reserva confirmada! ✅🍽️ ${conversa.reserva.nome}, ${conversa.reserva.pessoas} pessoa(s), ${quando}.\n\nVamos te chamar por aqui perto da hora pra confirmar. Até lá! 😊`,
    reservaCriada: true,
    reservationId: resultado.id,
  };
}

/** Interpreta a resposta do cliente ao lembrete de "sua reserva é daqui
 * a 1h, confirma?" -- sim/não em várias formas comuns; qualquer outra
 * coisa repete a pergunta (não força uma segunda tentativa de
 * interpretar texto livre, pra não arriscar confirmar/cancelar por
 * engano uma leitura errada). `reservaConfirmada`/`reservaRecusada` no
 * retorno são só sinalizadores pra quem chama (whatsappBotService)
 * decidir se dispara a notificação nativa pro balcão -- este arquivo
 * não fala com o Electron diretamente (ver comentário no topo). */
function responderConfirmacaoReserva({ reserva, textoLimpo }) {
  const quando = formatarDataHoraReserva(reserva.data_hora);
  if (/^(sim|s|confirmo|confirmar|isso|ok|pode ser|claro|1)\b/i.test(textoLimpo)) {
    reservationService.confirmar(reserva.id);
    return {
      resposta: `Show, ${reserva.cliente_nome}! ✅ Sua reserva pra ${reserva.pessoas} pessoa(s) ${quando} está confirmada. Te esperamos! 🍽️`,
      reservaConfirmada: { ...reserva, quando },
    };
  }
  if (/^(n[aã]o|nao|cancelar|cancela|desmarcar|2)\b/i.test(textoLimpo)) {
    reservationService.recusar(reserva.id);
    return { resposta: 'Tudo bem, reserva cancelada 👍 Quando quiser reservar de novo, é só chamar por aqui!' };
  }
  return {
    resposta: `Oi! Só confirmando: sua reserva de ${reserva.pessoas} pessoa(s) é ${quando} 🙂 Pode confirmar? Responda *sim* ou *não*.`,
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

  // Resposta ao lembrete de reserva (mandado ~1h antes, ver
  // reservationService.findPendingLembrete + main.js) tem prioridade
  // sobre qualquer outro fluxo -- não depende de nenhum estado de
  // conversa em memória, porque pode chegar horas depois de qualquer
  // outra interação (o Map de conversas provavelmente nem tem mais
  // essa entrada). Roda ANTES do "cancelar" genérico de propósito: se
  // o cliente responder "cancelar" a um lembrete de reserva, é a
  // RESERVA que ele quer cancelar, não um pedido que nem existe mais.
  const reservaAguardandoResposta = reservationService.findAguardandoConfirmacaoByTelefone(telefone);
  if (reservaAguardandoResposta) {
    return responderConfirmacaoReserva({ reserva: reservaAguardandoResposta, textoLimpo });
  }

  if (/^(cancelar|sair)$/i.test(textoLimpo)) {
    estadoConversas.delete(telefone);
    return { resposta: 'Pedido cancelado 👍 Quando quiser fazer um novo pedido, é só mandar uma mensagem por aqui!' };
  }

  // "Reservar mesa" é um fluxo à parte do pedido normal -- interrompe
  // qualquer coisa em andamento (mesmo comportamento do "cancelar"
  // acima: começa do zero). Só oferecido pra perfil Restaurante/Padaria.
  if (/^(reservar|reserva|fazer\s+reserva)$/i.test(textoLimpo)) {
    const profile = profileService.getActiveProfile();
    if (profile && PERFIS_ACEITAM_RESERVA.includes(profile.id)) {
      const novaConversaReserva = { estado: 'aguardando_nome_reserva', categorias: [], produtos: [], categoriaAtual: null, itens: [], reserva: {} };
      estadoConversas.set(telefone, novaConversaReserva);
      return { resposta: 'Vamos marcar sua mesa! 🍽️ Qual o nome pra reserva?' };
    }
  }

  // "Mesa N" -- é o texto que já vem preenchido no QR code colado na
  // mesa (ver tableService.montarLinkPedidoMesa): abre direto o cardápio
  // pra pedir sentado, pulando reserva/retirada/entrega (o cliente já
  // está lá). Mesma prioridade de "reservar mesa" acima: interrompe
  // qualquer coisa em andamento e começa do zero. Só reconhece pra
  // perfil Restaurante/Padaria E se a mesa de fato existir nesse
  // local -- QR de mesa excluída ou número digitado errado não deve
  // criar um pedido "fantasma" sem mesa nenhuma pra receber.
  const matchMesa = textoLimpo.match(/^mesa\s+(\S+)$/i);
  if (matchMesa) {
    const profile = profileService.getActiveProfile();
    const numeroMesa = matchMesa[1];
    if (profile && PERFIS_ACEITAM_RESERVA.includes(profile.id) && tableService.existeMesa(location, numeroMesa)) {
      const menu = montarMenuCategorias(location);
      const conversaMesa = {
        estado: menu.categorias.length ? 'aguardando_categoria' : 'inicio',
        categorias: menu.categorias, produtos: [], categoriaAtual: null, itens: [], mesaNumero: numeroMesa,
      };
      if (nomeExibicao) conversaMesa.nomeExibicao = nomeExibicao;
      estadoConversas.set(telefone, conversaMesa);
      return { resposta: `Boa! Pedido pra Mesa ${numeroMesa} 🍽️\n\n${menu.texto}` };
    }
  }

  let conversa = estadoConversas.get(telefone);
  if (!conversa) {
    conversa = novaConversa();
    // Antes de jogar direto no cardápio, checa se esse telefone já tem
    // um pedido em andamento (ver buscarPedidoEmAndamento) -- sem isso,
    // quem voltasse a mandar mensagem pra saber do pedido caía sempre
    // no fluxo de pedido novo, sem jeito nenhum de só consultar status
    // ou pedir uma alteração no que já foi feito.
    const pedidoAtivo = botOrderService.buscarPedidoEmAndamento({ telefone, locationId: location });
    if (pedidoAtivo) {
      conversa.estado = 'pedido_ativo_menu';
      conversa.pedidoAtivoId = pedidoAtivo.id;
    }
    estadoConversas.set(telefone, conversa);
  }
  // Guarda o nome assim que aparecer pela primeira vez -- o WhatsApp
  // (via Baileys) manda o `pushName` em toda mensagem, mas não custa
  // não depender disso continuar vindo em toda mensagem da conversa.
  if (nomeExibicao && !conversa.nomeExibicao) conversa.nomeExibicao = nomeExibicao;

  // Perguntas soltas sobre disponibilidade/preço podem acontecer a
  // qualquer momento -- exceto enquanto a pessoa está no meio de
  // digitar o endereço de entrega ou o texto de uma solicitação de
  // alteração, onde qualquer texto livre é o próprio dado esperado,
  // não uma pergunta.
  if (
    conversa.estado !== 'aguardando_endereco' &&
    conversa.estado !== 'aguardando_texto_alteracao' &&
    ehPerguntaSobreProduto(textoLimpo)
  ) {
    const respostaPergunta = responderPerguntaProduto({ locationId: location, textoLimpo, conversa });
    if (respostaPergunta) return respostaPergunta;
  }

  switch (conversa.estado) {
    case 'inicio': {
      const menu = montarMenuCategorias(location);
      conversa.categorias = menu.categorias;
      if (menu.categorias.length) conversa.estado = 'aguardando_categoria';
      const profile = profileService.getActiveProfile();
      const dicaReserva = profile && PERFIS_ACEITAM_RESERVA.includes(profile.id)
        ? '\n\nOu digite *reservar* pra marcar uma mesa 🍽️'
        : '';
      return { resposta: `Oi${conversa.nomeExibicao ? ', ' + conversa.nomeExibicao : ''}! 👋😊 Seja bem-vindo(a)! ${menu.texto}${dicaReserva}` };
    }

    case 'aguardando_nome_reserva': {
      const nome = textoLimpo.trim();
      if (nome.length < 2) return { resposta: 'Não entendi 🤔 Qual o nome pra reserva?' };
      conversa.reserva.nome = nome;
      conversa.estado = 'aguardando_pessoas_reserva';
      return { resposta: `Perfeito, ${nome}! Pra quantas pessoas? 🙂` };
    }

    case 'aguardando_pessoas_reserva': {
      const n = parseInt(textoLimpo, 10);
      if (!n || n < 1 || n > 50) {
        return { resposta: 'Não entendi 🤔 Quantas pessoas vão na reserva? (só o número, ex: "4")' };
      }
      conversa.reserva.pessoas = n;
      conversa.estado = 'aguardando_horario_reserva';
      return { resposta: 'E qual dia e horário? 📅 (ex: "hoje 20h", "amanhã 19h30", ou "15/03 20h")' };
    }

    case 'aguardando_horario_reserva': {
      const dataHora = parseHorarioReserva(textoLimpo);
      if (!dataHora) {
        return { resposta: 'Não entendi o horário 🤔 Tenta assim: "hoje 20h", "amanhã 19h30" ou "15/03 20h".' };
      }
      conversa.reserva.dataHora = dataHora;
      return finalizarReserva({ telefone, conversa, locationId: location, estadoConversas });
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
        // Veio do menu "Adicionar itens ao pedido" (ver
        // 'pedido_ativo_menu' abaixo) -- acrescenta ao pedido que já
        // existe, em vez de criar um pedido novo do zero.
        if (conversa.modoAdicaoPedidoId) {
          return finalizarAdicaoItens({ orderId: conversa.modoAdicaoPedidoId, conversa, telefone, estadoConversas });
        }
        // Pedido de mesa não pergunta retirada/entrega -- o cliente já
        // está sentado ali, então fecha direto (ver fluxo "Mesa N" acima).
        if (conversa.mesaNumero) {
          return finalizarPedido({
            telefone, nomeExibicao: conversa.nomeExibicao, tipoEntrega: 'retirada', mesaNumero: conversa.mesaNumero,
            conversa, locationId: location, estadoConversas,
          });
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
      // Congela o preço mostrado no menu agora -- é esse valor que vira
      // a venda de verdade quando o pedido for concluído, não o preço
      // do produto na hora da conclusão (que pode já ter mudado).
      else conversa.itens.push({ productId: produto.id, nome: produto.nome, quantidade: qtd, precoUnitario: produto.preco });
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

    // Cliente que já tem um pedido em andamento manda mensagem de novo
    // (ver buscarPedidoEmAndamento, que decide se entra aqui). Sempre
    // busca o pedido de novo em vez de confiar só no que foi checado na
    // criação da conversa -- pode ter avançado de status entre uma
    // mensagem e outra.
    case 'pedido_ativo_menu': {
      const detalhe = botOrderService.getOrderWithItems(conversa.pedidoAtivoId);
      const pedido = detalhe.ok ? detalhe.pedido : null;
      if (!pedido) {
        conversa.estado = 'inicio';
        return processarMensagem({ telefone, texto, nomeExibicao, locationId: location, estadoConversas });
      }

      if (/^1$/.test(textoLimpo) || /status/i.test(textoLimpo)) {
        return { resposta: `${botOrderService.descreverStatusPedido(pedido)}\n\nDigite *2* pra adicionar itens, *3* pra pedir uma alteração, ou *4* pra fazer um novo pedido.` };
      }

      if (/^2$/.test(textoLimpo) || /adicionar/i.test(textoLimpo)) {
        if (!botOrderService.podeReceberModificacao(pedido)) {
          return { resposta: 'Esse pedido já está numa etapa que não dá mais pra adicionar item por aqui 😕 Quer fazer um *novo pedido*? Digite *4*.' };
        }
        const menu = montarMenuCategorias(location);
        conversa.categorias = menu.categorias;
        conversa.produtos = [];
        conversa.itens = [];
        conversa.modoAdicaoPedidoId = pedido.id;
        conversa.estado = menu.categorias.length ? 'aguardando_categoria' : 'inicio';
        return { resposta: `Show! O que mais você quer adicionar ao seu pedido? 😊\n\n${menu.texto}` };
      }

      if (/^3$/.test(textoLimpo) || /altera|troca|remov|cancelar\s*item/i.test(textoLimpo)) {
        if (!botOrderService.podeReceberModificacao(pedido)) {
          return { resposta: 'Esse pedido já está numa etapa que não dá mais pra alterar por aqui 😕 Quer fazer um *novo pedido*? Digite *4*.' };
        }
        conversa.estado = 'aguardando_texto_alteracao';
        conversa.pedidoAlteracaoId = pedido.id;
        return { resposta: 'Sem problema! Me conta o que você quer mudar (trocar item, quantidade, remover algo...) que um atendente já vai revisar e confirmar com você por aqui. ✍️' };
      }

      if (/^4$/.test(textoLimpo) || /novo\s*pedido/i.test(textoLimpo)) {
        const menu = montarMenuCategorias(location);
        conversa.categorias = menu.categorias;
        conversa.produtos = [];
        conversa.itens = [];
        conversa.modoAdicaoPedidoId = null;
        conversa.estado = menu.categorias.length ? 'aguardando_categoria' : 'inicio';
        return { resposta: `Beleza, vamos começar um novo pedido! 🛒\n\n${menu.texto}` };
      }

      return { resposta: menuPedidoAtivo(conversa.nomeExibicao) };
    }

    case 'aguardando_texto_alteracao': {
      botOrderService.registrarSolicitacaoAlteracao({ orderId: conversa.pedidoAlteracaoId, texto: textoLimpo });
      estadoConversas.delete(telefone);
      return { resposta: 'Anotado! ✅ Um atendente vai revisar seu pedido e confirmar com você por aqui em breve. Obrigado! 😊' };
    }

    default: {
      estadoConversas.delete(telefone);
      return processarMensagem({ telefone, texto, nomeExibicao, locationId: location, estadoConversas });
    }
  }
}

module.exports = {
  processarMensagem, humanizarNomeProduto, _conversasEmMemoria: conversas,
  parseHorarioReserva, formatarDataHoraReserva,
};
