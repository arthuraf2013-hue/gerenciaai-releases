const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshTestDb } = require('./helpers/testDb');
const backupService = require('../electron/services/backupService');

// Fora do Electron de verdade (como aqui, rodando com node --test),
// backupService cai pro mesmo diretório ".data" (ver comentário em
// backupsDir()) tanto pros backups quanto pras pastas "ao vivo" de
// anexos/fotos-produtos/nfce -- é o que permite testar o espelhamento
// sem precisar simular app.getPath('userData').
const DATA_DIR = path.join(__dirname, '../.data');

// Restaurar backup substitui TODOS os dados atuais sem volta — a tela que
// expõe esse botão só aparece pra admin (aba Configurações), então o
// backend precisa recusar qualquer outro papel, mesmo se alguém chamar o
// canal IPC diretamente sem passar pela tela.

test('restoreBackup recusa quem não é admin, antes mesmo de checar se o arquivo existe', () => {
  const { gerenteId } = freshTestDb();
  const result = backupService.restoreBackup(gerenteId, 'nao-importa.sqlite3');
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('restoreBackup recusa operador', () => {
  const { operadorId } = freshTestDb();
  const result = backupService.restoreBackup(operadorId, 'nao-importa.sqlite3');
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('restoreBackup passa da checagem de permissão pra admin (e só falha depois por arquivo inexistente, não por permissão)', () => {
  const { adminId } = freshTestDb();
  const result = backupService.restoreBackup(adminId, 'arquivo-que-nao-existe-de-verdade.sqlite3');
  assert.equal(result.ok, false);
  assert.match(result.error, /não encontrado/i);
});

// Pedido de "backup agora" feito remotamente pela Central (campo
// backupSolicitadoEm no documento da instalação) — só a parte local é
// testável aqui (sem projeto Firebase de verdade nesse ambiente); o
// upload pra nuvem em si é melhor-esforço e não deveria travar o backup
// local mesmo se falhar (ver uploadBackupParaNuvem em backupService.js).

test('executarBackupRemotoSeSolicitado não faz nada sem backupSolicitadoEm', async () => {
  freshTestDb();
  const antes = backupService.getStatus();
  await backupService.executarBackupRemotoSeSolicitado({});
  const depois = backupService.getStatus();
  assert.equal(depois.ultimoBackupEm, antes.ultimoBackupEm); // nenhum backup novo rodou
});

test('executarBackupRemotoSeSolicitado roda um backup local de verdade quando pedido, e marca como processado', async () => {
  freshTestDb();
  const antes = backupService.listBackups().length;
  await backupService.executarBackupRemotoSeSolicitado({ backupSolicitadoEm: 123456789 });
  const status = backupService.getStatus();
  assert.equal(status.ultimoBackupOk, true);

  const depois = backupService.listBackups().length;
  assert.equal(depois, antes + 1); // gerou exatamente um backup novo
});

test('executarBackupRemotoSeSolicitado não roda de novo pro MESMO pedido (idempotente)', async () => {
  freshTestDb();
  await backupService.executarBackupRemotoSeSolicitado({ backupSolicitadoEm: 222 });
  const arquivosDepoisDoPrimeiro = backupService.listBackups().length;

  await backupService.executarBackupRemotoSeSolicitado({ backupSolicitadoEm: 222 }); // mesmo pedido de novo
  const arquivosDepoisDoSegundo = backupService.listBackups().length;

  assert.equal(arquivosDepoisDoSegundo, arquivosDepoisDoPrimeiro); // não gerou um segundo backup
});

// Fotos de produto, anexos de venda e XMLs de NFC-e ficam fora do banco
// (só o CAMINHO é gravado lá) — sem espelhar essas pastas também, um
// backup "restaurado" numa máquina nova teria registros apontando pra
// arquivos que não existem. runBackup() e restoreBackup() agora cuidam
// disso também, à parte do .sqlite3 em si.

test('runBackup espelha anexos/fotos-produtos/nfce junto com o banco', async () => {
  freshTestDb();
  const anexosAoVivo = path.join(DATA_DIR, 'anexos', 'venda-123');
  fs.mkdirSync(anexosAoVivo, { recursive: true });
  fs.writeFileSync(path.join(anexosAoVivo, 'comprovante.pdf'), 'conteudo-de-teste');

  const resultado = await backupService.runBackup();
  assert.equal(resultado.ok, true);

  const espelho = path.join(DATA_DIR, 'backups', 'arquivos', 'anexos', 'venda-123', 'comprovante.pdf');
  assert.equal(fs.existsSync(espelho), true);
  assert.equal(fs.readFileSync(espelho, 'utf-8'), 'conteudo-de-teste');
});

test('rotacionarBackupsAntigos não trava com a pasta "arquivos" presente (só mexe em .sqlite3)', async () => {
  freshTestDb();
  fs.mkdirSync(path.join(DATA_DIR, 'anexos'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'anexos', 'x.txt'), 'x');
  await backupService.runBackup(); // cria backups/arquivos/... -- não deve lançar erro nenhum
  await backupService.runBackup(); // roda de novo, agora com backups/arquivos/ já existindo
  assert.equal(backupService.getStatus().ultimoBackupOk, true);
});

test('restoreBackup devolve fotos/anexos/NFC-e do espelho pras pastas ao vivo', async () => {
  freshTestDb();
  const fotosAoVivo = path.join(DATA_DIR, 'fotos-produtos');
  fs.mkdirSync(fotosAoVivo, { recursive: true });
  fs.writeFileSync(path.join(fotosAoVivo, 'produto-1.jpg'), 'foto-original');

  const backupResult = await backupService.runBackup(); // espelha "foto-original"
  const nomeArquivo = path.basename(backupResult.arquivo);

  // Simula perda do arquivo ao vivo (ex: apagado sem querer) --
  // restaurar deveria trazer de volta a partir do espelho do backup.
  fs.rmSync(fotosAoVivo, { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(fotosAoVivo, 'produto-1.jpg')), false);

  const { adminId } = freshTestDb(); // freshTestDb troca o banco -- pega um admin novo pro restore
  const resultado = backupService.restoreBackup(adminId, nomeArquivo);
  assert.equal(resultado.ok, true);
  assert.equal(fs.readFileSync(path.join(fotosAoVivo, 'produto-1.jpg'), 'utf-8'), 'foto-original');
});

// Campo de texto livre na tela de Configurações pra registrar qual conta
// de nuvem pessoal (Google Drive etc.) o backup usa — só um
// registro/lembrete (não é integração de verdade com a API do Drive, ver
// Passo 7 do LICENCIAMENTO.md). updateConfig também dispara (melhor
// esforço) um report imediato pra Central, sem esperar o próximo ciclo de
// sincronização de 6h.

test('updateConfig salva a conta de nuvem pessoal e getStatus devolve ela', () => {
  freshTestDb();
  const resultado = backupService.updateConfig({ contaNuvemPessoal: 'cliente-x@gmail.com' });
  assert.equal(resultado.ok, true);
  assert.equal(backupService.getStatus().contaNuvemPessoal, 'cliente-x@gmail.com');
});

test('updateConfig chamado só com pastaSecundaria não apaga a conta de nuvem pessoal já salva (e vice-versa)', () => {
  freshTestDb();
  backupService.updateConfig({ contaNuvemPessoal: 'cliente-x@gmail.com' });
  backupService.updateConfig({ pastaSecundaria: '/algum/caminho' }); // não menciona contaNuvemPessoal

  const status = backupService.getStatus();
  assert.equal(status.pastaSecundaria, '/algum/caminho');
  assert.equal(status.contaNuvemPessoal, 'cliente-x@gmail.com'); // preservada

  backupService.updateConfig({ contaNuvemPessoal: '' }); // limpeza intencional, string vazia
  assert.equal(backupService.getStatus().contaNuvemPessoal, '');
  assert.equal(backupService.getStatus().pastaSecundaria, '/algum/caminho'); // continua intacta
});
