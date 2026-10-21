const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const reparo = require('../electron/services/reparoInstalacaoService');

// O script de reparo é PowerShell (roda no Windows do cliente). Estes testes
// executam o script de verdade quando há um PowerShell disponível
// (GERENCIAAI_PWSH=/caminho/pwsh ou `pwsh` no PATH); sem ele, só a parte em
// Node roda.
function acharPwsh() {
  const candidatos = [process.env.GERENCIAAI_PWSH, 'pwsh', 'powershell'].filter(Boolean);
  for (const c of candidatos) {
    try {
      const r = spawnSync(c, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf-8', timeout: 30000 });
      if (r.status === 0) return c;
    } catch { /* não tem */ }
  }
  return null;
}
const PWSH = acharPwsh();
const SEM_PWSH = !PWSH && 'sem PowerShell nesta máquina (defina GERENCIAAI_PWSH)';
const EH_WINDOWS = process.platform === 'win32';

function pastaTemp(prefixo) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefixo}-`));
}

test('GUID da instalação bate com o que o electron-builder gera pro appId do package.json', (t) => {
  let UUID;
  try { ({ UUID } = require('builder-util-runtime')); } catch { t.skip('builder-util-runtime não instalado'); return; }
  const appId = require('../package.json').build.appId;
  const ns = UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'); // ELECTRON_BUILDER_NS_UUID (app-builder-lib NsisTarget)
  assert.equal(UUID.v5(appId, ns), reparo.GUID_INSTALACAO);
});

test('instalação em Arquivos de Programas é "por máquina"; em AppData é do usuário', () => {
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  assert.equal(reparo.ehInstalacaoPorMaquina('C:\\Program Files\\GerenciaAI', env), true);
  assert.equal(reparo.ehInstalacaoPorMaquina('c:\\program files (x86)\\GerenciaAI\\', env), true);
  assert.equal(reparo.ehInstalacaoPorMaquina('C:\\Users\\Ana\\AppData\\Local\\Programs\\GerenciaAI', env), false);
  assert.equal(reparo.ehInstalacaoPorMaquina('C:\\Program FilesX\\GerenciaAI', env), false);
});

test('comando do login: caminhos com espaço entre aspas, modo Logon, janela escondida', () => {
  const cmd = reparo.comandoDoLogin('C:\\Users\\João Silva\\AppData\\Local\\GerenciaAI-reparo\\reparar.ps1', { SystemRoot: 'C:\\Windows' });
  assert.equal(cmd, '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Users\\João Silva\\AppData\\Local\\GerenciaAI-reparo\\reparar.ps1" -Modo Logon');
});

test('script: caminho com aspa simples não quebra o texto do PowerShell', () => {
  assert.equal(reparo.textoPs("C:\\Users\\D'Ávila\\x"), "'C:\\Users\\D''Ávila\\x'");
  const s = reparo.gerarScript({ exe: "C:\\Users\\D'Ávila\\GerenciaAI.exe", pastaApp: "C:\\Users\\D'Ávila", pasta: 'C:\\r', porMaquina: false });
  assert.match(s, /\$Exe\s+= 'C:\\Users\\D''Ávila\\GerenciaAI\.exe'/);
  assert.match(s, /\$PorMaquina\s+= \$false/);
  assert.match(s, /716c87b5-73ea-56e0-a27d-394dd6f084d1/);
});

test('script é PowerShell válido (parser do próprio PowerShell)', { skip: SEM_PWSH }, () => {
  const dir = pastaTemp('reparo-parse');
  const arq = path.join(dir, 'r.ps1');
  fs.writeFileSync(arq, reparo.gerarScript({ exe: "C:\\a b\\D'x\\GerenciaAI.exe", asar: 'C:\\a b\\resources\\app.asar', pastaApp: 'C:\\a b', pasta: 'C:\\r', porMaquina: true }));
  const r = spawnSync(PWSH, ['-NoProfile', '-Command',
    `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${arq.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e.Count`], { encoding: 'utf-8' });
  assert.equal(r.stdout.trim(), '0', r.stderr);
});

test('aoAbrir: apaga o marcador, descarta instalador mais velho e devolve os relatos (com BOM)', () => {
  const pasta = pastaTemp('reparo-abrir');
  const env = { GERENCIAAI_REPARO_DIR: pasta };
  fs.writeFileSync(path.join(pasta, 'atualizando.json'), '{}');
  fs.writeFileSync(path.join(pasta, reparo.NOME_INSTALADOR), 'x');
  fs.writeFileSync(path.join(pasta, 'instalador.json'), JSON.stringify({ versao: '1.0.3' }));
  fs.writeFileSync(path.join(pasta, 'relatos.jsonl'), '\uFEFF{"resultado":"ok","motivo":"atualizacao_interrompida","versao":"1.0.3"}\r\nlixo\r\n');

  const relatos = reparo.aoAbrir({ versaoAtual: '1.0.10', env });
  assert.deepEqual(relatos, [{ resultado: 'ok', motivo: 'atualizacao_interrompida', versao: '1.0.3' }]);
  assert.equal(fs.existsSync(path.join(pasta, 'atualizando.json')), false);
  assert.equal(fs.existsSync(path.join(pasta, reparo.NOME_INSTALADOR)), false); // 1.0.3 < 1.0.10: reparar com ele seria voltar versão
  assert.equal(fs.existsSync(path.join(pasta, 'relatos.jsonl')), false);
  assert.deepEqual(reparo.aoAbrir({ versaoAtual: '1.0.10', env }), []);
});

test('aoAbrir mantém instalador da mesma versão ou mais nova', () => {
  const pasta = pastaTemp('reparo-abrir2');
  const env = { GERENCIAAI_REPARO_DIR: pasta };
  fs.writeFileSync(path.join(pasta, reparo.NOME_INSTALADOR), 'x');
  fs.writeFileSync(path.join(pasta, 'instalador.json'), JSON.stringify({ versao: '1.0.4' }));
  reparo.aoAbrir({ versaoAtual: '1.0.4', env });
  assert.equal(fs.existsSync(path.join(pasta, reparo.NOME_INSTALADOR)), true);
});

test('guardarInstalador copia o instalador baixado e grava a versão', async () => {
  const pasta = pastaTemp('reparo-guardar');
  const origem = path.join(pastaTemp('reparo-origem'), 'GerenciaAI-Setup-1.0.4.exe');
  fs.writeFileSync(origem, 'instalador');
  assert.equal(await reparo.guardarInstalador(origem, '1.0.4', { GERENCIAAI_REPARO_DIR: path.join(pasta, 'sub') }), true);
  assert.equal(fs.readFileSync(path.join(pasta, 'sub', reparo.NOME_INSTALADOR), 'utf-8'), 'instalador');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pasta, 'sub', 'instalador.json'), 'utf-8')).versao, '1.0.4');
  assert.equal(await reparo.guardarInstalador(path.join(pasta, 'nao-existe.exe'), '1.0.5', { GERENCIAAI_REPARO_DIR: pasta }), false);
});

test('prepararReparo grava o script com BOM e registra a chave Run do usuário', async () => {
  const pasta = pastaTemp('reparo-preparar');
  const app = pastaTemp('reparo-app');
  const chamadas = [];
  const r = await reparo.prepararReparo({
    exe: path.join(app, 'GerenciaAI.exe'),
    env: { GERENCIAAI_REPARO_DIR: pasta, SystemRoot: 'C:\\Windows' },
    executar: (cmd, args, _o, cb) => { chamadas.push([cmd, args]); cb(null); },
  });
  assert.equal(r.ok, true);
  const script = fs.readFileSync(path.join(pasta, 'reparar.ps1'), 'utf-8');
  assert.equal(script.charCodeAt(0), 0xFEFF); // Windows PowerShell 5.1 só lê acento com BOM
  assert.match(script, /\$Asar\s+= ''/); // build sem app.asar: não exige o arquivo
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0][0], 'reg.exe');
  assert.deepEqual(chamadas[0][1].slice(0, 6), ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'GerenciaAI-Reparo', '/t', 'REG_SZ']);
  assert.match(chamadas[0][1][7], /-File ".*reparar\.ps1" -Modo Logon$|-File .*reparar\.ps1 -Modo Logon$/);
});

test('updateService: Windows desligando não instala a atualização no fechamento', () => {
  const updateService = require('../electron/services/updateService');
  assert.equal(updateService.instalarAoFecharPermitido(false), true);
  updateService.windowsEstaEncerrando();
  assert.equal(updateService.instalarAoFecharPermitido(false), false);
  assert.equal(updateService.antesDeFechar(), false); // nada baixado / fora do Windows: nunca vigia
});

// ---------------------------------------------------------------------
// O script de verdade, com um instalador falso. Fora do Windows o
// "instalador" é um shell script; o registro (HKCU:/HKLM:) não existe,
// então "ainda instalado" só vale pelo marcador de atualização.
// ---------------------------------------------------------------------

function montarCenario({ comExe = false, comMarcador = false, comInstalador = true, instaladorFunciona = true } = {}) {
  const raiz = pastaTemp('reparo-cenario');
  const pastaApp = path.join(raiz, 'Programs', 'GerenciaAI');
  const pasta = path.join(raiz, 'GerenciaAI-reparo');
  fs.mkdirSync(pasta, { recursive: true });
  const exe = path.join(pastaApp, 'GerenciaAI.exe');
  const asar = path.join(pastaApp, 'resources', 'app.asar');
  if (comExe) {
    fs.mkdirSync(path.dirname(asar), { recursive: true });
    fs.writeFileSync(exe, '');
    fs.writeFileSync(asar, '');
  }
  if (comMarcador) fs.writeFileSync(path.join(pasta, 'atualizando.json'), '{"versao":"1.0.4"}');
  const rodou = path.join(raiz, 'instalador-rodou.txt');
  if (comInstalador) {
    const inst = path.join(pasta, reparo.NOME_INSTALADOR);
    const corpo = instaladorFunciona
      ? `dir=""; for a in "$@"; do case "$a" in /D=*) dir="\${a#/D=}";; esac; done
mkdir -p "$dir/resources" && : > "$dir/GerenciaAI.exe" && : > "$dir/resources/app.asar"`
      : 'exit 2';
    fs.writeFileSync(inst, `#!/bin/sh\necho "$@" > '${rodou}'\n${corpo}\n`);
    fs.chmodSync(inst, 0o755);
    fs.writeFileSync(path.join(pasta, 'instalador.json'), '{"versao":"1.0.4"}');
  }
  const script = path.join(pasta, 'reparar.ps1');
  fs.writeFileSync(script, '\uFEFF' + reparo.gerarScript({ exe, asar, pastaApp, pasta, porMaquina: false }));
  return { raiz, pastaApp, pasta, exe, asar, rodou, script };
}

function rodarScript(c, modo = 'Logon', extras = []) {
  return spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-File', c.script, '-Modo', modo, ...extras], { encoding: 'utf-8', timeout: 180000 });
}
function lerRelatos(c) {
  try {
    return fs.readFileSync(path.join(c.pasta, 'relatos.jsonl'), 'utf-8').split(/\r?\n/).map((l) => l.replace(/^\uFEFF/, '').trim()).filter(Boolean).map(JSON.parse);
  } catch { return []; }
}

const SEM_PWSH_POSIX = SEM_PWSH || (EH_WINDOWS && 'cenários com instalador falso usam shell script (só fora do Windows)');

test('script: instalação inteira -> não faz nada e apaga marcador antigo', { skip: SEM_PWSH_POSIX }, () => {
  const c = montarCenario({ comExe: true, comMarcador: true });
  const r = rodarScript(c);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.existsSync(c.rodou), false);
  assert.equal(fs.existsSync(path.join(c.pasta, 'atualizando.json')), false);
});

test('script: .exe sumiu depois de atualização interrompida -> reinstala na mesma pasta e relata', { skip: SEM_PWSH_POSIX }, () => {
  const c = montarCenario({ comMarcador: true });
  const r = rodarScript(c);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(c.rodou, 'utf-8').trim(), `/S /currentuser /D=${c.pastaApp}`);
  assert.equal(fs.existsSync(c.exe), true);
  assert.equal(fs.existsSync(path.join(c.pasta, 'atualizando.json')), false);
  const [relato] = lerRelatos(c);
  assert.equal(relato.resultado, 'ok');
  assert.equal(relato.motivo, 'atualizacao_interrompida');
  assert.equal(relato.versao, '1.0.4');
  assert.equal(relato.modo, 'Logon');
});

test('script: só o app.asar sumiu -> também conta como instalação quebrada', { skip: SEM_PWSH_POSIX }, () => {
  const c = montarCenario({ comExe: true, comMarcador: true });
  fs.rmSync(c.asar);
  assert.equal(rodarScript(c).status, 0);
  assert.equal(fs.existsSync(c.rodou), true);
  assert.equal(fs.existsSync(c.asar), true);
});

test('script: desinstalado de propósito (sem marcador, sem registro) -> não reinstala e se remove', { skip: SEM_PWSH_POSIX }, () => {
  const c = montarCenario();
  const r = rodarScript(c);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.existsSync(c.rodou), false);
  assert.equal(fs.existsSync(c.exe), false);
  assert.equal(fs.existsSync(c.pasta), false);
});

test('script: sem instalador guardado -> não inventa, relata e sai com erro', { skip: SEM_PWSH_POSIX }, () => {
  const c = montarCenario({ comMarcador: true, comInstalador: false });
  const r = rodarScript(c);
  assert.equal(r.status, 1);
  assert.equal(lerRelatos(c)[0].resultado, 'sem_instalador');
  assert.equal(fs.existsSync(path.join(c.pasta, 'atualizando.json')), true); // tenta de novo no próximo login
});

test('script: instalador falhou -> relata falha e mantém o marcador pra tentar no próximo login', { skip: SEM_PWSH_POSIX }, () => {
  const c = montarCenario({ comMarcador: true, instaladorFunciona: false });
  const r = rodarScript(c);
  assert.equal(r.status, 1);
  assert.equal(fs.existsSync(c.rodou), true);
  assert.equal(lerRelatos(c)[0].resultado, 'falhou');
  assert.equal(fs.existsSync(path.join(c.pasta, 'atualizando.json')), true);
});

test('script (vigia): espera o instalador da atualização terminar e não mexe se deu certo', { skip: SEM_PWSH_POSIX }, async () => {
  const c = montarCenario({ comMarcador: true });
  // Processo com o mesmo nome do desinstalador temporário do NSIS, que
  // "termina a atualização" (cria o .exe) depois de alguns segundos.
  const falso = path.join(c.raiz, 'old-uninstaller');
  fs.copyFileSync('/bin/sh', falso);
  fs.chmodSync(falso, 0o755);
  const atualizacao = spawn(falso, ['-c', `sleep 6; mkdir -p '${path.dirname(c.asar)}'; : > '${c.exe}'; : > '${c.asar}'`], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const inicio = Date.now();
  const r = await new Promise((resolve) => {
    // Espera inicial curta: sem reconhecer o instalador rodando, o script
    // acharia o .exe faltando e reinstalaria por cima da atualização.
    const p = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-File', c.script, '-Modo', 'Vigiar', '-EsperaInicialSegundos', '1'], { stdio: 'pipe' });
    let saida = '';
    p.stdout.on('data', (d) => { saida += d; });
    p.stderr.on('data', (d) => { saida += d; });
    p.on('close', (status) => resolve({ status, saida }));
  });
  atualizacao.kill();
  assert.equal(r.status, 0, r.saida);
  assert.ok(Date.now() - inicio >= 4000, 'deveria ter esperado o instalador');
  assert.equal(fs.existsSync(c.rodou), false); // não reinstalou por cima de uma atualização que deu certo
  assert.equal(fs.existsSync(path.join(c.pasta, 'atualizando.json')), false);
});

test('script: duas cópias ao mesmo tempo -> só uma age', { skip: SEM_PWSH_POSIX }, async () => {
  const c = montarCenario({ comMarcador: true });
  const roda = () => new Promise((resolve) => {
    const p = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-File', c.script, '-Modo', 'Logon'], { stdio: 'ignore' });
    p.on('close', resolve);
  });
  const codigos = await Promise.all([roda(), roda()]);
  assert.deepEqual(codigos.sort(), [0, 0]);
  assert.equal(lerRelatos(c).length, 1);
});

// ---------------------------------------------------------------------
// Instalador da versão atual baixado da release (com sha512 conferido)
// ---------------------------------------------------------------------

test('lerPublishDoApp lê dono/repositório do app-update.yml do app instalado', () => {
  const dir = pastaTemp('reparo-appupdate');
  fs.writeFileSync(path.join(dir, 'app-update.yml'), 'owner: arthuraf2013-hue\nrepo: gerenciaai-releases\nprovider: github\nreleaseType: release\nupdaterCacheDirName: gerenciaai-updater\n');
  assert.deepEqual(reparo.lerPublishDoApp(dir), { owner: 'arthuraf2013-hue', repo: 'gerenciaai-releases' });
  assert.equal(reparo.lerPublishDoApp(path.join(dir, 'nao-existe')), null);
});

function releaseFalsa({ versao = '1.0.4', conteudo = 'instalador de verdade', shaDeclarado } = {}) {
  const sha = shaDeclarado || require('crypto').createHash('sha512').update(conteudo).digest('base64');
  const yml = `version: ${versao}\nfiles:\n  - url: GerenciaAI-Setup-${versao}.exe\n    sha512: ${sha}\npath: GerenciaAI-Setup-${versao}.exe\nsha512: ${sha}\nreleaseDate: '2026-10-19T16:01:23.260Z'\n`;
  const pedidos = [];
  const buscar = async (url) => {
    pedidos.push(url);
    if (url.endsWith('/latest.yml')) return new Response(yml);
    if (url.endsWith(`/GerenciaAI-Setup-${versao}.exe`)) return new Response(conteudo);
    return new Response('nao achou', { status: 404 });
  };
  return { buscar, pedidos };
}
const PUBLISH = { owner: 'arthuraf2013-hue', repo: 'gerenciaai-releases' };

test('baixa o instalador da release da versão em uso e confere o sha512', async () => {
  const pasta = pastaTemp('reparo-release');
  const { buscar, pedidos } = releaseFalsa();
  const env = { GERENCIAAI_REPARO_DIR: pasta };
  assert.equal(await reparo.garantirInstaladorDaVersaoAtual({ versaoAtual: '1.0.4', publish: PUBLISH, env, buscar }), 'baixado');
  assert.equal(pedidos[0], 'https://github.com/arthuraf2013-hue/gerenciaai-releases/releases/download/v1.0.4/latest.yml');
  assert.equal(fs.readFileSync(path.join(pasta, reparo.NOME_INSTALADOR), 'utf-8'), 'instalador de verdade');
  assert.equal(JSON.parse(fs.readFileSync(path.join(pasta, 'instalador.json'), 'utf-8')).versao, '1.0.4');
  // Já tem: não baixa de novo.
  assert.equal(await reparo.garantirInstaladorDaVersaoAtual({ versaoAtual: '1.0.4', publish: PUBLISH, env, buscar }), 'ja_tem');
  assert.equal(pedidos.length, 2);
});

test('sha512 diferente: descarta o download e não guarda nada', async () => {
  const pasta = pastaTemp('reparo-release-sha');
  const { buscar } = releaseFalsa({ shaDeclarado: 'outro-hash==' });
  assert.equal(await reparo.garantirInstaladorDaVersaoAtual({ versaoAtual: '1.0.4', publish: PUBLISH, env: { GERENCIAAI_REPARO_DIR: pasta }, buscar }), 'sha_diferente');
  assert.deepEqual(fs.readdirSync(pasta), []);
});

test('latest.yml de outra versão ou release inexistente: não guarda nada', async () => {
  const pasta = pastaTemp('reparo-release-outra');
  const env = { GERENCIAAI_REPARO_DIR: pasta };
  assert.equal(await reparo.garantirInstaladorDaVersaoAtual({ versaoAtual: '1.0.5', publish: PUBLISH, env, buscar: releaseFalsa({ versao: '1.0.4' }).buscar }), 'latest_invalido');
  assert.equal(await reparo.garantirInstaladorDaVersaoAtual({ versaoAtual: '1.0.5', publish: PUBLISH, env, buscar: async () => new Response('', { status: 404 }) }), 'sem_release');
  assert.equal(await reparo.garantirInstaladorDaVersaoAtual({ versaoAtual: '1.0.5', publish: null, env, buscar: async () => { throw new Error('não devia buscar'); } }), 'sem_config');
  assert.equal(fs.existsSync(path.join(pasta, reparo.NOME_INSTALADOR)), false);
});

test('instalador guardado mais velho que a versão em uso é trocado pelo da release', async () => {
  const pasta = pastaTemp('reparo-release-velho');
  const env = { GERENCIAAI_REPARO_DIR: pasta };
  fs.writeFileSync(path.join(pasta, reparo.NOME_INSTALADOR), 'velho');
  fs.writeFileSync(path.join(pasta, 'instalador.json'), JSON.stringify({ versao: '1.0.3' }));
  assert.equal(await reparo.garantirInstaladorDaVersaoAtual({ versaoAtual: '1.0.4', publish: PUBLISH, env, buscar: releaseFalsa().buscar }), 'baixado');
  assert.equal(fs.readFileSync(path.join(pasta, reparo.NOME_INSTALADOR), 'utf-8'), 'instalador de verdade');
});
