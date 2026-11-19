/**
 * Instância única que não deixa o app "preso" no Gerenciador de Tarefas.
 *
 * O Electron só deixa um GerenciaAI aberto por PC (requestSingleInstanceLock,
 * ver main.js). Quem abre de novo só pede para o que já está aberto mostrar a
 * janela e sai. O problema: se o aberto ficou sem janela (fechando e travou,
 * ou travou de vez), o pedido não dá em nada, o novo sai em silêncio e o app
 * simplesmente "não abre" até alguém finalizar a tarefa na mão.
 *
 * Quem tem a trava grava em userData/instancia.json o pid e uma "batida" a
 * cada 10 s. Quem não conseguiu a trava lê o arquivo: batida parada há tempo
 * demais = o processo está travado. Aí ele faz o que a pessoa fazia na mão:
 * encerra aquele processo (só se for mesmo o GerenciaAI) e abre de novo.
 *
 * O banco aguenta o encerramento forçado: o SQLite em WAL desfaz qualquer
 * transação pela metade na próxima abertura.
 */
const fs = require('fs');
const path = require('path');

const INTERVALO_BATIDA_MS = 10 * 1000;
// Quanto tempo sem batida conta como travado, por fase. Abrindo, o banco pode
// estar migrando (síncrono, sem batida): folga maior. Fechando, o próprio app
// se encerra à força em 10 s (ver main.js), então 20 s parado já é trava.
const LIMITE_SEM_BATIDA_MS = { iniciando: 3 * 60 * 1000, aberta: 60 * 1000, saindo: 20 * 1000 };

function arquivoDaInstancia(pastaUserData) {
  return path.join(pastaUserData, 'instancia.json');
}

function lerInstancia(arquivo) {
  try {
    const e = JSON.parse(fs.readFileSync(arquivo, 'utf-8'));
    return Number.isInteger(e?.pid) && e.pid > 0 ? e : null;
  } catch {
    return null;
  }
}

function gravar(arquivo, estado) {
  try {
    const tmp = `${arquivo}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(estado));
    fs.renameSync(tmp, arquivo);
  } catch (err) {
    console.error('[instância] não consegui gravar a batida:', err.message);
  }
}

/**
 * Decide o que a instância nova faz com a que tem a trava. Pura (para testar):
 * 'esperar' = deixa como está (ela vai mostrar a janela, ou já morreu e a
 * trava está livre); 'encerrar' = travada, pode encerrar.
 */
function decidir({ estado, agora, meuPid, vivo, mesmoApp }) {
  if (!estado || estado.pid === meuPid) return 'esperar';
  const limite = LIMITE_SEM_BATIDA_MS[estado.fase] ?? LIMITE_SEM_BATIDA_MS.aberta;
  const batida = Number(estado.batida) || 0;
  if (agora - batida <= limite) return 'esperar';
  if (!vivo(estado.pid)) return 'esperar';
  // pid reaproveitado pelo Windows por outro programa: nunca encerra.
  if (!mesmoApp(estado.pid)) return 'esperar';
  return 'encerrar';
}

function processoVivo(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** O pid é deste mesmo executável (GerenciaAI.exe)? Na dúvida, não. */
function mesmoExecutavel(pid, execPath) {
  if (process.platform !== 'win32') return false; // só no Windows encerramos sozinhos
  try {
    const saida = require('child_process').execFileSync(
      'tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf-8', timeout: 4000, windowsHide: true },
    );
    const nome = path.basename(execPath).toLowerCase();
    return saida.toLowerCase().includes(`"${nome}"`);
  } catch {
    return false;
  }
}

function esperarMorrer(pid, ateMs) {
  const fim = Date.now() + ateMs;
  const pausa = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < fim) {
    if (!processoVivo(pid)) return true;
    Atomics.wait(pausa, 0, 0, 100);
  }
  return !processoVivo(pid);
}

/**
 * Chamado por quem NÃO conseguiu a trava. Devolve true quando encerrou uma
 * instância travada (aí quem chamou deve reabrir o app: app.relaunch()).
 */
function destravarInstanciaPresa({ arquivo, execPath, agora = Date.now(), meuPid = process.pid }) {
  const estado = lerInstancia(arquivo);
  const decisao = decidir({
    estado, agora, meuPid,
    vivo: processoVivo,
    mesmoApp: (pid) => mesmoExecutavel(pid, execPath),
  });
  if (decisao !== 'encerrar') return false;
  console.error(`[instância] GerenciaAI anterior (pid ${estado.pid}) travado sem janela: encerrando para abrir de novo.`);
  try { process.kill(estado.pid); } catch { /* já saiu */ }
  esperarMorrer(estado.pid, 5000);
  return true;
}

/** Chamado por quem TEM a trava: grava já e segue batendo a cada 10 s. */
function iniciarBatimento({ arquivo, pid = process.pid }) {
  const estado = { pid, fase: 'iniciando', iniciadoEm: Date.now(), batida: Date.now() };
  const bater = () => { estado.batida = Date.now(); gravar(arquivo, estado); };
  bater();
  let timer = setInterval(bater, INTERVALO_BATIDA_MS);
  timer.unref?.();
  return {
    fase(nova) { estado.fase = nova; bater(); },
    /** Fechando: para de bater (se travar daqui em diante, a próxima abertura resolve). */
    saindo() {
      clearInterval(timer);
      timer = null;
      estado.fase = 'saindo';
      bater();
    },
  };
}

module.exports = {
  arquivoDaInstancia, lerInstancia, decidir, destravarInstanciaPresa, iniciarBatimento,
  processoVivo, mesmoExecutavel, LIMITE_SEM_BATIDA_MS, INTERVALO_BATIDA_MS,
};
