const fs = require('fs');
const path = require('path');
const { getDb, getDbPath } = require('../db/database');

const RETENCAO_DIAS = 30; // backups mais velhos que isso são apagados na rotação

function backupsDir() {
  // Carregado sob demanda -- ver comentário equivalente em attachmentService.js.
  const { app } = require('electron');
  const base = app ? app.getPath('userData') : path.join(__dirname, '../../.data');
  const dir = path.join(base, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getBackupConfig() {
  const db = getDb();
  return db.prepare('SELECT * FROM backup_config WHERE id = ?').get('default');
}

function getStatus() {
  const config = getBackupConfig();
  return {
    ultimoBackupEm: config.ultimo_backup_em,
    ultimoBackupOk: !!config.ultimo_backup_ok,
    pastaSecundaria: config.pasta_secundaria || '',
  };
}

function updateConfig({ pastaSecundaria }) {
  const db = getDb();
  db.prepare('UPDATE backup_config SET pasta_secundaria = ? WHERE id = ?').run(pastaSecundaria || null, 'default');
  return { ok: true };
}

function nomeArquivoBackup() {
  const agora = new Date();
  const carimbo = agora.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `gerenciaai-${carimbo}.sqlite3`;
}

/** Apaga backups locais além da retenção — nunca mexe na pasta secundária
 * (fora do nosso controle, o usuário decide a política de lá). */
function rotacionarBackupsAntigos() {
  const dir = backupsDir();
  const limite = Date.now() - RETENCAO_DIAS * 24 * 60 * 60 * 1000;
  for (const arquivo of fs.readdirSync(dir)) {
    const caminho = path.join(dir, arquivo);
    const stat = fs.statSync(caminho);
    if (stat.mtimeMs < limite) fs.unlinkSync(caminho);
  }
}

/**
 * Faz uma cópia consistente do banco usando a API de backup nativa do
 * SQLite — funciona corretamente mesmo com o banco em modo WAL e em uso
 * (uma cópia de arquivo comum poderia perder dados recentes ainda não
 * gravados no arquivo principal). Nunca trava a operação normal do app:
 * se o backup falhar, só registra e segue.
 */
async function runBackup() {
  const db = getDb();
  const nomeArquivo = nomeArquivoBackup();
  const destinoPrincipal = path.join(backupsDir(), nomeArquivo);

  try {
    await db.backup(destinoPrincipal);
  } catch (err) {
    marcarResultado(false);
    return { ok: false, error: `Falha ao fazer backup: ${err.message}` };
  }

  rotacionarBackupsAntigos();

  // Pasta secundária (opcional) — melhor esforço só. Se não existir, se
  // for um pendrive desconectado, etc., não trava nem marca falha geral.
  const config = getBackupConfig();
  let avisoSecundaria = null;
  if (config.pasta_secundaria) {
    try {
      fs.mkdirSync(config.pasta_secundaria, { recursive: true });
      fs.copyFileSync(destinoPrincipal, path.join(config.pasta_secundaria, nomeArquivo));
    } catch (err) {
      avisoSecundaria = `Backup local OK, mas falhou copiar para a pasta secundária: ${err.message}`;
    }
  }

  marcarResultado(true);
  return { ok: true, arquivo: destinoPrincipal, avisoSecundaria };
}

function marcarResultado(sucesso) {
  const db = getDb();
  db.prepare('UPDATE backup_config SET ultimo_backup_em = NOW_SYNCED(), ultimo_backup_ok = ? WHERE id = ?')
    .run(sucesso ? 1 : 0, 'default');
}

/** Roda no início do app — só faz backup novo se ainda não fez um hoje,
 * pra não gerar backup toda vez que o app abre no meio do expediente. */
async function runBackupIfNeeded() {
  const config = getBackupConfig();
  const hoje = require('./timeService').hojeLocalISO();
  const ultimoDia = config.ultimo_backup_em ? config.ultimo_backup_em.slice(0, 10) : null;
  if (ultimoDia === hoje) return { ok: true, skipped: true };
  return runBackup();
}

function listBackups() {
  const dir = backupsDir();
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite3'))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { nome: f, tamanhoBytes: stat.size, criadoEm: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}

/**
 * Restaura um backup — **substitui os dados atuais**, operação
 * irreversível (a não ser que se restaure outro backup depois). Fecha a
 * conexão do banco antes de sobrescrever o arquivo (não dá pra
 * substituir um arquivo com o SQLite ainda usando ele), e limpa os
 * arquivos -wal/-shm residuais pra não misturar com o backup restaurado.
 * O app precisa reiniciar depois — quem chama isso é responsável por
 * disparar o reinício (ver handlers.js).
 */
function restoreBackup(requestingUserId, nomeArquivo) {
  // Restaurar apaga os dados atuais sem volta — mesmo nível de acesso da
  // tela de Configurações que expõe este botão (só admin). Ver
  // authService.requireRole.
  const guard = require('./authService').requireRole(requestingUserId, ['admin']);
  if (!guard.ok) return guard;

  const backupPath = path.join(backupsDir(), nomeArquivo);
  if (!fs.existsSync(backupPath)) return { ok: false, error: 'Arquivo de backup não encontrado.' };

  const { closeConnection } = require('../db/database');
  closeConnection();

  const dbPath = getDbPath();
  for (const sufixo of ['-wal', '-shm']) {
    const residual = dbPath + sufixo;
    if (fs.existsSync(residual)) fs.unlinkSync(residual);
  }

  fs.copyFileSync(backupPath, dbPath);
  return { ok: true };
}

module.exports = { getStatus, updateConfig, runBackup, runBackupIfNeeded, listBackups, restoreBackup, backupsDir, getDbPath };
