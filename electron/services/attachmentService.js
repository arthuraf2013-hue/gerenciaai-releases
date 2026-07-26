const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { app } = require('electron');
const { getDb } = require('../db/database');

function attachmentsDir() {
  const dir = path.join(app.getPath('userData'), 'anexos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function inferTipo(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.webp', '.heic'].includes(ext)) return 'imagem';
  return null;
}

/**
 * Copia o arquivo escolhido pelo usuário para a pasta de dados do app
 * (nunca lê/escreve fora dela) e registra o vínculo com a venda.
 * Puramente opcional — nenhuma venda depende disso para ser concluída.
 */
function addAttachment({ saleId, sourceFilePath, operadorId }) {
  const tipo = inferTipo(sourceFilePath);
  if (!tipo) return { ok: false, error: 'Formato não suportado. Envie uma imagem (png/jpg) ou um PDF.' };

  const db = getDb();
  const destDir = path.join(attachmentsDir(), saleId);
  fs.mkdirSync(destDir, { recursive: true });

  const nomeOriginal = path.basename(sourceFilePath);
  const destPath = path.join(destDir, `${randomUUID()}${path.extname(sourceFilePath)}`);
  fs.copyFileSync(sourceFilePath, destPath);

  const id = randomUUID();
  db.prepare(
    `INSERT INTO sale_attachments (id, sale_id, nome_arquivo, caminho, tipo, operador_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, saleId, nomeOriginal, destPath, tipo, operadorId);

  return { ok: true, id, nomeArquivo: nomeOriginal, tipo };
}

function listAttachments(saleId) {
  const db = getDb();
  return db.prepare('SELECT * FROM sale_attachments WHERE sale_id = ? ORDER BY criado_em').all(saleId);
}

function removeAttachment(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sale_attachments WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Anexo não encontrado.' };

  db.prepare('DELETE FROM sale_attachments WHERE id = ?').run(id);
  fs.unlink(row.caminho, () => {}); // best-effort — não falha a operação se o arquivo já sumiu
  return { ok: true };
}

module.exports = { addAttachment, listAttachments, removeAttachment };
