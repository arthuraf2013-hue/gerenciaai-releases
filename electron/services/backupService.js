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
    contaGoogleEmail: config.conta_google_email || '',
  };
}

function updateConfig({ pastaSecundaria } = {}) {
  const db = getDb();
  db.prepare('UPDATE backup_config SET pasta_secundaria = ? WHERE id = ?').run(pastaSecundaria || null, 'default');

  // Pedido explícito: essa configuração precisa "disparar e se apresentar
  // na Central para análise visual" assim que salva, não só na próxima
  // sincronização periódica de 6h. Melhor esforço -- se não tiver
  // internet agora, a config local já foi salva normalmente e o próximo
  // ciclo de sincronização reporta pra Central mais tarde.
  reportarConfigBackupParaCentral({ pastaSecundaria }).catch((err) => {
    console.error('[backupService] falha ao reportar config de backup pra Central (melhor esforço)', err);
  });

  return { ok: true };
}

async function reportarConfigBackupParaCentral({ pastaSecundaria }) {
  const licenseService = require('./licenseService');
  const pdvRegistryService = require('./pdvRegistryService');
  const { getFirestore, doc, setDoc } = require('firebase/firestore');

  const installId = pdvRegistryService.getOrCreateDeviceUid();
  const firestore = getFirestore(licenseService.getLicenseApp());

  await setDoc(
    doc(firestore, 'installations', installId),
    { backupPastaSecundariaConfigurada: !!(pastaSecundaria || '') },
    { merge: true }
  );
}

/**
 * Conta Google criada pelo técnico direto da tela de Configurações
 * ("Criar conta Google" abre o cadastro do Google no navegador; depois
 * de criada, o e-mail e a senha são salvos aqui). Pedido explícito:
 * o e-mail deve aparecer na Central sem senha nenhuma, e a senha só deve
 * aparecer lá pra quem destrava o Cofre com a master key.
 *
 * O app aqui NÃO tem (e não deveria ter) a master key -- ela só existe
 * no navegador de quem usa a Central, de propósito (ver Cofre de senhas
 * no admin-panel). Pra mesmo assim proteger a senha sem o app conhecer
 * a master key, usa criptografia de chave pública (RSA-OAEP):
 *   1. A Central, quando o Cofre é destravado, gera (uma única vez) um
 *      par de chaves. A pública vai pra 'config_publica/chave_contas_google'
 *      (documento de leitura aberta -- não é segredo). A privada é
 *      cifrada com a MESMA chave do Cofre (derivada da master key) e
 *      fica em 'cofre_config/chave_contas_google' (leitura só admin).
 *   2. O app aqui busca só a chave PÚBLICA (não precisa de login pra
 *      isso) e cifra a senha com ela antes de mandar pro Firestore.
 *   3. Só quem destrava o Cofre com a master key consegue decifrar a
 *      chave privada e, com ela, ler a senha de volta.
 * Ou seja: o app consegue PROTEGER a senha sem nunca conseguir LER
 * nenhuma senha já protegida (nem a própria que acabou de mandar).
 */
async function buscarChavePublicaContasGoogle() {
  const licenseService = require('./licenseService');
  const { getFirestore, doc, getDoc } = require('firebase/firestore');
  const firestore = getFirestore(licenseService.getLicenseApp());
  const snap = await getDoc(doc(firestore, 'config_publica', 'chave_contas_google'));
  if (!snap.exists() || !snap.data()?.chavePublicaSpki) {
    throw new Error('A Central ainda não gerou a chave de proteção de contas Google (isso é feito uma vez só, na aba Cofre de senhas).');
  }
  return snap.data().chavePublicaSpki;
}

async function cifrarComChavePublica(chavePublicaSpkiBase64, textoPlano) {
  const { webcrypto } = require('node:crypto');
  const spkiBytes = Buffer.from(chavePublicaSpkiBase64, 'base64');
  const chavePublica = await webcrypto.subtle.importKey(
    'spki',
    spkiBytes,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const cifrado = await webcrypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    chavePublica,
    new TextEncoder().encode(textoPlano)
  );
  return Buffer.from(cifrado).toString('base64');
}

/**
 * Salva (ou atualiza) a conta Google vinculada a esta instalação. É uma
 * ação direta do usuário (botão "Salvar conta"), não melhor-esforço em
 * segundo plano como o resto do arquivo -- se falhar (sem internet, ou
 * a Central ainda não gerou a chave de proteção), quem chamou precisa
 * saber pra avisar o usuário e ele tentar de novo, já que a senha
 * NUNCA é salva localmente (só em memória até ser cifrada e enviada).
 */
async function salvarContaGoogle({ email, senha }) {
  const emailLimpo = String(email || '').trim();
  const senhaLimpa = String(senha || '');
  if (!emailLimpo || !senhaLimpa) {
    return { ok: false, error: 'Preencha e-mail e senha.' };
  }

  const licenseService = require('./licenseService');
  const pdvRegistryService = require('./pdvRegistryService');
  const { getFirestore, doc, setDoc, serverTimestamp } = require('firebase/firestore');

  try {
    const chavePublica = await buscarChavePublicaContasGoogle();
    const senhaCifradaRsa = await cifrarComChavePublica(chavePublica, senhaLimpa);

    const installId = pdvRegistryService.getOrCreateDeviceUid();
    const firestore = getFirestore(licenseService.getLicenseApp());
    await setDoc(
      doc(firestore, 'contas_google', installId),
      { email: emailLimpo, senhaCifradaRsa, atualizadoEm: serverTimestamp() }
    );

    // Só grava o e-mail localmente DEPOIS de confirmar que a senha foi
    // protegida e enviada -- evita ficar com um e-mail salvo aqui sem a
    // senha correspondente ter chegado em algum lugar seguro.
    const db = getDb();
    db.prepare('UPDATE backup_config SET conta_google_email = ? WHERE id = ?').run(emailLimpo, 'default');

    return { ok: true };
  } catch (err) {
    console.error('[backupService] falha ao salvar conta Google', err);
    return { ok: false, error: `Não deu pra salvar (precisa de internet): ${err.message}` };
  }
}

function nomeArquivoBackup() {
  const agora = new Date();
  const carimbo = agora.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `gerenciaai-${carimbo}.sqlite3`;
}

/** Apaga backups locais além da retenção — nunca mexe na pasta secundária
 * (fora do nosso controle, o usuário decide a política de lá). Só mexe
 * em arquivos ".sqlite3" -- ignora a pasta "arquivos" (espelho de
 * fotos/anexos/NFC-e, ver espelharArquivosAdicionais), que não é
 * versionada por backup e não deveria ser apagada por idade. */
function rotacionarBackupsAntigos() {
  const dir = backupsDir();
  const limite = Date.now() - RETENCAO_DIAS * 24 * 60 * 60 * 1000;
  for (const arquivo of fs.readdirSync(dir)) {
    if (!arquivo.endsWith('.sqlite3')) continue;
    const caminho = path.join(dir, arquivo);
    const stat = fs.statSync(caminho);
    if (stat.mtimeMs < limite) fs.unlinkSync(caminho);
  }
}

// Pastas de arquivos "de verdade" que ficam FORA do banco -- fotos de
// produto, anexos de venda (PDF/imagem), XMLs de NFC-e emitida. O
// backup do .sqlite3 sozinho não inclui isso (o banco só guarda o
// CAMINHO do arquivo, não o conteúdo) -- pra chegar perto de um clone
// de verdade da instalação, espelha essas pastas também. Só LOCAL e na
// pasta secundária (se configurada) -- de propósito NÃO sobe pro
// Storage da nuvem (ver uploadBackupParaNuvem): fotos/anexos podem
// crescer bem mais que o banco (que é só texto/número) e sem limite
// óbvio, e subir isso tudo sem controle podia estourar a cota gratuita
// do Storage sem ninguém perceber. Pra ter uma cópia remota disso de
// verdade, aponte a pasta secundária pra uma pasta sincronizada por
// nuvem pessoal (Google Drive, OneDrive) -- ver LICENCIAMENTO.md,
// Passo 7.
function pastasParaEspelhar() {
  const { app } = require('electron');
  const base = app ? app.getPath('userData') : path.join(__dirname, '../../.data');
  return [
    { nome: 'anexos', origem: path.join(base, 'anexos') },
    { nome: 'fotos-produtos', origem: path.join(base, 'fotos-produtos') },
    { nome: 'nfce', origem: path.join(base, 'nfce') },
  ];
}

/** Copia (sobrescrevendo) as pastas acima pra dentro de `destinoBase`
 * (uma pasta "arquivos" ao lado dos .sqlite3). Melhor esforço por
 * pasta -- uma falhar não impede as outras nem o backup do banco, que
 * é a parte crítica. NÃO é versionado por backup como o .sqlite3 é
 * (ficaria enorme com fotos repetidas a cada backup diário) -- é
 * sempre um espelho do estado ATUAL, sobrescrito a cada backup novo. */
async function espelharArquivosAdicionais(destinoBase) {
  const avisos = [];
  for (const { nome, origem } of pastasParaEspelhar()) {
    if (!fs.existsSync(origem)) continue; // instalação que nunca usou essa pasta -- normal, não é erro
    try {
      const destino = path.join(destinoBase, nome);
      // fs.promises em vez de *Sync -- essas pastas (fotos de produto,
      // anexos, XMLs de NFC-e) podem crescer bastante, e a versão síncrona
      // travava a thread principal (e com ela toda a UI do Electron) pelo
      // tempo inteiro da cópia, toda vez que um backup rodava.
      await fs.promises.rm(destino, { recursive: true, force: true });
      await fs.promises.cp(origem, destino, { recursive: true });
    } catch (err) {
      avisos.push(`${nome}: ${err.message}`);
    }
  }
  return avisos;
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

  const avisosArquivos = await espelharArquivosAdicionais(path.join(backupsDir(), 'arquivos'));

  // Pasta secundária (opcional) — melhor esforço só. Se não existir, se
  // for um pendrive desconectado, etc., não trava nem marca falha geral.
  const config = getBackupConfig();
  let avisoSecundaria = null;
  if (config.pasta_secundaria) {
    try {
      fs.mkdirSync(config.pasta_secundaria, { recursive: true });
      fs.copyFileSync(destinoPrincipal, path.join(config.pasta_secundaria, nomeArquivo));
      avisosArquivos.push(...(await espelharArquivosAdicionais(path.join(config.pasta_secundaria, 'arquivos'))));
    } catch (err) {
      avisoSecundaria = `Backup local OK, mas falhou copiar para a pasta secundária: ${err.message}`;
    }
  }
  if (avisosArquivos.length > 0) {
    const resumo = `Fotos/anexos/NFC-e não espelhados por completo: ${avisosArquivos.join('; ')}`;
    avisoSecundaria = avisoSecundaria ? `${avisoSecundaria} | ${resumo}` : resumo;
  }

  marcarResultado(true);

  // Sobe pro Storage do projeto de licenciamento -- melhor esforço,
  // nunca trava nem marca falha geral do backup por causa disso (sem
  // internet é normal). É o que permite restaurar remotamente pela
  // Central se a máquina sumir de vez (ver restaurarSolicitadoSeHouver).
  // Só o banco -- ver comentário em pastasParaEspelhar sobre o motivo
  // de fotos/anexos/NFC-e ficarem de fora daqui.
  uploadBackupParaNuvem(destinoPrincipal, nomeArquivo).catch((err) => {
    console.error('[backupService] falha ao subir backup pra nuvem', err);
  });

  return { ok: true, arquivo: destinoPrincipal, avisoSecundaria };
}

/**
 * ⚠️ Como o resto da integração com o Firebase de licenciamento
 * (licenseService.js, updateService.js): usa o MESMO projeto/app
 * Firebase 'licensing', carregado sob demanda (nunca no topo do
 * arquivo) pelos mesmos motivos já documentados lá. Não testado contra
 * um projeto Firebase de verdade neste ambiente onde foi escrito --
 * teste com uma instalação de teste antes de confiar em produção.
 *
 * Mantém só os últimos N backups na nuvem por instalação (mais caro
 * que guardar local, e a Central só precisa de um resgate recente, não
 * do histórico completo de 30 dias que fica local).
 */
const RETENCAO_NUVEM = 10;

async function uploadBackupParaNuvem(caminhoLocal, nomeArquivo) {
  const licenseService = require('./licenseService');
  const pdvRegistryService = require('./pdvRegistryService');
  const { getStorage, ref, uploadBytes } = require('firebase/storage');
  const { getFirestore, doc, setDoc, serverTimestamp, collection, query, orderBy, getDocs, deleteDoc } = require('firebase/firestore');

  const installId = pdvRegistryService.getOrCreateDeviceUid();
  const storage = getStorage(licenseService.getLicenseApp());
  const firestore = getFirestore(licenseService.getLicenseApp());

  const bytes = fs.readFileSync(caminhoLocal);
  const caminhoStorage = `backups/${installId}/${nomeArquivo}`;
  const storageRef = ref(storage, caminhoStorage);

  try {
    await uploadBytes(storageRef, bytes);
    await setDoc(
      doc(firestore, 'installations', installId, 'backups', nomeArquivo),
      { nomeArquivo, caminhoStorage, tamanhoBytes: bytes.length, criadoEm: serverTimestamp() }
    );

    // Rotaciona a retenção na nuvem -- mantém só os N mais recentes.
    const lista = await getDocs(query(collection(firestore, 'installations', installId, 'backups'), orderBy('criadoEm', 'desc')));
    const excedentes = lista.docs.slice(RETENCAO_NUVEM);
    for (const d of excedentes) {
      try {
        const { deleteObject } = require('firebase/storage');
        await deleteObject(ref(storage, d.data().caminhoStorage));
      } catch { /* melhor esforço -- se já não existir no Storage, ignora */ }
      await deleteDoc(d.ref);
    }

    const db = getDb();
    db.prepare('UPDATE backup_config SET ultimo_upload_nuvem_em = NOW_SYNCED(), ultimo_upload_nuvem_ok = 1 WHERE id = ?').run('default');
  } catch (err) {
    const db = getDb();
    db.prepare('UPDATE backup_config SET ultimo_upload_nuvem_em = NOW_SYNCED(), ultimo_upload_nuvem_ok = 0 WHERE id = ?').run('default');
    throw err;
  }
}

/**
 * Chamada pela escuta em tempo real da instalação (licenseService) sempre
 * que o documento muda -- confere se tem um pedido de restauração remota
 * pendente (`restaurarBackupSolicitado`, escrito pela Central) e nunca
 * aplicado ainda. Baixa o arquivo do Storage, restaura por cima do banco
 * atual (subscrito 100%, igual restoreBackup local) e reinicia o app
 * sozinho -- não tem ninguém sentado na máquina pra clicar em nada.
 *
 * Só reage a pedido feito DEPOIS que a instalação já existia -- não
 * confunde com o campo vindo vazio/undefined em instalações antigas.
 */
async function restaurarSolicitadoSeHouver(dadosInstalacao) {
  const pedido = dadosInstalacao?.restaurarBackupSolicitado;
  if (!pedido?.nomeArquivo || !pedido?.caminhoStorage) return;

  const db = getDb();
  const config = getBackupConfig();
  const marcador = `${pedido.nomeArquivo}@${pedido.solicitadoEmMs || ''}`;
  if (config.ultima_restauracao_processada === marcador) return; // já aplicado, não repete

  db.prepare('UPDATE backup_config SET ultima_restauracao_processada = ? WHERE id = ?').run(marcador, 'default');

  const licenseService = require('./licenseService');
  const pdvRegistryService = require('./pdvRegistryService');
  const installId = pdvRegistryService.getOrCreateDeviceUid();

  try {
    const { getStorage, ref, getBytes } = require('firebase/storage');
    const { getFirestore, doc, setDoc, serverTimestamp } = require('firebase/firestore');
    const storage = getStorage(licenseService.getLicenseApp());
    const firestore = getFirestore(licenseService.getLicenseApp());

    const bytes = await getBytes(ref(storage, pedido.caminhoStorage));
    const destino = path.join(backupsDir(), `nuvem-${pedido.nomeArquivo}`);
    fs.writeFileSync(destino, Buffer.from(bytes));

    aplicarArquivoDeBackup(destino);

    await setDoc(
      doc(firestore, 'installations', installId),
      { restauracaoStatus: 'concluida', restauracaoConcluidaEm: serverTimestamp() },
      { merge: true }
    );

    // Sem ninguém pra reiniciar manualmente -- o app faz isso sozinho.
    // O arquivo já foi trocado no disco; o relaunch carrega ele puro.
    const { app } = require('electron');
    app.relaunch();
    app.exit(0);
  } catch (err) {
    console.error('[backupService] falha ao restaurar backup solicitado remotamente', err);
    try {
      const { getFirestore, doc, setDoc, serverTimestamp } = require('firebase/firestore');
      const firestore = getFirestore(licenseService.getLicenseApp());
      await setDoc(
        doc(firestore, 'installations', installId),
        { restauracaoStatus: 'falhou', restauracaoErro: err.message, restauracaoConcluidaEm: serverTimestamp() },
        { merge: true }
      );
    } catch { /* se nem isso conseguir avisar, só fica o log local mesmo */ }
  }
}

/**
 * Chamada pela escuta em tempo real da instalação (licenseService), igual
 * restaurarSolicitadoSeHouver -- confere se a Central pediu um backup
 * "agora" remotamente (botão na tela de Backups do painel, campo
 * `backupSolicitadoEm`, um timestamp em ms). Reaproveita runBackup() por
 * inteiro, então o backup pedido remotamente já sobe pra nuvem sozinho
 * também. Marca o pedido como processado ANTES de rodar (mesmo cuidado
 * do restore) pra não rodar de novo se a escuta disparar duas vezes
 * antes da Central limpar o campo.
 */
async function executarBackupRemotoSeSolicitado(dadosInstalacao) {
  const pedidoEmMs = dadosInstalacao?.backupSolicitadoEm;
  if (!pedidoEmMs) return;

  const db = getDb();
  const config = getBackupConfig();
  const marcador = String(pedidoEmMs);
  if (config.ultimo_pedido_backup_processado === marcador) return; // já processado

  db.prepare('UPDATE backup_config SET ultimo_pedido_backup_processado = ? WHERE id = ?').run(marcador, 'default');

  try {
    await runBackup();
  } catch (err) {
    console.error('[backupService] falha ao executar backup pedido remotamente pela Central', err);
  }
}

/** Troca o arquivo do banco pelo backup baixado -- mesma mecânica de
 * restoreBackup (fecha conexão, limpa -wal/-shm, sobrescreve), mas SEM
 * o requireRole(['admin']) local: a autorização de uma restauração
 * remota é o próprio login na Central (Firebase Auth), não o PIN local
 * -- não faz sentido exigir um admin sentado na máquina que, no
 * cenário que esse recurso existe pra cobrir, pode nem estar
 * acessível. */
function aplicarArquivoDeBackup(caminhoArquivo) {
  const { closeConnection } = require('../db/database');
  closeConnection();

  const dbPath = getDbPath();
  for (const sufixo of ['-wal', '-shm']) {
    const residual = dbPath + sufixo;
    if (fs.existsSync(residual)) fs.unlinkSync(residual);
  }
  fs.copyFileSync(caminhoArquivo, dbPath);
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
async function restoreBackup(requestingUserId, nomeArquivo) {
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

  const avisosArquivos = await restaurarArquivosAdicionaisSeHouver();
  return avisosArquivos.length > 0
    ? { ok: true, avisoArquivos: `Banco restaurado, mas alguns arquivos não: ${avisosArquivos.join('; ')}` }
    : { ok: true };
}

/** Contraparte de espelharArquivosAdicionais -- devolve fotos/anexos/
 * NFC-e do espelho mais recente (backupsDir()/arquivos) pra dentro das
 * pastas reais que o app usa, sobrescrevendo o que estiver lá. Só roda
 * se existir um espelho (instalações que nunca tiveram essas pastas
 * simplesmente não têm nada pra restaurar aqui -- não é erro). Melhor
 * esforço, igual o resto do backup: nunca impede a restauração do
 * banco (a parte crítica), que já aconteceu antes desta função rodar. */
async function restaurarArquivosAdicionaisSeHouver() {
  const origemEspelho = path.join(backupsDir(), 'arquivos');
  if (!fs.existsSync(origemEspelho)) return [];
  const avisos = [];
  for (const { nome, origem: destinoReal } of pastasParaEspelhar()) {
    const espelhoDaPasta = path.join(origemEspelho, nome);
    if (!fs.existsSync(espelhoDaPasta)) continue;
    try {
      // fs.promises -- ver o mesmo comentário em espelharArquivosAdicionais.
      await fs.promises.rm(destinoReal, { recursive: true, force: true });
      await fs.promises.cp(espelhoDaPasta, destinoReal, { recursive: true });
    } catch (err) {
      avisos.push(`${nome}: ${err.message}`);
    }
  }
  return avisos;
}

module.exports = {
  getStatus, updateConfig, runBackup, runBackupIfNeeded, listBackups, restoreBackup, backupsDir, getDbPath,
  restaurarSolicitadoSeHouver, executarBackupRemotoSeSolicitado, salvarContaGoogle,
  // Exportado só pra teste direto da criptografia (ver tests/backupService.test.js)
  // -- sem precisar de um projeto Firebase de verdade pra validar o
  // round-trip cifra/decifra em si.
  cifrarComChavePublica,
};
