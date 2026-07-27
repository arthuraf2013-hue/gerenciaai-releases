const { ipcMain, dialog, BrowserWindow } = require('electron');
const authService = require('../services/authService');
const productService = require('../services/productService');
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
const backupService = require('../services/backupService');
const updateService = require('../services/updateService');
const customerService = require('../services/customerService');
const supplierService = require('../services/supplierService');
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
  safeHandle('auth:changeOwnPin', (_e, { userId, pinAtual, novoPin }) => authService.changeOwnPin(userId, pinAtual, novoPin));

  // --- Produtos ---
  safeHandle('product:findByBarcode', (_e, { codigoBarras }) => productService.findByBarcode(codigoBarras));
  safeHandle('product:list', (_e, opts) => productService.list(opts));
  safeHandle('product:count', (_e, opts) => productService.count(opts));
  safeHandle('product:listCategories', () => productService.listCategories());
  safeHandle('product:upsert', (_e, product) => productService.upsert(product));
  safeHandle('product:deactivate', (_e, { productId }) => productService.deactivate(productId));
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
  safeHandle('stock:adjust', (_e, payload) => stockService.adjustStock(payload));

  // --- PDV / Vendas ---
  safeHandle('sale:open', (_e, payload) => saleService.openSale(payload));
  safeHandle('sale:getOrOpenCurrent', (_e, payload) => saleService.getOrOpenCurrentSale(payload));
  safeHandle('sale:listByRange', (_e, payload) => saleService.listSalesByRange(payload));
  safeHandle('sale:listRecentlySold', (_e, payload) => saleService.listRecentlySold(payload));
  safeHandle('sale:addItem', (_e, payload) => saleService.addItem(payload));
  safeHandle('sale:addPayment', (_e, payload) => saleService.addPayment(payload));
  safeHandle('sale:removePayment', (_e, payload) => saleService.removePayment(payload));
  safeHandle('sale:finalize', (_e, { saleId }) => saleService.finalizeSale(saleId));

  // --- Cancelamento seguro (exige autorização de gerente) ---
  safeHandle('sale:cancelItem', (_e, payload) => saleService.cancelSaleItem(payload));
  safeHandle('sale:needsManagerAuthForCancel', (_e, { saleId }) => saleService.needsManagerAuthForCancel(saleId));
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
  safeHandle('ai:updateSettings', (_e, payload) => aiService.updateAiSettings(payload));
  safeHandle('ai:extractAttachment', (_e, { attachmentId }) => aiService.extractAttachment(attachmentId));

  // --- Abertura/fechamento de caixa ---
  safeHandle('cash:getOpenSession', (_e, { locationId }) => cashService.getOpenSession(locationId));
  safeHandle('cash:open', (_e, payload) => cashService.openSession(payload));
  safeHandle('cash:getSummary', (_e, { sessionId }) => cashService.getSessionSummary(sessionId));
  safeHandle('cash:close', (_e, payload) => cashService.closeSession(payload));

  // --- Fiscal (configuração + ponto de emissão, ver fiscalService.js) ---
  safeHandle('fiscal:getConfig', () => fiscalService.getFiscalConfigPublic());
  safeHandle('fiscal:updateConfig', (_e, payload) => fiscalService.updateFiscalConfig(payload));
  safeHandle('fiscal:emitirNFCe', (_e, { saleId }) => fiscalService.emitirNFCe(saleId));
  safeHandle('fiscal:listNfceForSale', (_e, { saleId }) => fiscalService.listNfceForSale(saleId));

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

  // --- Sincronização entre PDVs (Fase 1: numeração por CNPJ, opcional) ---
  safeHandle('pdvRegistry:getConfig', () => pdvRegistryService.getFirebaseConfigPublic());
  safeHandle('pdvRegistry:updateConfig', (_e, payload) => pdvRegistryService.updateFirebaseConfig(payload));
  safeHandle('pdvRegistry:getStatus', () => pdvRegistryService.getStatus());
  safeHandle('pdvRegistry:register', () => pdvRegistryService.registerPdv());
  safeHandle('pdvRegistry:checkConnection', () => pdvRegistryService.checkConnection());
  safeHandle('salesSync:getConsolidated', (_e, payload) => salesSyncService.getConsolidated(payload));

  // --- Clientes, fiado e fidelidade ---
  safeHandle('customer:list', (_e, opts) => customerService.listWithSaldo(opts));
  safeHandle('customer:upsert', (_e, customer) => customerService.upsert(customer));
  safeHandle('customer:getCreditHistory', (_e, { customerId }) => customerService.getCreditHistory(customerId));
  safeHandle('customer:registrarPagamento', (_e, payload) => customerService.registrarPagamento(payload));
  safeHandle('loyalty:getConfig', () => customerService.getLoyaltyConfig());
  safeHandle('loyalty:updateConfig', (_e, payload) => customerService.updateLoyaltyConfig(payload));

  // --- Fornecedores e sugestão de compra ---
  safeHandle('supplier:list', (_e, opts) => supplierService.list(opts));
  safeHandle('supplier:upsert', (_e, supplier) => supplierService.upsert(supplier));
  safeHandle('supplier:suggestPurchases', (_e, payload) => supplierService.suggestPurchases(payload));

  // --- Devolução pós-venda ---
  safeHandle('return:findFinalizedSales', (_e, payload) => returnService.findFinalizedSales(payload));
  safeHandle('return:getSaleItems', (_e, { saleId }) => returnService.getSaleItemsForReturn(saleId));
  safeHandle('return:create', (_e, payload) => returnService.createReturn(payload));
  safeHandle('return:list', (_e, payload) => returnService.listReturns(payload));

  // --- Impressão de recibo ---
  safeHandle('print:receipt', (_e, { saleId }) => printService.printReceipt(saleId));
  safeHandle('print:label', (_e, payload) => printService.printLabel(payload));
  safeHandle('print:getReceiptConfig', () => printService.getReceiptConfig());
  safeHandle('print:updateReceiptConfig', (_e, payload) => printService.updateReceiptConfig(payload));

  // --- Painel de vendas (dashboard) ---
  safeHandle('dashboard:getSummary', (_e, payload) => dashboardService.getSummary(payload));
  safeHandle('dashboard:listStaleProducts', (_e, payload) => dashboardService.listStaleProducts(payload));

  // --- Vincular cliente / resgatar pontos na venda ---
  safeHandle('sale:setCustomer', (_e, { saleId, customerId }) => saleService.setCustomer(saleId, customerId));
  safeHandle('sale:redeemLoyaltyPoints', (_e, payload) => saleService.redeemLoyaltyPoints(payload));
  safeHandle('sale:applyManagerDiscount', (_e, payload) => saleService.applyManagerDiscount(payload));
  safeHandle('sale:removeManagerDiscount', (_e, { saleId }) => saleService.removeManagerDiscount(saleId));

  // --- Resumo de vendas por IA ---
  safeHandle('ai:summarizeSales', (_e, payload) => aiService.summarizeSales(payload));
  safeHandle('ai:askTutor', (_e, payload) => aiService.askTutor(payload));

  // --- Backup automático do banco ---
  safeHandle('backup:getStatus', () => backupService.getStatus());
  safeHandle('backup:runNow', () => backupService.runBackup());
  safeHandle('backup:list', () => backupService.listBackups());
  safeHandle('backup:restore', (_e, { nomeArquivo }) => {
    const result = backupService.restoreBackup(nomeArquivo);
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
  safeHandle('supply:listUpcomingExpiry', (_e, payload) => batchService.listUpcomingExpiry(payload));
  safeHandle('batch:listForProduct', (_e, { productId }) => batchService.listBatchesForProduct(productId));

  // --- Atualização automática ---
  safeHandle('update:getStatus', () => updateService.getStatus());
  safeHandle('update:check', () => updateService.checkForUpdates());
  safeHandle('update:download', () => updateService.downloadUpdate());
  safeHandle('update:install', () => updateService.quitAndInstall());
}

module.exports = { registerIpcHandlers };
