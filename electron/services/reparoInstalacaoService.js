const fs = require('fs');
const path = require('path');

/**
 * Reparo automático da instalação (Windows).
 *
 * O problema: a atualização roda o instalador NSIS em silêncio quando o app
 * fecha. Ele primeiro APAGA a versão antiga e só depois copia a nova; se for
 * interrompido no meio (Windows desligando logo depois de fechar o app,
 * antivírus segurando um arquivo, queda de energia), sobra o atalho
 * apontando pra um GerenciaAI.exe que não existe mais ("O item
 * 'GerenciaAI.exe' a que este atalho se refere foi alterado ou movido").
 * Com o .exe sumido, o próprio app não tem como se consertar -- quem
 * conserta é um script FORA da pasta de instalação:
 *
 *   %LOCALAPPDATA%\GerenciaAI-reparo\
 *     reparar.ps1                       o script (reescrito a cada abertura)
 *     GerenciaAI-instalador-reparo.exe  cópia do último instalador baixado
 *     instalador.json                   versão dessa cópia
 *     atualizando.json                  "uma atualização começou a instalar"
 *     relatos.jsonl                     o que o script fez (o app manda pra Central)
 *     reparo.log                        histórico legível
 *
 * Ele roda (1) a cada login no Windows (chave Run do usuário) e (2) logo
 * depois que o app fecha para instalar uma atualização (vigia: espera o
 * instalador terminar e confere). Se o .exe sumiu, reinstala em silêncio
 * por cima, na mesma pasta -- os dados ficam em %APPDATA%, não são tocados.
 * Se o GerenciaAI foi desinstalado de propósito, o script se remove sozinho.
 */

const NOME_PASTA = 'GerenciaAI-reparo';
const NOME_SCRIPT = 'reparar.ps1';
const NOME_INSTALADOR = 'GerenciaAI-instalador-reparo.exe';
const NOME_RUN = 'GerenciaAI-Reparo';
const CHAVE_RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// GUID que o electron-builder dá à instalação (UUID v5 do appId
// "com.arthur.gerenciaai") -- é o nome da chave em "Programas e Recursos".
// tests/reparoInstalacao.test.js recalcula a partir do package.json.
const GUID_INSTALACAO = '716c87b5-73ea-56e0-a27d-394dd6f084d1';

function pastaReparo(env = process.env) {
  if (env.GERENCIAAI_REPARO_DIR) return env.GERENCIAAI_REPARO_DIR; // só testes
  const base = env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : null);
  return base ? path.join(base, NOME_PASTA) : null;
}

const caminhos = (pasta) => ({
  script: path.join(pasta, NOME_SCRIPT),
  instalador: path.join(pasta, NOME_INSTALADOR),
  infoInstalador: path.join(pasta, 'instalador.json'),
  marcador: path.join(pasta, 'atualizando.json'),
  relatos: path.join(pasta, 'relatos.jsonl'),
});

/** Instalação "para todos os usuários" (Arquivos de Programas) precisa de administrador. */
function ehInstalacaoPorMaquina(pastaApp, env = process.env) {
  const alvo = String(pastaApp || '').toLowerCase().replace(/[\\/]+$/, '');
  return [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]
    .filter(Boolean)
    .map((p) => p.toLowerCase().replace(/[\\/]+$/, ''))
    .some((p) => alvo === p || alvo.startsWith(p + '\\') || alvo.startsWith(p + '/'));
}

/** Texto entre aspas simples do PowerShell (aspa simples dobra). */
function textoPs(valor) {
  return `'${String(valor).replace(/'/g, "''")}'`;
}

function chavesDeRegistro(guid = GUID_INSTALACAO) {
  return [
    `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
    `HKCU:\\Software\\${guid}`,
    `HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
    `HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
    `HKLM:\\Software\\${guid}`,
    `HKLM:\\Software\\WOW6432Node\\${guid}`,
  ];
}

/**
 * Script PowerShell (compatível com o Windows PowerShell 5.1 do Windows 10).
 * Puro: recebe tudo pronto, pra dar pra testar a geração e rodar o script
 * num PowerShell de verdade nos testes.
 */
function gerarScript({ exe, asar = null, pastaApp, pasta, porMaquina, guid = GUID_INSTALACAO, diasMarcador = 7 }) {
  const c = caminhos(pasta);
  return `# GerenciaAI - reparo automatico da instalacao.
# Gerado pelo proprio GerenciaAI (electron/services/reparoInstalacaoService.js)
# a cada abertura do app: qualquer edicao manual aqui se perde.
param([string]$Modo = 'Logon', [string]$NomeInstalador = '', [int]$EsperaInicialSegundos = 90)

$ErrorActionPreference = 'Stop'
$Exe            = ${textoPs(exe)}
$Asar           = ${asar ? textoPs(asar) : "''"}
$PastaApp       = ${textoPs(pastaApp)}
$Pasta          = ${textoPs(pasta)}
$Instalador     = ${textoPs(c.instalador)}
$InfoInstalador = ${textoPs(c.infoInstalador)}
$Marcador       = ${textoPs(c.marcador)}
$Relatos        = ${textoPs(c.relatos)}
$Log            = ${textoPs(path.join(pasta, 'reparo.log'))}
$Trava          = ${textoPs(path.join(pasta, 'reparo.trava'))}
$PorMaquina     = ${porMaquina ? '$true' : '$false'}
$DiasMarcador   = ${Number(diasMarcador) || 7}
$ChavesRegistro = @(${chavesDeRegistro(guid).map(textoPs).join(', ')})
$NomeRun        = ${textoPs(NOME_RUN)}

function Registrar([string]$Texto) {
  try { Add-Content -LiteralPath $Log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  [' + $Modo + '] ' + $Texto) -Encoding UTF8 } catch { }
}

function Relatar([hashtable]$Dados) {
  try {
    $Dados['quando'] = (Get-Date).ToString('o')
    $Dados['modo'] = $Modo
    Add-Content -LiteralPath $Relatos -Value ($Dados | ConvertTo-Json -Compress) -Encoding UTF8
  } catch { }
}

function InstalacaoInteira {
  if (-not (Test-Path -LiteralPath $Exe)) { return $false }
  if ($Asar -and -not (Test-Path -LiteralPath $Asar)) { return $false }
  return $true
}

# Instalador da atualizacao, o desinstalador temporario que o NSIS usa
# no meio dela, ou o proprio instalador de reparo.
function InstaladorRodando {
  $nomes = @('old-uninstaller', 'Un_A', 'Au_', 'GerenciaAI-instalador-reparo')
  if ($NomeInstalador) { $nomes += $NomeInstalador }
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    $n = [string]$p.ProcessName
    if ($nomes -contains $n) { return $true }
    if ($n -like 'GerenciaAI*Setup*') { return $true }
  }
  return $false
}

function EsperarInstaladorTerminar([int]$Minutos) {
  $ate = (Get-Date).AddMinutes($Minutos)
  while ((InstaladorRodando) -and ((Get-Date) -lt $ate)) { Start-Sleep -Seconds 3 }
  return -not (InstaladorRodando)
}

function MarcadorRecente {
  try {
    if (-not (Test-Path -LiteralPath $Marcador)) { return $false }
    return ((Get-Item -LiteralPath $Marcador).LastWriteTime -gt (Get-Date).AddDays(-$DiasMarcador))
  } catch { return $false }
}

function AindaInstalado {
  foreach ($k in $ChavesRegistro) {
    try { if (Test-Path -LiteralPath $k) { return $true } } catch { }
  }
  return $false
}

function VersaoDoInstalador {
  try { return [string]((Get-Content -LiteralPath $InfoInstalador -Raw | ConvertFrom-Json).versao) } catch { return '' }
}

function ApagarMarcador {
  try { if (Test-Path -LiteralPath $Marcador) { Remove-Item -LiteralPath $Marcador -Force } } catch { }
}

# Devolve: 'ok', 'reparado', 'falhou', 'sem_instalador', 'ocupado' ou 'desinstalado'
function Executar {
  if ($Modo -eq 'Vigiar') {
    # O instalador da atualizacao sobe logo depois que o app fecha.
    $ate = (Get-Date).AddSeconds($EsperaInicialSegundos)
    while (-not (InstaladorRodando) -and ((Get-Date) -lt $ate)) { Start-Sleep -Seconds 2 }
  }
  if (-not (EsperarInstaladorTerminar 20)) {
    Registrar 'instalador ainda rodando depois de 20 min; nao mexo agora'
    return 'ocupado'
  }
  if ($Modo -eq 'Vigiar') { Start-Sleep -Seconds 3 }

  if (InstalacaoInteira) {
    if (Test-Path -LiteralPath $Marcador) { Registrar 'atualizacao conferida: instalacao inteira' }
    ApagarMarcador
    return 'ok'
  }

  $motivo = ''
  if (MarcadorRecente) { $motivo = 'atualizacao_interrompida' }
  elseif (AindaInstalado) { $motivo = 'arquivos_faltando' }
  if (-not $motivo) { return 'desinstalado' }

  $versao = VersaoDoInstalador
  if (-not (Test-Path -LiteralPath $Instalador)) {
    Registrar ('GerenciaAI.exe sumiu (' + $motivo + ') e nao ha instalador guardado para reparar')
    Relatar @{ resultado = 'sem_instalador'; motivo = $motivo; versao = $versao }
    return 'sem_instalador'
  }

  if ($PorMaquina) { $escopo = '/allusers' } else { $escopo = '/currentuser' }
  # /D= tem que ser o ultimo e sem aspas (regra do NSIS).
  $argumentos = '/S ' + $escopo + ' /D=' + $PastaApp
  Registrar ('reparando (' + $motivo + '): reinstalando a versao ' + $versao + ' em ' + $PastaApp)
  $codigo = $null
  try {
    if ($PorMaquina) {
      $p = Start-Process -FilePath $Instalador -ArgumentList $argumentos -Verb RunAs -PassThru
    } else {
      $p = Start-Process -FilePath $Instalador -ArgumentList $argumentos -PassThru
    }
    if ($p.WaitForExit(20 * 60 * 1000)) {
      try { $codigo = $p.ExitCode } catch { }
    } else {
      Registrar 'o instalador passou de 20 minutos'
    }
  } catch {
    Registrar ('nao consegui rodar o instalador: ' + $_.Exception.Message)
  }
  Start-Sleep -Seconds 2

  if (InstalacaoInteira) {
    ApagarMarcador
    Registrar 'reparado'
    Relatar @{ resultado = 'ok'; motivo = $motivo; versao = $versao; codigo = $codigo }
    if ($Modo -eq 'Logon') {
      try { Start-Process -FilePath $Exe } catch { Registrar ('reparado, mas nao abriu: ' + $_.Exception.Message) }
    }
    return 'reparado'
  }
  Registrar ('reparo falhou (codigo ' + $codigo + ')')
  Relatar @{ resultado = 'falhou'; motivo = $motivo; versao = $versao; codigo = $codigo }
  return 'falhou'
}

if (-not (Test-Path -LiteralPath $Pasta)) { exit 0 }
$travaArquivo = $null
try {
  $travaArquivo = [System.IO.File]::Open($Trava, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  exit 0  # outra copia deste script ja esta cuidando
}

$resultado = 'falhou'
try {
  $resultado = Executar
} catch {
  Registrar ('erro inesperado: ' + $_.Exception.Message)
} finally {
  $travaArquivo.Dispose()
}

if ($resultado -eq 'desinstalado') {
  # Desinstalado de proposito (sem atualizacao em andamento e sem registro
  # no Windows): o reparo tambem sai, senao reinstalaria a cada login.
  try { Remove-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $NomeRun -ErrorAction SilentlyContinue } catch { }
  try { Remove-Item -LiteralPath $Pasta -Recurse -Force } catch { }
  exit 0
}
if ($resultado -eq 'falhou' -or $resultado -eq 'sem_instalador') { exit 1 }
exit 0
`;
}

function caminhoPowerShell(env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function argumentosPowerShell(script, modo, extras = []) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Modo', modo, ...extras];
}

/** Valor da chave Run (uma linha de comando do Windows). */
function comandoDoLogin(script, env = process.env) {
  return `"${caminhoPowerShell(env)}" ${argumentosPowerShell(script, 'Logon').map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ')}`;
}

function gravarSeMudou(arquivo, conteudo) {
  try {
    if (fs.readFileSync(arquivo, 'utf-8') === conteudo) return false;
  } catch { /* não existe ainda */ }
  const tmp = `${arquivo}.tmp`;
  fs.writeFileSync(tmp, conteudo, 'utf-8');
  fs.renameSync(tmp, arquivo);
  return true;
}

/** Versões tipo "1.0.10" (mesma regra de updateService.versaoMenorQue). */
function versaoMenor(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}

/**
 * Chamada a cada abertura do app (Windows, instalado): grava o script e
 * registra a execução no login. Barata: só reescreve o que mudou.
 */
function prepararReparo({ exe = process.execPath, env = process.env, executar = require('child_process').execFile } = {}) {
  const pasta = pastaReparo(env);
  if (!pasta) return { ok: false, motivo: 'sem_pasta' };
  fs.mkdirSync(pasta, { recursive: true });
  const pastaApp = path.dirname(exe);
  const asar = path.join(pastaApp, 'resources', 'app.asar');
  const c = caminhos(pasta);
  const script = '\uFEFF' + gerarScript({
    exe,
    asar: fs.existsSync(asar) ? asar : null, // nunca exigir um arquivo que esta build não tem
    pastaApp,
    pasta,
    porMaquina: ehInstalacaoPorMaquina(pastaApp, env),
  });
  gravarSeMudou(c.script, script);
  return new Promise((resolve) => {
    executar('reg.exe', ['add', CHAVE_RUN, '/v', NOME_RUN, '/t', 'REG_SZ', '/d', comandoDoLogin(c.script, env), '/f'], { windowsHide: true }, (err) => {
      if (err) console.error('[reparo] não consegui registrar a verificação no login:', err.message);
      resolve({ ok: !err, script: c.script });
    });
  });
}

/** Guarda uma cópia do instalador baixado (fora da pasta do app). */
async function guardarInstalador(origem, versao, env = process.env) {
  const pasta = pastaReparo(env);
  if (!pasta || !origem || !versao) return false;
  try {
    await fs.promises.mkdir(pasta, { recursive: true });
    const c = caminhos(pasta);
    const tmp = `${c.instalador}.tmp`;
    await fs.promises.copyFile(origem, tmp);
    await fs.promises.rename(tmp, c.instalador);
    await fs.promises.writeFile(c.infoInstalador, JSON.stringify({ versao: String(versao), guardadoEm: new Date().toISOString() }));
    return true;
  } catch (err) {
    console.error('[reparo] não consegui guardar o instalador:', err.message);
    return false;
  }
}

/** Antes do instalador da atualização rodar: "se o .exe sumir, foi isso". */
function marcarAtualizacaoInstalando(versao, env = process.env) {
  const pasta = pastaReparo(env);
  if (!pasta) return false;
  try {
    fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(caminhos(pasta).marcador, JSON.stringify({ versao: String(versao || ''), em: new Date().toISOString() }));
    return true;
  } catch (err) {
    console.error('[reparo] não consegui marcar a atualização:', err.message);
    return false;
  }
}

/** Vigia que sobrevive ao app: espera o instalador terminar e confere. */
function iniciarVigia({ nomeInstalador = '', env = process.env, spawn = require('child_process').spawn } = {}) {
  const pasta = pastaReparo(env);
  if (!pasta) return false;
  const { script } = caminhos(pasta);
  if (!fs.existsSync(script)) return false;
  try {
    const extras = nomeInstalador ? ['-NomeInstalador', nomeInstalador] : [];
    const filho = spawn(caminhoPowerShell(env), argumentosPowerShell(script, 'Vigiar', extras), { detached: true, stdio: 'ignore', windowsHide: true });
    filho.on('error', (err) => console.error('[reparo] vigia não iniciou:', err.message));
    filho.unref();
    return true;
  } catch (err) {
    console.error('[reparo] vigia não iniciou:', err.message);
    return false;
  }
}

/**
 * Na abertura: o app abriu, então a instalação está inteira -- apaga o
 * marcador; descarta cópia de instalador mais velha que a versão atual
 * (reparar com ela seria voltar versão); devolve o que o script relatou
 * desde a última abertura (e esvazia o arquivo).
 */
function aoAbrir({ versaoAtual, env = process.env } = {}) {
  const pasta = pastaReparo(env);
  if (!pasta || !fs.existsSync(pasta)) return [];
  const c = caminhos(pasta);
  try { fs.unlinkSync(c.marcador); } catch { /* não existia */ }
  try {
    const info = JSON.parse(fs.readFileSync(c.infoInstalador, 'utf-8').replace(/^\uFEFF/, ''));
    if (versaoAtual && info?.versao && versaoMenor(info.versao, versaoAtual)) {
      fs.rmSync(c.instalador, { force: true });
      fs.rmSync(c.infoInstalador, { force: true });
    }
  } catch { /* sem cópia guardada */ }
  let relatos = [];
  try {
    const texto = fs.readFileSync(c.relatos, 'utf-8');
    fs.rmSync(c.relatos, { force: true });
    relatos = texto.split(/\r?\n/)
      .map((l) => l.replace(/^\uFEFF/, '').trim())
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { /* nada relatado */ }
  return relatos;
}

function lerInfoInstalador(pasta) {
  try { return JSON.parse(fs.readFileSync(caminhos(pasta).infoInstalador, 'utf-8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/** Campos de primeiro nível do latest.yml do electron-builder. */
function lerLatestYml(texto) {
  const campo = (nome) => {
    const m = new RegExp(`^${nome}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm').exec(String(texto));
    return m ? m[1] : null;
  };
  return { versao: campo('version'), arquivo: campo('path'), sha512: campo('sha512') };
}

/**
 * Repositório das releases. No app instalado o electron-builder tira o
 * campo "build" do package.json; quem guarda isso é o resources/app-update.yml
 * (o mesmo arquivo que o electron-updater lê).
 */
function lerPublishDoApp(resourcesPath = process.resourcesPath) {
  try {
    const texto = fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf-8');
    const campo = (nome) => (new RegExp(`^${nome}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm').exec(texto) || [])[1] || null;
    const owner = campo('owner');
    const repo = campo('repo');
    if (owner && repo) return { owner, repo };
  } catch { /* fora do app instalado */ }
  return null;
}

/**
 * Sem cópia do instalador da versão em uso (primeira abertura com o reparo,
 * ou versão instalada à mão), baixa a da release desta versão no GitHub e
 * confere o sha512 do latest.yml antes de guardar. Uma vez por versão.
 */
async function garantirInstaladorDaVersaoAtual({ versaoAtual, publish, env = process.env, buscar } = {}) {
  const pasta = pastaReparo(env);
  if (!pasta || !versaoAtual || !publish?.owner || !publish?.repo) return 'sem_config';
  const c = caminhos(pasta);
  const info = lerInfoInstalador(pasta);
  if (info?.versao && !versaoMenor(info.versao, versaoAtual) && fs.existsSync(c.instalador)) return 'ja_tem';
  const f = buscar || require('electron').net?.fetch?.bind(require('electron').net) || fetch;
  const base = `https://github.com/${publish.owner}/${publish.repo}/releases/download/v${versaoAtual}`;
  const respYml = await f(`${base}/latest.yml`);
  if (!respYml.ok) return 'sem_release';
  const yml = lerLatestYml(await respYml.text());
  if (yml.versao !== String(versaoAtual) || !yml.arquivo || !yml.sha512 || /[\\/]/.test(yml.arquivo)) return 'latest_invalido';
  const resp = await f(`${base}/${encodeURIComponent(yml.arquivo)}`);
  if (!resp.ok || !resp.body) return 'sem_instalador';
  await fs.promises.mkdir(pasta, { recursive: true });
  const tmp = `${c.instalador}.baixando`;
  const hash = require('crypto').createHash('sha512');
  const { Readable, Transform } = require('stream');
  const { pipeline } = require('stream/promises');
  try {
    await pipeline(
      Readable.fromWeb(resp.body),
      new Transform({ transform(pedaco, _enc, cb) { hash.update(pedaco); cb(null, pedaco); } }),
      fs.createWriteStream(tmp),
    );
    if (hash.digest('base64') !== yml.sha512) {
      await fs.promises.rm(tmp, { force: true });
      return 'sha_diferente';
    }
    await fs.promises.rename(tmp, c.instalador);
    await fs.promises.writeFile(c.infoInstalador, JSON.stringify({ versao: String(versaoAtual), guardadoEm: new Date().toISOString(), origem: 'release' }));
    return 'baixado';
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function textoDoRelato(r) {
  const motivo = r.motivo === 'atualizacao_interrompida' ? 'atualização interrompida no meio' : 'arquivos do programa faltando';
  const quando = r.quando ? ` em ${r.quando}` : '';
  if (r.resultado === 'ok') return `Reparo automático: GerenciaAI.exe tinha sumido (${motivo}) e foi reinstalado sozinho${r.versao ? ` na v${r.versao}` : ''}${quando}.`;
  if (r.resultado === 'sem_instalador') return `Reparo automático não conseguiu agir: GerenciaAI.exe sumiu (${motivo}) e não havia instalador guardado${quando}.`;
  return `Reparo automático falhou: GerenciaAI.exe sumiu (${motivo}) e a reinstalação não deu certo${r.codigo !== undefined && r.codigo !== null ? ` (código ${r.codigo})` : ''}${quando}.`;
}

module.exports = {
  NOME_RUN, NOME_INSTALADOR, GUID_INSTALACAO, pastaReparo, ehInstalacaoPorMaquina, textoPs, chavesDeRegistro,
  gerarScript, comandoDoLogin, argumentosPowerShell, caminhoPowerShell, prepararReparo, guardarInstalador,
  marcarAtualizacaoInstalando, iniciarVigia, aoAbrir, textoDoRelato, versaoMenor,
  garantirInstaladorDaVersaoAtual, lerLatestYml, lerPublishDoApp,
};
