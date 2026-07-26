const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { app } = require('electron');
const { randomUUID } = require('crypto');
const timeService = require('../services/timeService');

let db;

function getDb() {
  if (db) return db;

  const userDataPath = app ? app.getPath('userData') : path.join(__dirname, '../../.data');
  fs.mkdirSync(userDataPath, { recursive: true });
  const dbPath = path.join(userDataPath, 'gerenciaai.sqlite3');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // melhor para escrita concorrente PDV + sync em background
  db.pragma('foreign_keys = ON');

  // Toda vez que o schema usa NOW_SYNCED() (no lugar de datetime('now')),
  // isso chama o relógio sincronizado com a internet — não o relógio cru
  // do sistema operacional, que pode estar desconfigurado.
  db.function('NOW_SYNCED', () => timeService.nowSyncedUTCString());

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  seedIfEmpty(db);

  return db;
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

  const loyaltyConfigCount = database.prepare('SELECT COUNT(*) as c FROM loyalty_config').get().c;
  if (loyaltyConfigCount === 0) {
    database.prepare(`INSERT INTO loyalty_config (id) VALUES ('default')`).run();
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
  const userDataPath = app ? app.getPath('userData') : path.join(__dirname, '../../.data');
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
