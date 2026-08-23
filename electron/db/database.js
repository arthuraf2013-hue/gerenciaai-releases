const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const timeService = require('../services/timeService');

let db;

/** Caminho da pasta de dados do usuário. 'electron' é carregado sob demanda
 * aqui dentro (não no topo do arquivo) porque database.js é usado por
 * praticamente todo o app, incluindo os testes automatizados (`node
 * --test`), que rodam fora de um processo Electron de verdade. Carregar
 * 'electron' no topo do arquivo forçava TODO teste a depender do binário
 * do Electron estar instalado e íntegro — o que já causou falha
 * aleatória no CI (vários arquivos de teste rodando em paralelo, cada um
 * tentando validar/reextrair o binário do Electron ao mesmo tempo,
 * colidindo com "File exists" no resources.pak). Em testes, `app` nunca
 * é necessário (o banco é sempre injetado via setDbForTesting), então
 * isso nunca chega a rodar nesse caso. */
function getUserDataPath() {
  let app;
  try {
    ({ app } = require('electron'));
  } catch {
    app = null;
  }
  return app ? app.getPath('userData') : path.join(__dirname, '../../.data');
}

function getDb() {
  if (db) return db;

  const userDataPath = getUserDataPath();
  fs.mkdirSync(userDataPath, { recursive: true });
  const dbPath = path.join(userDataPath, 'gerenciaai.sqlite3');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // melhor para escrita concorrente PDV + sync em background
  // Com WAL, 'NORMAL' já garante durabilidade contra crash do processo
  // (o cenário real que importa aqui) -- só uma queda de energia no
  // meio de um checkpoint poderia perder as últimas transações, o que
  // 'FULL' evitaria ao custo de um fsync extra em toda transação. Troca
  // que vale a pena: escrita bem mais rápida (cada venda, cada
  // movimento de estoque) num app de PDV que já não é single-user.
  db.pragma('synchronous = NORMAL');
  // Cache maior e mmap ajudam consultas de relatório/dashboard que
  // varrem tabelas grandes (sales, audit_log) -- padrão do SQLite é
  // conservador demais pro tamanho que esse banco cresce com o tempo.
  db.pragma('cache_size = -20000'); // ~20MB de cache de páginas (negativo = KB)
  db.pragma('mmap_size = 268435456'); // 256MB
  db.pragma('foreign_keys = ON');

  // Toda vez que o schema usa NOW_SYNCED() (no lugar de datetime('now')),
  // isso chama o relógio sincronizado com a internet — não o relógio cru
  // do sistema operacional, que pode estar desconfigurado.
  db.function('NOW_SYNCED', () => timeService.nowSyncedUTCString());

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  migrateColumnsIfNeeded(db);
  seedIfEmpty(db);

  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` não adiciona coluna nova numa tabela que
 * já existia num banco de uma instalação anterior — só cria do zero se
 * a tabela inteira ainda não existisse. Pra colunas adicionadas depois
 * (como `pessoas` em `restaurant_tables`), precisa desse passo extra.
 */
/** Adiciona uma coluna só se ela ainda não existir — protegido
 * individualmente: se UMA falhar (banco bloqueado, permissão, etc.),
 * loga e segue pras próximas, em vez de travar a inicialização inteira
 * do app por causa de uma migração menor. */
function adicionarColunaSeFaltando(database, tabela, coluna, definicaoSql) {
  try {
    const colunas = database.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
    if (!colunas.includes(coluna)) {
      database.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicaoSql};`);
    }
  } catch (err) {
    console.error(`[migração] falhou ao adicionar ${tabela}.${coluna}:`, err);
  }
}

function migrateColumnsIfNeeded(database) {
  adicionarColunaSeFaltando(database, 'restaurant_tables', 'pessoas', 'INTEGER');
  adicionarColunaSeFaltando(database, 'restaurant_tables', 'reservado_para', 'TEXT');
  adicionarColunaSeFaltando(database, 'sales', 'taxa_servico_percentual', 'REAL NOT NULL DEFAULT 0');
  adicionarColunaSeFaltando(database, 'sale_items', 'enviado_cozinha', 'INTEGER NOT NULL DEFAULT 0');
  adicionarColunaSeFaltando(database, 'sale_items', 'observacao', 'TEXT');
  adicionarColunaSeFaltando(database, 'sale_items', 'pessoa_numero', 'INTEGER');
  adicionarColunaSeFaltando(database, 'receipt_config', 'impressora_padrao', 'TEXT');
  adicionarColunaSeFaltando(database, 'products', 'codigo_balanca', 'TEXT');
  adicionarColunaSeFaltando(database, 'customers', 'cnpj', 'TEXT');
  adicionarColunaSeFaltando(database, 'license_state', 'bloqueio_imediato', 'INTEGER NOT NULL DEFAULT 0');
  adicionarColunaSeFaltando(database, 'sales', 'oculta_historico', 'INTEGER NOT NULL DEFAULT 0');
  adicionarColunaSeFaltando(database, 'sales', 'oculta_historico_por_id', 'TEXT');
  adicionarColunaSeFaltando(database, 'sales', 'oculta_historico_em', 'TEXT');
  adicionarColunaSeFaltando(database, 'sales', 'oculta_historico_motivo', 'TEXT');
  adicionarColunaSeFaltando(database, 'security_config', 'exigir_autorizacao_desconto', 'INTEGER NOT NULL DEFAULT 1');
  adicionarColunaSeFaltando(database, 'sync_state', 'servidor_do_grupo', 'INTEGER NOT NULL DEFAULT 0');
  adicionarColunaSeFaltando(database, 'sale_items', 'preco_original', 'REAL');
  adicionarColunaSeFaltando(database, 'sale_items', 'preco_alterado_por_id', 'TEXT');
  adicionarColunaSeFaltando(database, 'sale_items', 'preco_alterado_motivo', 'TEXT');
  // Produto personalizado (prato/produto montado na hora, ex: pizza
  // meio-a-meio) -- todo item personalizado compartilha o mesmo
  // product_id "âncora" (oculto do catálogo via ativo=0), então o nome
  // de verdade fica aqui em vez de vir de products.nome. Ver
  // customItemService.js e a tabela custom_item_lines.
  adicionarColunaSeFaltando(database, 'sale_items', 'nome_personalizado', 'TEXT');
  adicionarColunaSeFaltando(database, 'sale_items', 'eh_personalizado', 'INTEGER NOT NULL DEFAULT 0');
  adicionarColunaSeFaltando(database, 'products', 'conflito_codigo_barras_pendente', 'TEXT');
  adicionarColunaSeFaltando(database, 'products', 'preco_promocional', 'REAL');
  adicionarColunaSeFaltando(database, 'products', 'promocao_valida_ate', 'TEXT');
  adicionarColunaSeFaltando(database, 'fiscal_config', 'qr_code_url', 'TEXT');
  adicionarColunaSeFaltando(database, 'nfce_emitidas', 'qr_code_conteudo', 'TEXT');
  // Congela o preço mostrado ao cliente (WhatsApp ou digitado manualmente)
  // no momento em que o item entra no pedido -- sem isso, converter o
  // pedido em venda na conclusão usaria o preço ATUAL do produto, que
  // pode já ter mudado desde que o cliente viu o valor.
  adicionarColunaSeFaltando(database, 'bot_order_items', 'preco_unitario', 'REAL');
  adicionarColunaSeFaltando(database, 'backup_config', 'ultimo_upload_nuvem_em', 'TEXT');
  adicionarColunaSeFaltando(database, 'backup_config', 'ultimo_upload_nuvem_ok', 'INTEGER');
  adicionarColunaSeFaltando(database, 'backup_config', 'ultima_restauracao_processada', 'TEXT');
  // Evita rodar o MESMO pedido de "backup agora" (feito pela Central)
  // duas vezes, igual ultima_restauracao_processada acima.
  adicionarColunaSeFaltando(database, 'backup_config', 'ultimo_pedido_backup_processado', 'TEXT');
  // Coluna antiga, sem uso -- mantida só por não dar pra apagar coluna
  // com segurança em runtime. Ver comentário completo em schema.sql.
  adicionarColunaSeFaltando(database, 'backup_config', 'conta_nuvem_pessoal', 'TEXT');
  // E-mail (só o e-mail -- a senha nunca fica no banco local) da conta
  // Google criada pelo fluxo "Criar conta Google" -- ver schema.sql.
  adicionarColunaSeFaltando(database, 'backup_config', 'conta_google_email', 'TEXT');
  adicionarColunaSeFaltando(database, 'forced_update_state', 'versao_minima_override', 'TEXT');
  adicionarColunaSeFaltando(database, 'forced_update_state', 'override_ativo', 'INTEGER NOT NULL DEFAULT 0');
  // Guarda diária da reconquista automática (ver whatsappAutomationService.js)
  // -- antes disso, a lista de "clientes que sumiram" era recalculada do
  // zero a cada 10 minutos, o dia inteiro, mesmo sabendo que o cooldown por
  // cliente já impedia reenviar mensagem duplicada. Uma vez por dia é mais
  // que suficiente pra esse tipo de aviso (cliente sumido há semanas).
  adicionarColunaSeFaltando(database, 'whatsapp_automation_config', 'ultimo_envio_reconquista', 'TEXT');

  // Cupom automático de aniversário (ver customerService.js / loyalty_config).
  adicionarColunaSeFaltando(database, 'customers', 'data_nascimento', 'TEXT');
  adicionarColunaSeFaltando(database, 'customers', 'ano_ultimo_cupom_aniversario', 'INTEGER');
  adicionarColunaSeFaltando(database, 'customers', 'reconquista_automatica_enviada_em', 'TEXT');
  adicionarColunaSeFaltando(database, 'loyalty_config', 'ativar_cupom_aniversario', 'INTEGER NOT NULL DEFAULT 0');
  adicionarColunaSeFaltando(database, 'loyalty_config', 'pontos_bonus_aniversario', 'INTEGER NOT NULL DEFAULT 20');

  // Painel de cozinha / KDS (ver kitchenService.js).
  adicionarColunaSeFaltando(database, 'sale_items', 'status_preparo', "TEXT NOT NULL DEFAULT 'pendente' CHECK (status_preparo IN ('pendente','preparando','pronto'))");

  // Pedido de mesa pelo chatbot do WhatsApp (ver whatsappBotHandler.js / botOrderService.lancarPedidoNaMesa).
  adicionarColunaSeFaltando(database, 'bot_orders', 'mesa_numero', 'TEXT');

  // Nome/telefone do cliente "de instantâneo" em deliveries, copiado de
  // bot_orders (pedido do WhatsApp) ou digitado na hora -- antes disso o
  // nome só vinha do JOIN com customers, então uma entrega de cliente
  // ainda não cadastrado (o caso mais comum vindo do chatbot) aparecia
  // sem nome nenhum na tela de Delivery, só com o endereço. Ver
  // deliveryService.js.
  adicionarColunaSeFaltando(database, 'deliveries', 'cliente_nome', 'TEXT');
  adicionarColunaSeFaltando(database, 'deliveries', 'cliente_telefone', 'TEXT');

  // Cancelamento e contingência de NFC-e (ver nfceEventoService.js / fiscalService.js).
  adicionarColunaSeFaltando(database, 'nfce_emitidas', 'cancelamento_justificativa', 'TEXT');
  adicionarColunaSeFaltando(database, 'nfce_emitidas', 'cancelamento_protocolo', 'TEXT');
  adicionarColunaSeFaltando(database, 'nfce_emitidas', 'cancelada_em', 'TEXT');
  adicionarColunaSeFaltando(database, 'nfce_emitidas', 'transmitida_em_contingencia', 'INTEGER NOT NULL DEFAULT 0');

  // Correção pontual: produtos desativados de antes dessa correção
  // (excluir não liberava o código de barras/SKU) ficaram "segurando"
  // o código pra sempre, invisíveis na busca mas bloqueando qualquer
  // outro produto de usar o mesmo código. Libera de uma vez só.
  //
  // Marcado como já aplicada via PRAGMA user_version (bit 1) -- sem
  // isso, essa UPDATE varria a tabela products inteira TODA VEZ que o
  // app abria, pra sempre, mesmo já não tendo mais nenhum produto pra
  // corrigir há muito tempo (a causa raiz -- exclusão não liberava o
  // código -- já foi corrigida no fluxo normal). Nenhum outro lugar do
  // app usa user_version, então o bit 1 fica livre pra essa marcação.
  const CORRECAO_CODIGO_BARRAS_APLICADA = 1;
  const versaoAtual = database.pragma('user_version', { simple: true });
  if ((versaoAtual & CORRECAO_CODIGO_BARRAS_APLICADA) === 0) {
    database.prepare(
      `UPDATE products SET codigo_barras = NULL, sku = NULL WHERE ativo = 0 AND (codigo_barras IS NOT NULL OR sku IS NOT NULL)`
    ).run();
    database.pragma(`user_version = ${versaoAtual | CORRECAO_CODIGO_BARRAS_APLICADA}`);
  }
}

function seedIfEmpty(database) {
  const locationCount = database.prepare('SELECT COUNT(*) as c FROM locations').get().c;
  if (locationCount === 0) {
    database.prepare(
      `INSERT INTO locations (id, nome, tipo) VALUES (?, ?, ?)`
    ).run(randomUUID(), 'Loja Principal', 'loja');
  }

  const profileCount = database.prepare('SELECT COUNT(*) as c FROM business_profile').get().c;
  if (profileCount === 0) {
    database.prepare(
      `INSERT INTO business_profile (id, perfil_ativo, config_json) VALUES ('default', 'farmacia', '{}')`
    ).run();
  }

  function seedProfileIfMissing(id, nome, camposExtras, opcoes = {}) {
    const exists = database.prepare('SELECT id FROM custom_profiles WHERE id = ?').get(id);
    if (exists) return;
    database.prepare(
      `INSERT INTO custom_profiles (id, nome, campos_extras_json, alerta_validade_proxima, dias_alerta_validade, dias_alerta_validade_critico, estoque_critico_percentual)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, nome, JSON.stringify(camposExtras),
      opcoes.alertaValidadeProxima ? 1 : 0,
      opcoes.diasAlertaValidade ?? 60,
      opcoes.diasAlertaValidadeCritico ?? 7,
      opcoes.estoqueCriticoPercentual ?? 50
    );
  }

  seedProfileIfMissing('farmacia', 'Farmácia', [
    { campo: 'lote', label: 'Lote', tipo: 'texto', obrigatorio: true },
    { campo: 'validade', label: 'Validade', tipo: 'data', obrigatorio: true },
    { campo: 'principio_ativo', label: 'Princípio ativo', tipo: 'texto', obrigatorio: false },
    { campo: 'controlado', label: 'Medicamento controlado', tipo: 'boolean', obrigatorio: false },
    { campo: 'exige_receita', label: 'Exige receita médica', tipo: 'boolean', obrigatorio: false },
  ], { alertaValidadeProxima: true, diasAlertaValidade: 60, diasAlertaValidadeCritico: 7 });

  seedProfileIfMissing('generico', 'Genérico', [], { alertaValidadeProxima: false });

  seedProfileIfMissing('petshop', 'Petshop', [
    { campo: 'especie_animal', label: 'Espécie (cão, gato, ave...)', tipo: 'texto', obrigatorio: false },
    { campo: 'peso_volume', label: 'Peso/volume da embalagem', tipo: 'texto', obrigatorio: false },
    { campo: 'validade', label: 'Validade', tipo: 'data', obrigatorio: false },
    { campo: 'exige_receita_veterinaria', label: 'Exige receita veterinária', tipo: 'boolean', obrigatorio: false },
  ], { alertaValidadeProxima: true, diasAlertaValidade: 90, diasAlertaValidadeCritico: 15 });

  seedProfileIfMissing('armazem', 'Armazém / Mercearia', [
    { campo: 'validade', label: 'Validade', tipo: 'data', obrigatorio: true },
    { campo: 'peso_liquido', label: 'Peso/volume líquido', tipo: 'texto', obrigatorio: false },
    { campo: 'perecivel', label: 'Perecível / precisa refrigeração', tipo: 'boolean', obrigatorio: false },
  ], { alertaValidadeProxima: true, diasAlertaValidade: 15, diasAlertaValidadeCritico: 3 });

  seedProfileIfMissing('salao_beleza', 'Salão de Beleza / Cabelo', [
    { campo: 'validade', label: 'Validade', tipo: 'data', obrigatorio: false },
    { campo: 'uso_profissional', label: 'Uso profissional (não é pra revenda)', tipo: 'boolean', obrigatorio: false },
  ], { alertaValidadeProxima: true, diasAlertaValidade: 180, diasAlertaValidadeCritico: 30 });

  seedProfileIfMissing('padaria', 'Padaria / Confeitaria', [
    { campo: 'validade', label: 'Validade', tipo: 'data', obrigatorio: true },
    { campo: 'peso_gramas', label: 'Peso (gramas)', tipo: 'texto', obrigatorio: false },
  ], { alertaValidadeProxima: true, diasAlertaValidade: 2, diasAlertaValidadeCritico: 1 });

  seedProfileIfMissing('papelaria', 'Papelaria', [], { alertaValidadeProxima: false });

  seedProfileIfMissing('vestuario', 'Loja de Roupas', [
    { campo: 'tamanho', label: 'Tamanho (P, M, G...)', tipo: 'texto', obrigatorio: false },
    { campo: 'cor', label: 'Cor', tipo: 'texto', obrigatorio: false },
  ], { alertaValidadeProxima: false });

  seedProfileIfMissing('otica', 'Ótica', [
    { campo: 'grau', label: 'Grau da lente', tipo: 'texto', obrigatorio: false },
    { campo: 'tipo_lente', label: 'Tipo de lente', tipo: 'texto', obrigatorio: false },
  ], { alertaValidadeProxima: false });

  seedProfileIfMissing('material_construcao', 'Material de Construção', [
    { campo: 'garantia_meses', label: 'Garantia (meses)', tipo: 'numero', obrigatorio: false },
  ], { alertaValidadeProxima: false });

  seedProfileIfMissing('restaurante', 'Restaurante', [
    { campo: 'tipo_prato', label: 'Tipo (entrada, prato principal, sobremesa, bebida...)', tipo: 'texto', obrigatorio: false },
    { campo: 'tempo_preparo', label: 'Tempo de preparo (minutos)', tipo: 'numero', obrigatorio: false },
    { campo: 'disponivel_hoje', label: 'Disponível hoje (prato do dia)', tipo: 'boolean', obrigatorio: false },
  ], { alertaValidadeProxima: false });

  const aiSettingsCount = database.prepare('SELECT COUNT(*) as c FROM ai_settings').get().c;
  if (aiSettingsCount === 0) {
    database.prepare(`INSERT INTO ai_settings (id) VALUES ('default')`).run();
  }

  const fiscalConfigCount = database.prepare('SELECT COUNT(*) as c FROM fiscal_config').get().c;
  if (fiscalConfigCount === 0) {
    database.prepare(`INSERT INTO fiscal_config (id, ambiente) VALUES ('default', 'homologacao')`).run();
  }

  const paymentConfigCount = database.prepare('SELECT COUNT(*) as c FROM payment_config').get().c;
  if (paymentConfigCount === 0) {
    database.prepare(`INSERT INTO payment_config (id) VALUES ('default')`).run();
  }

  const firebaseConfigCount = database.prepare('SELECT COUNT(*) as c FROM firebase_config').get().c;
  if (firebaseConfigCount === 0) {
    database.prepare(`INSERT INTO firebase_config (id) VALUES ('default')`).run();
  }

  const backupConfigCount = database.prepare('SELECT COUNT(*) as c FROM backup_config').get().c;
  if (backupConfigCount === 0) {
    database.prepare(`INSERT INTO backup_config (id) VALUES ('default')`).run();
  }

  const receiptConfigCount = database.prepare('SELECT COUNT(*) as c FROM receipt_config').get().c;
  if (receiptConfigCount === 0) {
    database.prepare(`INSERT INTO receipt_config (id) VALUES ('default')`).run();
  }

  const digitalMenuConfigCount = database.prepare('SELECT COUNT(*) as c FROM digital_menu_config').get().c;
  if (digitalMenuConfigCount === 0) {
    database.prepare(`INSERT INTO digital_menu_config (id) VALUES ('default')`).run();
  }

  const scaleBarcodeConfigCount = database.prepare('SELECT COUNT(*) as c FROM scale_barcode_config').get().c;
  if (scaleBarcodeConfigCount === 0) {
    database.prepare(`INSERT INTO scale_barcode_config (id) VALUES ('default')`).run();
  }

  const scaleHardwareConfigCount = database.prepare('SELECT COUNT(*) as c FROM scale_hardware_config').get().c;
  if (scaleHardwareConfigCount === 0) {
    database.prepare(`INSERT INTO scale_hardware_config (id) VALUES ('default')`).run();
  }

  const securityConfigCount = database.prepare('SELECT COUNT(*) as c FROM security_config').get().c;
  if (securityConfigCount === 0) {
    database.prepare(`INSERT INTO security_config (id) VALUES ('default')`).run();
  }

  const forcedUpdateStateCount = database.prepare('SELECT COUNT(*) as c FROM forced_update_state').get().c;
  if (forcedUpdateStateCount === 0) {
    database.prepare(`INSERT INTO forced_update_state (id) VALUES ('default')`).run();
  }

  const homeMessageStateCount = database.prepare('SELECT COUNT(*) as c FROM home_message_state').get().c;
  if (homeMessageStateCount === 0) {
    database.prepare(`INSERT INTO home_message_state (id) VALUES ('default')`).run();
  }

  const syncStateCount = database.prepare('SELECT COUNT(*) as c FROM sync_state').get().c;
  if (syncStateCount === 0) {
    database.prepare(`INSERT INTO sync_state (id) VALUES ('default')`).run();
  }

  const posDisplayCount = database.prepare('SELECT COUNT(*) as c FROM pos_display_config').get().c;
  if (posDisplayCount === 0) {
    database.prepare(`INSERT INTO pos_display_config (id) VALUES ('default')`).run();
  }

  const loyaltyConfigCount = database.prepare('SELECT COUNT(*) as c FROM loyalty_config').get().c;
  if (loyaltyConfigCount === 0) {
    database.prepare(`INSERT INTO loyalty_config (id) VALUES ('default')`).run();
  }

  const whatsappAutomationConfigCount = database.prepare('SELECT COUNT(*) as c FROM whatsapp_automation_config').get().c;
  if (whatsappAutomationConfigCount === 0) {
    database.prepare(`INSERT INTO whatsapp_automation_config (id) VALUES ('default')`).run();
  }

  const userCount = database.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount === 0) {
    // Usuário admin inicial — PIN padrão "0000", com pin_temporario = 1
    // para FORÇAR a troca no primeiro login (ver authService.login).
    const pinHash = bcrypt.hashSync('0000', 10);
    database.prepare(
      `INSERT INTO users (id, nome, role, pin_hash, pin_temporario) VALUES (?, ?, 'admin', ?, 1)`
    ).run(randomUUID(), 'Administrador', pinHash);
    console.warn('[seed] Usuário admin criado com PIN padrão "0000" — troca será exigida no primeiro acesso.');
  }
}

module.exports = { getDb, setDbForTesting, getDbPath, closeConnection };

function getDbPath() {
  const userDataPath = getUserDataPath();
  return path.join(userDataPath, 'gerenciaai.sqlite3');
}

/**
 * Uso exclusivo da restauração de backup: fecha a conexão atual e limpa
 * a referência, pra podermos sobrescrever o arquivo .sqlite3 com
 * segurança. O app é reiniciado logo em seguida — nunca reabrimos a
 * conexão no mesmo processo depois disso.
 */
function closeConnection() {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Uso exclusivo dos testes automatizados (ver /tests): injeta um banco
 * em memória já com o schema aplicado, sem precisar do módulo `electron`
 * nem de um userData real. Nunca é chamado em produção.
 */
function setDbForTesting(databaseInstance) {
  db = databaseInstance;
  db.pragma('foreign_keys = ON');
  db.function('NOW_SYNCED', () => timeService.nowSyncedUTCString());
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
  seedIfEmpty(db);
  return db;
}
