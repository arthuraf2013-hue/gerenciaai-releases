const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('node:crypto');
const { freshTestDb, createSuporteUser } = require('./helpers/testDb');
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

test('restoreBackup recusa quem não é admin, antes mesmo de checar se o arquivo existe', async () => {
  const { gerenteId } = freshTestDb();
  const result = await backupService.restoreBackup(gerenteId, 'nao-importa.sqlite3');
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('restoreBackup recusa operador', async () => {
  const { operadorId } = freshTestDb();
  const result = await backupService.restoreBackup(operadorId, 'nao-importa.sqlite3');
  assert.equal(result.ok, false);
  assert.match(result.error, /permissão/i);
});

test('restoreBackup passa da checagem de permissão pra admin (e só falha depois por arquivo inexistente, não por permissão)', async () => {
  const { adminId } = freshTestDb();
  const result = await backupService.restoreBackup(adminId, 'arquivo-que-nao-existe-de-verdade.sqlite3');
  assert.equal(result.ok, false);
  assert.match(result.error, /não encontrado/i);
});

test('restoreBackup passa da checagem de permissão pra suporte, igual admin', async () => {
  const { db } = freshTestDb();
  const suporteId = createSuporteUser(db);
  const result = await backupService.restoreBackup(suporteId, 'arquivo-que-nao-existe-de-verdade.sqlite3');
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
  const resultado = await backupService.restoreBackup(adminId, nomeArquivo);
  assert.equal(resultado.ok, true);
  assert.equal(fs.readFileSync(path.join(fotosAoVivo, 'produto-1.jpg'), 'utf-8'), 'foto-original');
});

// Restaurar é a ação mais destrutiva do sistema (substitui TODOS os
// dados atuais) -- precisa ficar rastreável mesmo depois da troca de
// banco. O rastro só pode ser gravado DENTRO do banco recém-restaurado
// (gravar no banco antigo antes de sobrescrever o arquivo seria inútil).
test('restoreBackup grava um evento de auditoria dentro do próprio banco restaurado', async () => {
  const primeiraInstancia = freshTestDb();
  const backupResult = await backupService.runBackup();
  const nomeArquivo = path.basename(backupResult.arquivo);

  const { adminId } = freshTestDb(); // troca de banco de novo, como o teste acima já faz
  const resultado = await backupService.restoreBackup(adminId, nomeArquivo);
  assert.equal(resultado.ok, true);

  const Database = require('better-sqlite3');
  const dbRestaurado = new Database(require('../electron/db/database').getDbPath(), { readonly: true });
  try {
    const evento = dbRestaurado.prepare(`SELECT * FROM audit_log WHERE tipo_evento = 'backup_restaurado'`).get();
    assert.ok(evento, 'deveria ter gravado um evento de auditoria no banco restaurado');
    assert.match(evento.motivo, new RegExp(nomeArquivo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    dbRestaurado.close();
  }
});

// updateConfig (pasta secundária) também dispara (melhor esforço) um
// report imediato pra Central, sem esperar o próximo ciclo de
// sincronização de 6h. O campo de texto livre "conta de nuvem pessoal"
// que existia aqui foi removido -- virou redundante depois do fluxo
// "Criar conta Google" (ver testes de salvarContaGoogle mais abaixo).

test('updateConfig salva a pasta secundária e getStatus devolve ela', () => {
  freshTestDb();
  const resultado = backupService.updateConfig({ pastaSecundaria: '/algum/caminho' });
  assert.equal(resultado.ok, true);
  assert.equal(backupService.getStatus().pastaSecundaria, '/algum/caminho');
});

// Conta Google criada pelo fluxo "Criar conta Google" (Configurações ->
// Backup) -- o app não tem a master key do Cofre, então protege a senha
// cifrando com uma chave PÚBLICA (RSA-OAEP) que a Central publicou; só
// quem destrava o Cofre com a master key consegue decifrar de volta (a
// chave privada correspondente fica cifrada lá, não aqui). Os testes
// abaixo validam o round-trip de criptografia de verdade (gerando um
// par de chaves aqui mesmo, sem precisar de um projeto Firebase) e o
// comportamento de erro quando a chave pública ainda não existe --
// exatamente o estado real do projeto Firebase do Arthur enquanto ele
// não gerar a chave pela Central (ver LICENCIAMENTO.md).

test('cifrarComChavePublica cifra e a chave privada correspondente decifra de volta pro texto original', async () => {
  const par = await webcrypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt']
  );
  const publicaSpkiBase64 = Buffer.from(await webcrypto.subtle.exportKey('spki', par.publicKey)).toString('base64');

  const cifradoBase64 = await backupService.cifrarComChavePublica(publicaSpkiBase64, 'S3nh@DoCliente!2026');

  const buffer = await webcrypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    par.privateKey,
    Buffer.from(cifradoBase64, 'base64')
  );
  assert.equal(new TextDecoder().decode(buffer), 'S3nh@DoCliente!2026');
});

test('cifrarComChavePublica produz cifrados diferentes pra mesma senha (RSA-OAEP não é determinístico)', async () => {
  const par = await webcrypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt']
  );
  const publicaSpkiBase64 = Buffer.from(await webcrypto.subtle.exportKey('spki', par.publicKey)).toString('base64');

  const primeiro = await backupService.cifrarComChavePublica(publicaSpkiBase64, 'mesma-senha');
  const segundo = await backupService.cifrarComChavePublica(publicaSpkiBase64, 'mesma-senha');
  assert.notEqual(primeiro, segundo);
});

test('salvarContaGoogle recusa e-mail ou senha vazios sem tentar rede', async () => {
  freshTestDb();
  assert.equal((await backupService.salvarContaGoogle({ email: '', senha: 'x' })).ok, false);
  assert.equal((await backupService.salvarContaGoogle({ email: 'a@b.com', senha: '' })).ok, false);
});

test('salvarContaGoogle falha com erro claro quando a chave pública ainda não existe, e não deixa e-mail salvo localmente', async () => {
  freshTestDb();
  // Neste ambiente de teste não existe (e não deveria existir) uma
  // chave pública publicada de verdade no Firestore -- é exatamente o
  // estado real de um projeto onde a Central ainda não gerou a chave.
  const resultado = await backupService.salvarContaGoogle({ email: 'cliente@gmail.com', senha: 'abc123' });
  assert.equal(resultado.ok, false);
  assert.ok(resultado.error);
  // Falhou ANTES de conseguir proteger a senha -- não deve deixar um
  // e-mail "órfão" salvo localmente sem a senha correspondente em
  // lugar nenhum seguro.
  assert.equal(backupService.getStatus().contaGoogleEmail, '');
});
