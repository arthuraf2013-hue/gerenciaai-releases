const { randomUUID } = require('crypto');
const { getDb } = require('../db/database');

/**
 * Recebe os pedidos que o PWA do garçom manda pra
 * installations/{installId}/pedidos_garcom (escrito pelo celular,
 * autenticado e validado pelas regras do Firestore — ver
 * firestore.rules). Converte cada um numa linha de bot_orders
 * (origem = 'app_garcom', mesmo modelo do bot do WhatsApp) e, se tiver
 * mesa vinculada, lança direto na comanda via
 * botOrderService.lancarPedidoNaMesa — sem alteração nenhuma nessa
 * função, ela já foi escrita pra aceitar qualquer origem de bot_orders.
 *
 * Pedido SEM mesa (venda avulsa do garçom, ex. entrega de bairro) fica
 * como bot_orders 'novo' de propósito, pra alguém revisar/converter
 * pela tela de Separação já existente — evita inventar um caminho novo
 * de "virar venda sozinho" só pra esse caso, que já é raro.
 */
function buscarUsuarioLocalDoDispositivo(garcomUid) {
  const db = getDb();
  return db.prepare(
    `SELECT pd.*, u.nome as vinculo_nome, u.role as vinculo_role FROM paired_devices pd
     JOIN users u ON u.id = pd.vinculo_user_id
     WHERE pd.id = ? AND pd.tipo = 'garcom' AND pd.ativo = 1`
  ).get(garcomUid);
}

/** Cria a linha local (bot_orders + bot_order_items) a partir do que
 * chegou do celular. Itens cujo product_id não existe (mais) localmente
 * caem como descricao_livre, mesmo tratamento que a importação de
 * planilha usa pra "não travar tudo por causa de uma linha ruim". */
function criarPedidoLocal({ locationId, garcomNome, mesaNumero, itens, observacoes }) {
  const db = getDb();
  const orderId = randomUUID();

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO bot_orders (id, location_id, cliente_nome, cliente_telefone, tipo_entrega, status, origem, observacoes, mesa_numero)
       VALUES (?, ?, ?, 'app-garcom', 'retirada', 'novo', 'app_garcom', ?, ?)`
    ).run(orderId, locationId, garcomNome, observacoes || null, mesaNumero || null);

    for (const item of itens || []) {
      const produto = item.productId
        ? db.prepare('SELECT id, nome FROM products WHERE id = ? AND ativo = 1').get(item.productId)
        : null;
      db.prepare(
        `INSERT INTO bot_order_items (id, bot_order_id, product_id, descricao_livre, quantidade, preco_unitario)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(), orderId, produto ? produto.id : null,
        produto ? null : (item.nome || 'Item não identificado'),
        Number(item.quantidade) || 1, item.precoUnitario ?? null,
      );
    }
  });
  tx();

  return orderId;
}

/** Processa um documento de pedido recebido do Firestore — idempotente
 * (confere se já foi processado antes de fazer qualquer coisa), pra
 * suportar reconexão/reentrega do listener sem duplicar pedido. */
async function processarPedidoRecebido(docSnap, { firestore, installId }) {
  const dados = docSnap.data();
  if (dados.status !== 'novo') return; // já processado (ou com erro já registrado) antes

  const { doc, updateDoc, serverTimestamp } = require('firebase/firestore');
  const ref = doc(firestore, 'installations', installId, 'pedidos_garcom', docSnap.id);

  const dispositivo = buscarUsuarioLocalDoDispositivo(dados.garcomUid);
  if (!dispositivo) {
    await updateDoc(ref, { status: 'erro', erro: 'Dispositivo não reconhecido ou revogado nesta loja.', processadoEm: serverTimestamp() }).catch(() => {});
    return;
  }

  try {
    const db = getDb();
    const location = db.prepare('SELECT id FROM locations LIMIT 1').get();
    if (!location) throw new Error('Nenhum local cadastrado nesta instalação.');

    const orderId = criarPedidoLocal({
      locationId: location.id,
      garcomNome: dispositivo.vinculo_nome,
      mesaNumero: dados.mesaNumero || null,
      itens: dados.itens || [],
      observacoes: dados.observacoes || null,
    });

    let saleId = null;
    if (dados.mesaNumero) {
      const botOrderService = require('./botOrderService');
      const resultado = botOrderService.lancarPedidoNaMesa({
        orderId, operadorId: dispositivo.vinculo_user_id, deviceId: dados.garcomUid,
      });
      if (resultado.ok) saleId = resultado.saleId;
      // Se não conseguiu lançar na mesa (ex: mesa não existe mais), o
      // pedido continua em bot_orders como 'novo' pra alguém resolver
      // manualmente pela tela de Separação -- não é tratado como falha
      // fatal do recebimento em si.
    }

    await updateDoc(ref, {
      status: 'recebido', bot_order_id: orderId, saleId: saleId || null, processadoEm: serverTimestamp(),
    });
  } catch (err) {
    console.error('[pedidoGarcomSyncService] falha ao processar pedido do garçom:', err);
    await updateDoc(ref, { status: 'erro', erro: err.message || 'Erro ao processar o pedido.', processadoEm: serverTimestamp() }).catch(() => {});
  }
}

let pararEscuta = null;

/** Escuta em tempo real pedidos novos do PWA do garçom — chamado uma
 * vez no início do app (main.js), mesmo padrão de
 * productSyncService.iniciarEscutaProdutos. */
function iniciarEscutaPedidosGarcom() {
  try {
    if (pararEscuta) { pararEscuta(); pararEscuta = null; }

    const licenseService = require('./licenseService');
    const pdvRegistryService = require('./pdvRegistryService');
    const { collection, query, where, onSnapshot } = require('firebase/firestore');
    const firestore = licenseService.getLicenseFirestore();
    const installId = pdvRegistryService.getOrCreateDeviceUid();

    const ref = query(
      collection(firestore, 'installations', installId, 'pedidos_garcom'),
      where('status', '==', 'novo')
    );

    pararEscuta = onSnapshot(
      ref,
      (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'removed') return;
          processarPedidoRecebido(change.doc, { firestore, installId });
        });
      },
      (err) => console.error('[pedidoGarcomSyncService] escuta de pedidos do garçom falhou:', err)
    );
  } catch (err) {
    console.error('[pedidoGarcomSyncService] não foi possível iniciar a escuta:', err);
  }
}

module.exports = {
  iniciarEscutaPedidosGarcom,
  // Exportados só pra teste (a parte local/SQLite, sem depender de rede).
  criarPedidoLocal, buscarUsuarioLocalDoDispositivo,
};
