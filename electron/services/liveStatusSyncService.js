const { getDb } = require('../db/database');
const timeService = require('./timeService');

const INTERVALO_PUBLICACAO_MS = 25 * 1000;

// Limite de itens publicados no catálogo do celular -- documento único
// do Firestore (limite de verdade é 1 MiB, mas um catálogo gigante
// também não faz sentido no celular do garçom); catálogos maiores que
// isso são um sinal de que valeria a pena paginar de verdade no futuro.
const LIMITE_CATALOGO_GARCOM = 800;

/** Mesmo cálculo de "hoje" local (Brasília) que o Dashboard usa —
 * ver a armadilha de fuso horário documentada em timeService.js e
 * CLAUDE.md. Só o total do dia (o celular não precisa do detalhamento
 * por produto/dia que o Dashboard desktop mostra). */
function getResumoHoje(locationId) {
  const db = getDb();
  const hoje = timeService.hojeLocalISO();
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(hoje, hoje);

  const totais = db.prepare(
    `SELECT COUNT(*) as totalVendas, COALESCE(SUM(total - desconto - desconto_gerente), 0) as totalFaturado
     FROM sales WHERE location_id = ? AND status = 'finalizada' AND finalizada_em >= ? AND finalizada_em < ?`
  ).get(locationId, inicioUtc, fimUtcExclusivo);

  return {
    totalVendasHoje: totais.totalVendas,
    faturamentoHoje: totais.totalFaturado,
    ticketMedioHoje: totais.totalVendas > 0 ? totais.totalFaturado / totais.totalVendas : 0,
  };
}

/** Catálogo publicado pro PWA do garçom montar o pedido -- o celular não
 * tem acesso ao SQLite, então o preço/nome/categoria de cada produto
 * precisa estar espelhado aqui. Usa precoEfetivo (mesma função que
 * saleService/botOrderService usam pra vender) pra já mandar o preço
 * promocional vigente, se houver -- o garçom nunca deveria digitar um
 * preço diferente do que o caixa cobraria pelo mesmo item agora. */
function getCatalogoProdutos() {
  const db = getDb();
  const { precoEfetivo } = require('./productService');
  // Sem COLLATE especial de propósito -- mesma convenção do resto do
  // app (ver productService.listDailyMenu/listFullMenu, customerService,
  // etc.): ordenação binária do SQLite, que já é a que o PDV usa em
  // toda tela de lista hoje.
  const produtos = db.prepare(
    `SELECT id, nome, categoria, preco, preco_promocional, promocao_valida_ate FROM products
     WHERE ativo = 1 ORDER BY nome LIMIT ?`
  ).all(LIMITE_CATALOGO_GARCOM);

  return produtos.map((p) => ({
    id: p.id, nome: p.nome, categoria: p.categoria || null, preco: precoEfetivo(p),
  }));
}

/**
 * Monta e publica o retrato atual da loja pro Firestore — resumo do
 * dia + operação ao vivo (mesas abertas só faz sentido pro perfil
 * restaurante; pedidos em andamento vale pra qualquer perfil que use
 * a Separação/bot). É best-effort e nunca bloqueia nada da operação
 * local: falha de rede aqui só significa que o celular vê um dado
 * levemente desatualizado até a próxima publicação, nunca um erro na
 * tela do PDV.
 *
 * Publicado por INTERVALO (a cada ~25s), não por evento — de propósito:
 * conectar isso a cada mutação de mesa/pedido tocaria em vários
 * arquivos centrais do PDV (tableService, saleService, botOrderService)
 * só pra um dado de "quase tempo real" que não precisa ser instantâneo
 * pra ser útil numa consulta remota.
 */
async function publicarStatusAoVivo() {
  try {
    const db = getDb();
    const location = db.prepare('SELECT id FROM locations LIMIT 1').get();
    if (!location) return;
    const locationId = location.id;

    const profileService = require('./profileService');
    const profile = profileService.getActiveProfile();

    const resumoHoje = getResumoHoje(locationId);

    // Lista de mesas COMPLETA (não só as ocupadas) -- o PWA do garçom
    // precisa saber quais números de mesa existem de verdade pra deixar
    // escolher uma (ver botOrderService.lancarPedidoNaMesa, que recusa
    // um número que não bate com nenhuma restaurant_tables cadastrada).
    // A consulta remota filtra as ocupadas do lado dela mesma, com o
    // mesmo dado.
    let mesas = [];
    if (profile?.id === 'restaurante') {
      const tableService = require('./tableService');
      mesas = tableService.listTables(locationId).map((t) => ({
        numero: t.numero, nome: t.nome || null, status: t.status, pessoas: t.pessoas || null,
        totalAtual: t.total_atual || 0, abertaEm: t.aberta_em || null,
      }));
    }

    const botOrderService = require('./botOrderService');
    const pedidosEmAndamento = botOrderService.listActiveOrders({ locationId }).map((p) => ({
      id: p.id, clienteNome: p.cliente_nome, tipoEntrega: p.tipo_entrega,
      status: p.status, criadoEm: p.criado_em,
    }));

    const catalogoProdutos = getCatalogoProdutos();

    const licenseService = require('./licenseService');
    const pdvRegistryService = require('./pdvRegistryService');
    const fiscalService = require('./fiscalService');
    const firestore = licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();

    const { doc, setDoc, serverTimestamp } = require('firebase/firestore');
    await setDoc(doc(firestore, 'installations', installId, 'status_ao_vivo', 'atual'), {
      nomeNegocio: fiscalService.getNomeNegocio() || 'Sua loja',
      perfilAtivo: profile?.id || null,
      resumoHoje,
      mesas,
      pedidosEmAndamento,
      catalogoProdutos,
      atualizadoEm: serverTimestamp(),
    });
  } catch (err) {
    // Rede fora, Firestore indisponível, ou nenhum dispositivo pareado
    // ainda -- nada disso deveria gerar alarde nenhum, é só best-effort.
  }
}

let intervalo = null;

function iniciarPublicacaoContinua() {
  if (intervalo) clearInterval(intervalo);
  publicarStatusAoVivo();
  intervalo = setInterval(publicarStatusAoVivo, INTERVALO_PUBLICACAO_MS);
}

module.exports = { publicarStatusAoVivo, iniciarPublicacaoContinua, getResumoHoje, getCatalogoProdutos };
