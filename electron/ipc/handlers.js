const { ipcMain, dialog, BrowserWindow } = require('electron');
const authService = require('../services/authService');
const productService = require('../services/productService');
const productSyncService = require('../services/productSyncService');
const digitalMenuService = require('../services/digitalMenuService');
const weightBarcodeService = require('../services/weightBarcodeService');
const scaleHardwareService = require('../services/scaleHardwareService');
const licenseService = require('../services/licenseService');
const messageService = require('../services/messageService');
const tableService = require('../services/tableService');
const ingredientService = require('../services/ingredientService');
const wasteService = require('../services/wasteService');
const stockService = require('../services/stockService');
const saleService = require('../services/saleService');
const profileService = require('../services/profileService');
const userService = require('../services/userService');
const importExportService = require('../services/importExportService');
const attachmentService = require('../services/attachmentService');
const aiService = require('../services/aiService');
const cashService = require('../services/cashService');
const fiscalService = require('../services/fiscalService');
const pixService = require('../services/pixService');
const timeService = require('../services/timeService');
const reportService = require('../services/reportService');
const pdvRegistryService = require('../services/pdvRegistryService');
const salesSyncService = require('../services/salesSyncService');
const posDisplayService = require('../services/posDisplayService');
const backupService = require('../services/backupService');
const updateService = require('../services/updateService');
const customerService = require('../services/customerService');
const petService = require('../services/petService');
const deliveryService = require('../services/deliveryService');
const botOrderService = require('../services/botOrderService');
const quoteService = require('../services/quoteService');
const eyewearService = require('../services/eyewearService');
const appointmentService = require('../services/appointmentService');
const supplierService = require('../services/supplierService');
const expenseService = require('../services/expenseService');
const categoryService = require('../services/categoryService');
const returnService = require('../services/returnService');
const printService = require('../services/printService');
const dashboardService = require('../services/dashboardService');
const supplyService = require('../services/supplyService');
const batchService = require('../services/batchService');

/**
 * Envolve todo handler IPC para nunca deixar uma exceção do processo
 * principal virar uma promise rejeitada silenciosa no renderer (isso já
 * causou telas travadas em "Salvando..."/"Abrindo..." sem nenhum erro
 * visível). Se o handler já devolve {ok: false, error}, isso passa
 * direto; se algo lançar uma exceção não tratada, vira a mesma forma.
 */
function safeHandle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return await fn(event, payload);
    } catch (err) {
      console.error(`[ipc:${channel}]`, err);
      return { ok: false, error: err?.message || 'Erro inesperado no processo principal.' };
    }
  });
}

function registerIpcHandlers() {
  // --- Auth ---
  safeHandle('auth:login', (_e, { userId, pin }) => authService.login(userId, pin));
  safeHandle('auth:listActiveUsers', (_e, { excludeUserId } = {}) => authService.listActiveUsers({ excludeUserId }));
  safeHandle('auth:listAuditLog', (_e, payload) => authService.listAuditLog(payload));
  safeHandle('auth:getSecurityConfig', () => authService.getSecurityConfig());
  safeHandle('auth:updateSecurityConfig', (_e, { requestingUserId, ...payload }) => authService.updateSecurityConfig(requestingUserId, payload));
  safeHandle('auth:changeOwnPin', (_e, { userId, pinAtual, novoPin }) => authService.changeOwnPin(userId, pinAtual, novoPin));

  // --- Produtos ---
  safeHandle('product:findByBarcode', (_e, { codigoBarras }) => productService.findByBarcode(codigoBarras));
  safeHandle('product:findByBalancaCode', (_e, { codigoBalanca }) => productService.findByBalancaCode(codigoBalanca));
  safeHandle('product:list', (_e, opts) => productService.list(opts));
  safeHandle('product:count', (_e, opts) => productService.count(opts));
  safeHandle('product:countConflitosCodigoBarrasPendentes', () => productService.countConflitosCodigoBarrasPendentes());
  safeHandle('product:findDuplicates', () => productService.findDuplicateProducts());
  safeHandle('product:alertasDeMargem', () => productService.alertasDeMargem());
  safeHandle('product:aplicarDescontoValidade', (_e, payload) => productService.aplicarDescontoValidade(payload));
  safeHandle('product:removerDescontoValidade', (_e, { productId }) => productService.removerDescontoValidade(productId));
  safeHandle('product:findAlsoBoughtWith', (_e, { productId }) => productService.findAlsoBoughtWith(productId));
  safeHandle('productSync:buscarNoGrupo', (_e, { query }) => productSyncService.buscarNoCatalogoDoGrupo(query));
  safeHandle('productSync:buscarNoGrupoPorCodigoBarras', (_e, { codigoBarras }) => productSyncService.buscarNoCatalogoDoGrupoPorCodigoBarras(codigoBarras));
  safeHandle('productSync:importarDoGrupo', (_e, dados) => {
    productService.aplicarProdutoSincronizado(dados.id, dados);
    return { ok: true };
  });
  safeHandle('product:merge', (_e, payload) => productService.mergeProducts(payload));
  safeHandle('product:listCategories', () => productService.listCategories());
  safeHandle('product:upsert', (_e, product) => productService.upsert(product));
  safeHandle('product:deactivate', (_e, { productId }) => productService.deactivate(productId));
  safeHandle('product:clearAll', (_e, { requestingUserId } = {}) => productService.clearAllProducts(requestingUserId));
  safeHandle('product:generateInternalBarcode', (_e, { productId }) => productService.generateInternalBarcode(productId));
  safeHandle('product:listPriceHistory', (_e, { productId }) => productService.listPriceHistory(productId));
  safeHandle('product:getFotoDataUrl', (_e, { productId }) => productService.getFotoDataUrl(productId));
  safeHandle('product:removeFoto', (_e, { productId }) => productService.removeFoto(productId));

  safeHandle('product:setFoto', async (_e, { productId }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Selecionar foto do produto',
      properties: ['openFile'],
      filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
    return productService.setFoto(productId, filePaths[0]);
  });

  // --- Estoque ---
  safeHandle('stock:getForLocation', (_e, { locationId }) => stockService.getStockForLocation(locationId));
  safeHandle('stock:listLowStock', (_e, { locationId }) => stockService.listLowStock(locationId));
  safeHandle('stock:listAlerts', (_e, { locationId }) => stockService.listAlerts(locationId, profileService.getActiveProfile()));
  safeHandle('stock:previsaoDeRuptura', (_e, { locationId }) => stockService.previsaoDeRuptura(locationId));
  safeHandle('stock:sugestoesDescontoValidade', (_e, { locationId }) => stockService.sugestoesDescontoValidade({ locationId }));
  safeHandle('stock:adjust', (_e, payload) => stockService.adjustStock(payload));

  // --- PDV / Vendas ---
  safeHandle('sale:open', (_e, payload) => saleService.openSale(payload));
  safeHandle('sale:getOrOpenCurrent', (_e, payload) => saleService.getOrOpenCurrentSale(payload));
  safeHandle('sale:listByRange', (_e, payload) => saleService.listSalesByRange(payload));
  safeHandle('sale:listRecentlySold', (_e, payload) => saleService.listRecentlySold(payload));
  safeHandle('posDisplay:getConfig', () => posDisplayService.getConfig());
  safeHandle('posDisplay:updateConfig', (_e, payload) => posDisplayService.updateConfig(payload));
  safeHandle('sale:addItem', (_e, payload) => saleService.addItem(payload));
  safeHandle('sale:addPayment', (_e, payload) => saleService.addPayment(payload));
  safeHandle('sale:removePayment', (_e, payload) => saleService.removePayment(payload));
  safeHandle('sale:setItemNote', (_e, payload) => saleService.setItemNote(payload));
  safeHandle('sale:setItemPerson', (_e, payload) => saleService.setItemPerson(payload));
  safeHandle('sale:setItemPrice', (_e, payload) => saleService.setItemPrice(payload));
  safeHandle('sale:editarHistorico', (_e, payload) => saleService.editarHistoricoVenda(payload));
  safeHandle('sale:finalize', (_e, { saleId }) => saleService.finalizeSaleComVerificacaoDeGrupo(saleId));

  // --- Cancelamento seguro (exige autorização de gerente) ---
  safeHandle('sale:cancelItem', (_e, payload) => saleService.cancelSaleItem(payload));
  safeHandle('sale:needsManagerAuthForCancel', (_e, { saleId }) => saleService.needsManagerAuthForCancel(saleId));
  safeHandle('sale:getItemsDetail', (_e, { saleId }) => saleService.getSaleItemsDetail(saleId));
  safeHandle('sale:excluirDoHistorico', (_e, payload) => saleService.excluirDoHistorico(payload));
  safeHandle('sale:reexibirNoHistorico', (_e, payload) => saleService.reexibirNoHistorico(payload));

  // --- Controle de mesas (restaurante) ---
  safeHandle('table:list', (_e, { locationId }) => tableService.listTables(locationId));
  safeHandle('table:create', (_e, payload) => tableService.createTable(payload));
  safeHandle('table:delete', (_e, { tableId }) => tableService.deleteTable(tableId));
  safeHandle('table:open', (_e, payload) => tableService.openTable(payload));
  safeHandle('table:getCart', (_e, { saleId }) => tableService.getTableCart(saleId));
  safeHandle('table:release', (_e, { tableId }) => tableService.releaseTable(tableId));

  // --- Licenciamento ---
  safeHandle('license:check', () => licenseService.checkLicense());
  safeHandle('license:getStatus', () => licenseService.computeAccessStatus());
  safeHandle('message:getForDisplay', () => messageService.getMensagensParaExibir());
  safeHandle('message:getMotivoBloqueio', () => messageService.getMotivoBloqueio());
  safeHandle('table:markCleaned', (_e, { tableId }) => tableService.markCleaned(tableId));
  safeHandle('table:markReserved', (_e, { tableId, reservadoPara }) => tableService.markReserved(tableId, reservadoPara));
  safeHandle('table:cancelReservation', (_e, { tableId }) => tableService.cancelReservation(tableId));
  safeHandle('table:transfer', (_e, { fromTableId, toTableId }) => tableService.transferTable({ fromTableId, toTableId }));
  safeHandle('table:updatePeople', (_e, { tableId, pessoas }) => tableService.updateTablePeople({ tableId, pessoas }));
  safeHandle('table:desocupar', (_e, payload) => tableService.desocuparMesa(payload));

  // --- Insumos e ficha técnica ---
  safeHandle('ingredient:list', (_e, opts) => ingredientService.list(opts));
  safeHandle('ingredient:upsert', (_e, ingredient) => ingredientService.upsert(ingredient));
  safeHandle('ingredient:deactivate', (_e, { id }) => ingredientService.deactivate(id));
  safeHandle('ingredient:getRecipe', (_e, { productId }) => ingredientService.getRecipe(productId));
  safeHandle('ingredient:setRecipe', (_e, { productId, itens }) => ingredientService.setRecipe(productId, itens));
  safeHandle('ingredient:computeDishCost', (_e, { productId }) => ingredientService.computeDishCost(productId));

  // --- Desperdício ---
  safeHandle('waste:suggestCost', (_e, payload) => wasteService.suggestCost(payload));
  safeHandle('waste:register', (_e, payload) => wasteService.registerWaste(payload));
  safeHandle('waste:list', (_e, payload) => wasteService.listWaste(payload));
  safeHandle('waste:getSummary', (_e, payload) => wasteService.getWasteSummary(payload));
  safeHandle('waste:getByDay', (_e, payload) => wasteService.getWasteByDay(payload));
  safeHandle('sale:cancel', (_e, payload) => saleService.cancelSale(payload));

  // --- Perfil de negócio / configurações ---
  safeHandle('profile:listAvailable', () => profileService.listAvailableProfiles());
  safeHandle('profile:getActive', () => profileService.getActiveProfile());
  safeHandle('profile:setActive', (_e, { profileId }) => profileService.setActiveProfile(profileId));
  safeHandle('profile:create', (_e, payload) => profileService.createProfile(payload));
  safeHandle('profile:update', (_e, { id, ...payload }) => profileService.updateProfile(id, payload));
  safeHandle('profile:duplicate', (_e, { id, novoNome }) => profileService.duplicateProfile(id, novoNome));
  safeHandle('profile:delete', (_e, { id }) => profileService.deleteProfile(id));
  safeHandle('settings:get', () => profileService.getSettings());
  safeHandle('settings:updateLocationName', (_e, { locationId, nome }) => profileService.updateLocationName(locationId, nome));

  // --- Gestão de usuários (somente admin) ---
  safeHandle('user:listAll', (_e, { requestingUserId }) => userService.listAll(requestingUserId));
  safeHandle('user:create', (_e, { requestingUserId, ...payload }) => userService.create(requestingUserId, payload));
  safeHandle('user:setActive', (_e, { requestingUserId, ...payload }) => userService.setActive(requestingUserId, payload));
  safeHandle('user:resetPin', (_e, { requestingUserId, ...payload }) => userService.resetPin(requestingUserId, payload));

  // --- Importação/exportação de planilhas de estoque ---
  safeHandle('io:exportProducts', async (_e, { locationId }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Exportar produtos e estoque',
      defaultPath: 'estoque-exportado.xlsx',
      filters: [{ name: 'Planilha Excel', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    return importExportService.exportToFile(filePath, { locationId });
  });

  safeHandle('io:importProducts', async (_e, { locationId, operadorId, deviceId }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Importar produtos e estoque',
      properties: ['openFile'],
      filters: [{ name: 'Planilha Excel', extensions: ['xlsx', 'xls', 'csv'] }],
    });
    if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
    return importExportService.importFromFile(filePaths[0], { locationId, operadorId, deviceId });
  });
  safeHandle('io:prepararRevinculacaoCodigosBarras', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Selecionar a planilha antiga com os códigos de barras',
      properties: ['openFile'],
      filters: [{ name: 'Planilha Excel ou CSV', extensions: ['xlsx', 'xls', 'csv'] }],
    });
    if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
    return importExportService.prepararRevinculacaoDeCodigosBarras(filePaths[0]);
  });
  safeHandle('io:aplicarRevinculacaoCodigosBarras', (_e, casadosAceitos) => importExportService.aplicarRevinculacaoDeCodigosBarras(casadosAceitos));
  safeHandle('productSync:prepararRevinculacaoViaGrupo', () => productSyncService.prepararRevinculacaoViaGrupo());

  // --- Anexos da venda (imagem/PDF de receita, comprovante, etc. — opcional) ---
  safeHandle('attachment:add', async (_e, { saleId, operadorId }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Anexar imagem ou PDF à venda',
      properties: ['openFile'],
      filters: [
        { name: 'Imagens e PDF', extensions: ['png', 'jpg', 'jpeg', 'webp', 'pdf'] },
      ],
    });
    if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
    return attachmentService.addAttachment({ saleId, sourceFilePath: filePaths[0], operadorId });
  });
  safeHandle('attachment:list', (_e, { saleId }) => attachmentService.listAttachments(saleId));
  safeHandle('attachment:remove', (_e, { id }) => attachmentService.removeAttachment(id));

  // --- IA (extração de dados de anexos, sob demanda, opcional) ---
  safeHandle('ai:getSettings', () => aiService.getAiSettingsPublic());
  safeHandle('ai:updateSettings', (_e, { requestingUserId, ...payload }) => aiService.updateAiSettings(requestingUserId, payload));
  safeHandle('ai:extractAttachment', (_e, { attachmentId }) => aiService.extractAttachment(attachmentId));

  // --- Abertura/fechamento de caixa ---
  safeHandle('cash:getOpenSession', (_e, { locationId }) => cashService.getOpenSession(locationId));
  safeHandle('cash:open', (_e, payload) => cashService.openSession(payload));
  safeHandle('cash:getSummary', (_e, { sessionId }) => cashService.getSessionSummary(sessionId));
  safeHandle('cash:close', (_e, payload) => cashService.closeSession(payload));
  safeHandle('cash:listClosedSessions', (_e, payload) => cashService.listClosedSessions(payload));
  safeHandle('cash:getClosedSessionsSummary', (_e, payload) => cashService.getClosedSessionsSummary(payload));

  // --- Fiscal (configuração + ponto de emissão, ver fiscalService.js) ---
  safeHandle('fiscal:getConfig', () => fiscalService.getFiscalConfigPublic());
  safeHandle('fiscal:updateConfig', (_e, { requestingUserId, ...payload }) => fiscalService.updateFiscalConfig(requestingUserId, payload));
  safeHandle('fiscal:emitirNFCe', (_e, { saleId }) => fiscalService.emitirNFCe(saleId));
  safeHandle('fiscal:reenviarNFCe', (_e, { nfceId }) => fiscalService.reenviarNFCe(nfceId));
  safeHandle('fiscal:listNfceForSale', (_e, { saleId }) => fiscalService.listNfceForSale(saleId));
  safeHandle('fiscal:livroDeControlados', (_e, payload) => fiscalService.livroDeControlados(payload));
  safeHandle('fiscal:selectCertificado', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Selecionar certificado digital (A1)',
      properties: ['openFile'],
      filters: [{ name: 'Certificado digital', extensions: ['pfx', 'p12'] }],
    });
    if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
    return { ok: true, filePath: filePaths[0] };
  });

  // --- Pagamento / Pix ---
  safeHandle('payment:getConfig', () => pixService.getPaymentConfig());
  safeHandle('payment:updateConfig', (_e, payload) => pixService.updatePaymentConfig(payload));
  safeHandle('payment:buildPixPayload', (_e, payload) => pixService.buildPixPayload(payload));

  // --- Relógio sincronizado (Brasília) ---
  safeHandle('time:getStatus', () => timeService.getStatus());
  safeHandle('time:getBrasiliaNow', () => timeService.getBrasiliaNowParts());
  safeHandle('time:syncNow', () => timeService.syncNow());

  // --- Relatórios ---
  safeHandle('report:exportSales', async (_e, { locationId, dataInicio, dataFim }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Exportar relatório de vendas',
      defaultPath: `relatorio-vendas-${dataInicio}-a-${dataFim}.xlsx`,
      filters: [{ name: 'Planilha Excel', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    return reportService.exportSalesReport(filePath, { locationId, dataInicio, dataFim });
  });

  safeHandle('report:exportAudit', async (_e, { dataInicio, dataFim }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Exportar auditoria',
      defaultPath: `auditoria-${dataInicio}-a-${dataFim}.xlsx`,
      filters: [{ name: 'Planilha Excel', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    return reportService.exportAuditReport(filePath, { dataInicio, dataFim });
  });

  safeHandle('report:exportPurchaseSuggestions', async (_e, { locationId }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Exportar lista de compra sugerida',
      defaultPath: 'lista-de-compra-sugerida.xlsx',
      filters: [{ name: 'Planilha Excel', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    return reportService.exportPurchaseSuggestions(filePath, { locationId });
  });

  safeHandle('report:exportWaste', async (_e, { locationId, dataInicio, dataFim }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Exportar desperdício',
      defaultPath: `desperdicio-${dataInicio}-a-${dataFim}.xlsx`,
      filters: [{ name: 'Planilha Excel', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    return reportService.exportWasteReport(filePath, { locationId, dataInicio, dataFim });
  });

  safeHandle('report:getCustomerPurchase', (_e, { customerId, dataInicio, dataFim }) =>
    reportService.getCustomerPurchaseReport({ customerId, dataInicio, dataFim }));
  safeHandle('report:exportCustomerPurchase', async (_e, { customerId, dataInicio, dataFim, nomeCliente }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Exportar compras do cliente',
      defaultPath: `compras-${(nomeCliente || 'cliente').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${dataInicio}-a-${dataFim}.xlsx`,
      filters: [{ name: 'Planilha Excel', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    return reportService.exportCustomerPurchaseReport(filePath, { customerId, dataInicio, dataFim });
  });

  // --- Sincronização entre PDVs (Fase 1: numeração por CNPJ, opcional) ---
  safeHandle('pdvRegistry:getStatus', () => pdvRegistryService.getSyncStatus());
  safeHandle('salesSync:getConsolidated', (_e, payload) => salesSyncService.getConsolidated(payload));
  safeHandle('salesSync:getGroupHistory', (_e, payload) => salesSyncService.getGroupHistory(payload));
  safeHandle('salesSync:pushTodoOHistorico', () => salesSyncService.pushTodoOHistorico({ diasRecentes: 60 }));

  // --- Clientes, fiado e fidelidade ---
  safeHandle('customer:list', (_e, opts) => customerService.listWithSaldo(opts));
  safeHandle('customer:upsert', (_e, customer) => customerService.upsert(customer));
  safeHandle('customer:getCreditHistory', (_e, { customerId }) => customerService.getCreditHistory(customerId));
  safeHandle('customer:registrarPagamento', (_e, payload) => customerService.registrarPagamento(payload));
  safeHandle('customer:listQueSumiram', () => customerService.listClientesQueSumiram());
  safeHandle('customer:montarLinkReconquista', (_e, { customerId }) => customerService.montarLinkReconquista(customerId));
  safeHandle('pet:listByCustomer', (_e, { customerId }) => petService.listByCustomer(customerId));
  safeHandle('pet:upsert', (_e, pet) => petService.upsert(pet));
  safeHandle('pet:deactivate', (_e, { petId }) => petService.deactivate(petId));
  safeHandle('pet:listLembretesPendentes', () => petService.listLembretesPendentes());
  safeHandle('pet:montarLinkLembrete', (_e, { petId }) => petService.montarLinkLembrete(petId));

  safeHandle('delivery:listRoutes', () => deliveryService.listRoutes());
  safeHandle('delivery:upsertRoute', (_e, route) => deliveryService.upsertRoute(route));
  safeHandle('delivery:deactivateRoute', (_e, { id }) => deliveryService.deactivateRoute(id));
  safeHandle('delivery:listVehicles', () => deliveryService.listVehicles());
  safeHandle('delivery:upsertVehicle', (_e, vehicle) => deliveryService.upsertVehicle(vehicle));
  safeHandle('delivery:deactivateVehicle', (_e, { id }) => deliveryService.deactivateVehicle(id));
  safeHandle('delivery:listPersons', () => deliveryService.listPersons());
  safeHandle('delivery:upsertPerson', (_e, person) => deliveryService.upsertPerson(person));
  safeHandle('delivery:deactivatePerson', (_e, { id }) => deliveryService.deactivatePerson(id));
  safeHandle('delivery:create', (_e, payload) => deliveryService.createDelivery(payload));
  safeHandle('delivery:assign', (_e, payload) => deliveryService.assignDelivery(payload));
  safeHandle('delivery:updateStatus', (_e, payload) => deliveryService.updateDeliveryStatus(payload));
  safeHandle('delivery:list', (_e, payload) => deliveryService.listDeliveries(payload));
  safeHandle('delivery:montarLinkStatus', (_e, { deliveryId }) => deliveryService.montarLinkStatusEntrega(deliveryId));

  // --- Pedidos do bot de WhatsApp ("Separação") ---
  safeHandle('botOrders:getConfig', () => botOrderService.getConfig());
  safeHandle('botOrders:updateConfig', (_e, payload) => botOrderService.updateConfig(payload));
  safeHandle('botOrders:create', (_e, payload) => botOrderService.createOrder(payload));
  safeHandle('botOrders:list', (_e, payload) => botOrderService.listOrders(payload));
  safeHandle('botOrders:getWithItems', (_e, { orderId }) => botOrderService.getOrderWithItems(orderId));
  safeHandle('botOrders:updateStatus', (_e, payload) => botOrderService.updateOrderStatus(payload));
  safeHandle('botOrders:updateItemStatus', (_e, payload) => botOrderService.updateItemStatus(payload));
  safeHandle('botOrders:listInStockByCategory', (_e, payload) => botOrderService.listInStockByCategory(payload));

  safeHandle('quote:create', (_e, payload) => quoteService.createQuote(payload));
  safeHandle('quote:addItem', (_e, payload) => quoteService.addQuoteItem(payload));
  safeHandle('quote:removeItem', (_e, { itemId }) => quoteService.removeQuoteItem(itemId));
  safeHandle('quote:get', (_e, { quoteId }) => quoteService.getQuote(quoteId));
  safeHandle('quote:list', (_e, payload) => quoteService.listQuotes(payload));
  safeHandle('quote:cancel', (_e, { quoteId }) => quoteService.cancelQuote(quoteId));
  safeHandle('quote:convertToSale', (_e, payload) => quoteService.convertToSale(payload));

  safeHandle('eyewear:listByCustomer', (_e, { customerId }) => eyewearService.listByCustomer(customerId));
  safeHandle('eyewear:upsert', (_e, receita) => eyewearService.upsert(receita));
  safeHandle('eyewear:deactivate', (_e, { id }) => eyewearService.deactivate(id));

  safeHandle('appointment:listProfessionals', () => appointmentService.listProfessionals());
  safeHandle('appointment:upsertProfessional', (_e, prof) => appointmentService.upsertProfessional(prof));
  safeHandle('appointment:deactivateProfessional', (_e, { id }) => appointmentService.deactivateProfessional(id));
  safeHandle('appointment:create', (_e, payload) => appointmentService.createAppointment(payload));
  safeHandle('appointment:reschedule', (_e, payload) => appointmentService.rescheduleAppointment(payload));
  safeHandle('appointment:updateStatus', (_e, payload) => appointmentService.updateAppointmentStatus(payload));
  safeHandle('appointment:list', (_e, payload) => appointmentService.listAppointments(payload));
  safeHandle('appointment:montarLinkConfirmacao', (_e, { appointmentId }) => appointmentService.montarLinkConfirmacao(appointmentId));
  safeHandle('loyalty:getConfig', () => customerService.getLoyaltyConfig());
  safeHandle('loyalty:updateConfig', (_e, payload) => customerService.updateLoyaltyConfig(payload));

  // --- Fornecedores e sugestão de compra ---
  safeHandle('supplier:list', (_e, opts) => supplierService.list(opts));
  safeHandle('supplier:upsert', (_e, supplier) => supplierService.upsert(supplier));
  safeHandle('supplier:suggestPurchases', (_e, payload) => supplierService.suggestPurchases(payload));
  safeHandle('expense:create', (_e, payload) => expenseService.create(payload));
  safeHandle('expense:markAsPaid', (_e, payload) => expenseService.markAsPaid(payload));
  safeHandle('expense:list', (_e, payload) => expenseService.list(payload));
  safeHandle('expense:listPending', (_e, payload) => expenseService.listPending(payload));
  safeHandle('expense:remove', (_e, payload) => expenseService.remove(payload));
  safeHandle('category:list', () => categoryService.list());
  safeHandle('category:create', (_e, payload) => categoryService.create(payload));
  safeHandle('category:rename', (_e, payload) => categoryService.rename(payload));
  safeHandle('category:remove', (_e, payload) => categoryService.remove(payload));
  safeHandle('category:sugerirComIA', (_e, payload) => categoryService.sugerirCategoriasComIA(payload));
  safeHandle('category:aplicarSugestoes', (_e, payload) => categoryService.aplicarSugestoes(payload));

  // --- Devolução pós-venda ---
  safeHandle('return:findFinalizedSales', (_e, payload) => returnService.findFinalizedSales(payload));
  safeHandle('return:getSaleItems', (_e, { saleId }) => returnService.getSaleItemsForReturn(saleId));
  safeHandle('return:create', (_e, payload) => returnService.createReturn(payload));
  safeHandle('return:list', (_e, payload) => returnService.listReturns(payload));

  // --- Impressão de recibo ---
  safeHandle('print:receipt', (_e, { saleId }) => printService.printReceipt(saleId));
  safeHandle('print:sendReceiptWhatsapp', (_e, { saleId }) => {
    const result = printService.buildReceiptWhatsappLink(saleId);
    if (!result.ok) return result;
    require('electron').shell.openExternal(result.url);
    return { ok: true, temTelefoneCliente: result.temTelefoneCliente };
  });
  safeHandle('print:label', (_e, payload) => printService.printLabel(payload));
  safeHandle('print:kitchenTicket', (_e, { saleId, mesaLabel }) => printService.printKitchenTicket(saleId, mesaLabel));
  safeHandle('print:dailyMenu', (_e, { itens }) => printService.printDailyMenu(itens));
  safeHandle('print:listPrinters', () => printService.listPrinters());
  safeHandle('print:testPage', () => printService.printTestPage());
  safeHandle('product:listDailyMenu', () => productService.listDailyMenu());

  // --- Cardápio digital (restaurante/padaria) ---
  safeHandle('digitalMenu:getConfig', () => digitalMenuService.getConfig());
  safeHandle('digitalMenu:updateConfig', (_e, payload) => digitalMenuService.updateConfig(payload));
  safeHandle('digitalMenu:generateHtml', () => digitalMenuService.generateHtml());
  safeHandle('digitalMenu:exportHtml', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Exportar cardápio digital',
      defaultPath: 'cardapio.html',
      filters: [{ name: 'Página HTML', extensions: ['html'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    const fs = require('fs');
    fs.writeFileSync(filePath, digitalMenuService.generateHtml(), 'utf-8');
    return { ok: true, filePath };
  });
  safeHandle('digitalMenu:openInBrowser', () => {
    const { shell } = require('electron');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpPath = path.join(os.tmpdir(), 'gerenciaai-cardapio-preview.html');
    fs.writeFileSync(tmpPath, digitalMenuService.generateHtml(), 'utf-8');
    shell.openPath(tmpPath);
    return { ok: true };
  });

  // --- Balança: etiqueta de peso variável ---
  safeHandle('weightBarcode:getConfig', () => weightBarcodeService.getConfig());
  safeHandle('weightBarcode:updateConfig', (_e, payload) => weightBarcodeService.updateConfig(payload));
  safeHandle('weightBarcode:parse', (_e, { barcode }) => weightBarcodeService.parseWeightBarcode(barcode));
  safeHandle('weightBarcode:listFormatos', () => weightBarcodeService.FORMATOS);

  // --- Balança digital (porta serial) ---
  safeHandle('scaleHardware:getConfig', () => scaleHardwareService.getConfig());
  safeHandle('scaleHardware:updateConfig', (_e, payload) => scaleHardwareService.updateConfig(payload));
  safeHandle('scaleHardware:listPorts', () => scaleHardwareService.listPorts());
  safeHandle('scaleHardware:conectar', () => scaleHardwareService.conectar());
  safeHandle('scaleHardware:desconectar', () => { scaleHardwareService.desconectar(); return { ok: true }; });
  safeHandle('scaleHardware:getLeituraAtual', () => scaleHardwareService.getLeituraAtual());

  safeHandle('print:getReceiptConfig', () => printService.getReceiptConfig());
  safeHandle('print:updateReceiptConfig', (_e, payload) => printService.updateReceiptConfig(payload));

  // --- Painel de vendas (dashboard) ---
  safeHandle('dashboard:getSummary', (_e, payload) => dashboardService.getSummary(payload));
  safeHandle('dashboard:listStaleProducts', (_e, payload) => dashboardService.listStaleProducts(payload));
  safeHandle('dashboard:getSalesByOperator', (_e, payload) => dashboardService.getSalesByOperator(payload));
  safeHandle('dashboard:getRelatorioProdutos', (_e, payload) => dashboardService.getRelatorioProdutos(payload));
  safeHandle('dashboard:getResultadoSimples', (_e, payload) => dashboardService.getResultadoSimples(payload));

  // --- Vincular cliente / resgatar pontos na venda ---
  safeHandle('sale:setCustomer', (_e, { saleId, customerId }) => saleService.setCustomer(saleId, customerId));
  safeHandle('sale:redeemLoyaltyPoints', (_e, payload) => saleService.redeemLoyaltyPoints(payload));
  safeHandle('sale:applyManagerDiscount', (_e, payload) => saleService.applyManagerDiscount(payload));
  safeHandle('sale:removeManagerDiscount', (_e, { saleId }) => saleService.removeManagerDiscount(saleId));
  safeHandle('sale:setServiceCharge', (_e, { saleId, percentual }) => saleService.setServiceCharge(saleId, percentual));

  // --- Resumo de vendas por IA ---
  safeHandle('ai:summarizeSales', (_e, payload) => aiService.summarizeSales(payload));
  safeHandle('ai:askTutor', (_e, payload) => aiService.askTutor(payload));

  // --- Backup automático do banco ---
  safeHandle('backup:getStatus', () => backupService.getStatus());
  safeHandle('backup:runNow', () => backupService.runBackup());
  safeHandle('backup:list', () => backupService.listBackups());
  safeHandle('backup:restore', (_e, { requestingUserId, nomeArquivo }) => {
    const result = backupService.restoreBackup(requestingUserId, nomeArquivo);
    if (result.ok) {
      // Reinicia o app pra reabrir o banco já restaurado — nunca reusa a
      // conexão antiga no mesmo processo depois de trocar o arquivo.
      setTimeout(() => {
        require('electron').app.relaunch();
        require('electron').app.exit(0);
      }, 300);
    }
    return result;
  });
  safeHandle('backup:openFolder', () => {
    require('electron').shell.openPath(backupService.backupsDir());
    return { ok: true };
  });
  safeHandle('backup:chooseSecondaryFolder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Escolher pasta secundária de backup (ex: pendrive, pasta do OneDrive/Google Drive)',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
    return backupService.updateConfig({ pastaSecundaria: filePaths[0] });
  });

  // --- Abastecimento de estoque (leitura de nota de compra + lotes) ---
  safeHandle('supply:pickAndExtract', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Selecionar nota de compra (PDF, foto ou planilha)',
      properties: ['openFile'],
      filters: [
        { name: 'Nota de compra', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'csv', 'xlsx', 'xls'] },
      ],
    });
    if (canceled || filePaths.length === 0) return { ok: false, canceled: true };
    const result = await supplyService.extractFromFile(filePaths[0]);
    return { ...result, arquivo: filePaths[0].split(/[\\/]/).pop() };
  });
  safeHandle('supply:confirmEntries', (_e, payload) => supplyService.confirmEntries(payload));
  safeHandle('supply:getDraft', () => supplyService.getDraft());
  safeHandle('supply:saveDraft', (_e, payload) => supplyService.saveDraft(payload));
  safeHandle('supply:clearDraft', () => supplyService.clearDraft());
  safeHandle('supply:listUpcomingExpiry', (_e, payload) => batchService.listUpcomingExpiry(payload));
  safeHandle('batch:listForProduct', (_e, { productId }) => batchService.listBatchesForProduct(productId));

  // --- Atualização automática ---
  safeHandle('update:getStatus', () => updateService.getStatus());
  safeHandle('update:getForcedStatus', () => updateService.verificarAtualizacaoObrigatoria());
  safeHandle('error:report', (_e, { mensagem, stack, contexto }) => {
    require('../services/errorReportService').reportarErro({ mensagem, stack, contexto });
    return { ok: true };
  });
  safeHandle('update:check', () => updateService.checkForUpdates());
  safeHandle('update:download', () => updateService.downloadUpdate());
  safeHandle('update:install', () => updateService.quitAndInstall());
}

module.exports = { registerIpcHandlers };
