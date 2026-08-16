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

function montarMenuCategorias(locationId) {
  const categorias = botOrderService.listCategoriasComEstoque({ locationId });
  const linhas = categorias.map((c, i) => `${i + 1} - ${c}`);
  return {
    categorias,
    texto: linhas.length
      ? `Escolha uma categoria digitando o número:\n${linhas.join('\n')}`
      : 'No momento não temos produtos em estoque disponíveis para pedido. Tente novamente mais tarde.',
  };
}

function montarMenuProdutos(locationId, categoria) {
  const produtos = botOrderService.listInStockByCategory({ locationId, categoria });
  const linhas = produtos.map((p, i) => `${i + 1} - ${p.nome} — ${formatarPreco(p.preco)} (estoque: ${p.estoqueAtual})`);
  return {
    produtos,
    texto: linhas.length
      ? `${categoria}:\n${linhas.join('\n')}\n\nDigite o número do produto que quer (ex: "2", ou "2x3" para 3 unidades). Depois é só digitar "finalizar" para concluir, "categorias" para ver outra categoria, ou "cancelar".`
      : `Nenhum produto de "${categoria}" em estoque no momento. Digite "categorias" para ver outra opção.`,
  };
}

function resumoCarrinho(itens) {
  if (itens.length === 0) return '';
  const linhas = itens.map((i) => `• ${i.nome} x${i.quantidade}`);
  return `\n\nSeu pedido até agora:\n${linhas.join('\n')}`;
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
    return { resposta: `Não consegui registrar seu pedido (${resultado.error}). Pode mandar uma mensagem para tentar de novo.` };
  }
  return {
    resposta: `Pedido registrado! ✅${resumoCarrinho(conversa.itens)}\n\n${
      tipoEntrega === 'entrega'
        ? 'Assim que estiver pronto para entrega, alguém vai te avisar por aqui.'
        : 'Assim que estiver pronto para retirada, alguém vai te avisar por aqui.'
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
    return { resposta: 'Por enquanto só consigo entender mensagens de texto. Pode escrever o que precisa?' };
  }

  if (/^(cancelar|sair)$/i.test(textoLimpo)) {
    estadoConversas.delete(telefone);
    return { resposta: 'Pedido cancelado. Quando quiser fazer um novo pedido, é só mandar uma mensagem.' };
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

  switch (conversa.estado) {
    case 'inicio': {
      const menu = montarMenuCategorias(location);
      conversa.categorias = menu.categorias;
      if (menu.categorias.length) conversa.estado = 'aguardando_categoria';
      return { resposta: `Olá${conversa.nomeExibicao ? ', ' + conversa.nomeExibicao : ''}! Bem-vindo(a). ${menu.texto}` };
    }

    case 'aguardando_categoria': {
      const n = parseInt(textoLimpo, 10);
      if (!n || n < 1 || n > conversa.categorias.length) {
        return {
          resposta: `Não entendi. Digite o número de uma das categorias:\n${conversa.categorias.map((c, i) => `${i + 1} - ${c}`).join('\n')}`,
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
          return { resposta: 'Você ainda não adicionou nenhum item. Digite o número de um produto da lista para adicionar.' };
        }
        conversa.estado = 'aguardando_tipo_entrega';
        return { resposta: `Como você prefere receber?\n1 - Retirada no local\n2 - Entrega${resumoCarrinho(conversa.itens)}` };
      }
      const match = textoLimpo.match(/^(\d+)\s*(?:x\s*(\d+))?$/i);
      if (!match) {
        return { resposta: 'Não entendi. Digite o número do produto (ex: "2" ou "2x3" para 3 unidades), "finalizar" para concluir, ou "categorias" para trocar de categoria.' };
      }
      const idx = parseInt(match[1], 10);
      const qtd = match[2] ? parseInt(match[2], 10) : 1;
      if (!idx || idx < 1 || idx > conversa.produtos.length || qtd < 1) {
        return { resposta: `Número inválido — escolha entre 1 e ${conversa.produtos.length}.` };
      }
      const produto = conversa.produtos[idx - 1];
      const existente = conversa.itens.find((i) => i.productId === produto.id);
      if (existente) existente.quantidade += qtd;
      else conversa.itens.push({ productId: produto.id, nome: produto.nome, quantidade: qtd });
      return {
        resposta: `Adicionado: ${produto.nome} x${qtd}.${resumoCarrinho(conversa.itens)}\n\nDigite outro número para adicionar mais, "finalizar" para concluir o pedido, ou "categorias" para trocar de categoria.`,
      };
    }

    case 'aguardando_tipo_entrega': {
      if (/^1$/.test(textoLimpo) || /retirada/i.test(textoLimpo)) {
        return finalizarPedido({ telefone, nomeExibicao: conversa.nomeExibicao, tipoEntrega: 'retirada', conversa, locationId: location, estadoConversas });
      }
      if (/^2$/.test(textoLimpo) || /entrega/i.test(textoLimpo)) {
        conversa.estado = 'aguardando_endereco';
        return { resposta: 'Qual o endereço completo para entrega?' };
      }
      return { resposta: 'Não entendi. Digite 1 para retirada no local, ou 2 para entrega.' };
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

module.exports = { processarMensagem, _conversasEmMemoria: conversas };
