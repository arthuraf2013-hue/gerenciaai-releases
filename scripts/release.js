#!/usr/bin/env node
/**
 * Publica as alterações locais já pensando na situação que sempre dava
 * "! [rejected] ... (fetch first)": o robô de release do GitHub Actions
 * (auto-version.yml) costuma empurrar um commit "chore(release): vX.Y.Z"
 * pro main pouco depois de cada push nosso, então entre a hora que a
 * gente termina de editar e a hora que roda `git push`, o remoto já
 * pode ter avançado. Esse script sempre commita, PUXA o remoto antes de
 * empurrar, e garante um commit final com prefixo "release:" (mesmo que
 * o merge do pull tenha criado um commit de mesclagem sem esse prefixo,
 * que o auto-version.yml ignora) -- daí sim empurra.
 *
 * Uso:
 *   npm run release -- "descrição curta do que mudou"
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Remove um `.git/index.lock` (ou `HEAD.lock`) travado ANTES de rodar
 * qualquer comando git -- sem isso, um lock deixado por uma queda de
 * energia, um antivírus que travou no meio de uma escrita, ou um
 * `git status`/editor mexendo no repo bem na hora, faz TODO comando
 * seguinte falhar com "Unable to create '.../index.lock': File
 * exists.", mesmo não tendo mais nenhum processo git de verdade rodando.
 * Só remove se o arquivo já existir há mais de alguns segundos -- um
 * lock criado agora mesmo pode ser de um `git` genuinamente em
 * andamento (outra janela, outro comando disparado ao mesmo tempo), e
 * apagar esse na certa corromperia a operação em curso. Silencioso por
 * padrão (não é erro do usuário), só avisa quando de fato remove algo.
 */
function limparLockTravado() {
  const SEGUNDOS_PARA_CONSIDERAR_TRAVADO = 10;
  for (const nomeArquivo of ['index.lock', 'HEAD.lock']) {
    const caminho = path.join('.git', nomeArquivo);
    try {
      const info = fs.statSync(caminho);
      const idadeSegundos = (Date.now() - info.mtimeMs) / 1000;
      if (idadeSegundos > SEGUNDOS_PARA_CONSIDERAR_TRAVADO) {
        fs.unlinkSync(caminho);
        console.log(`(removido ${caminho} travado há ${Math.round(idadeSegundos)}s -- provavelmente sobra de uma operação anterior interrompida)`);
      }
    } catch {
      // Não existe (caso normal) ou não deu pra remover -- segue o jogo,
      // o comando git logo abaixo vai dar o erro de verdade se for o caso.
    }
  }
}

const mensagem = process.argv.slice(2).join(' ').trim();
if (!mensagem) {
  console.error('Uso: npm run release -- "descrição curta do que mudou"');
  process.exit(1);
}
const commitMsg = (/^release:/i.test(mensagem) ? mensagem : `release: ${mensagem}`).replace(/"/g, '\\"');

function run(cmd, { permitirFalha = false } = {}) {
  limparLockTravado();
  console.log(`\n$ ${cmd}`);
  try {
    const saida = execSync(cmd, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
    if (saida && saida.trim()) console.log(saida.trim());
    return { ok: true, saida: saida || '' };
  } catch (err) {
    const saida = `${err.stdout || ''}${err.stderr || ''}`;
    if (saida.trim()) console.log(saida.trim());
    if (!permitirFalha) console.error(`\n✗ Comando falhou: ${cmd}`);
    return { ok: false, saida, err };
  }
}

console.log('== Publicando alterações no GerenciaAI ==');

run('git add -A');

const commit1 = run(`git commit -m "${commitMsg}"`, { permitirFalha: true });
if (!commit1.ok && !/nothing to commit/i.test(commit1.saida)) {
  console.error('\nNão consegui commitar as alterações (motivo acima) -- resolva antes de continuar.');
  process.exit(1);
}

// --no-rebase deixa explícito que é merge (não rebase) mesmo que a
// máquina não tenha `pull.rebase` configurado globalmente -- sem isso,
// git recusa o pull com "Need to specify how to reconcile divergent
// branches" em vez de simplesmente mesclar.
const pull = run('git pull --no-edit --no-rebase', { permitirFalha: true });
if (!pull.ok) {
  if (/conflict/i.test(pull.saida) || /unmerged/i.test(pull.saida)) {
    console.error(
      '\n⚠ O "git pull" encontrou CONFLITO -- provavelmente em package.json/package-lock.json (o robô de release ' +
      'do GitHub também mexe nesses arquivos, geralmente só bumpando a versão). NÃO tente resolver às cegas: cole ' +
      'a saída acima pro Claude olhar, como das outras vezes. O merge fica pendente (git status mostra "unmerged ' +
      'paths"). Se quiser cancelar e tentar de novo depois: git merge --abort'
    );
  } else {
    console.error('\nNão consegui sincronizar com o GitHub ("git pull" falhou) -- veja a mensagem acima.');
  }
  process.exit(1);
}

// Garante que o ÚLTIMO commit antes do push comece com "release:" --
// mesmo que o pull acima tenha trazido só um merge automático (cuja
// mensagem não teria esse prefixo), esse commit vazio garante que o
// gatilho do auto-version.yml dispare desta vez.
run(`git commit --allow-empty -m "${commitMsg}"`);

const push = run('git push', { permitirFalha: true });
if (!push.ok) {
  console.error('\nAinda não consegui enviar pro GitHub ("git push" falhou de novo) -- veja a mensagem acima e me chama.');
  process.exit(1);
}

console.log('\n✓ Publicado! Acompanhe o build em: https://github.com/arthuraf2013-hue/gerenciaai-releases/actions');
