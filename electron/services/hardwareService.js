const os = require('os');

/**
 * Perfil de hardware desta máquina -- decide o "modo leve" automático
 * (máquinas de entrada: Celeron/Pentium/Atom, 4 GB de RAM ou menos, 2
 * núcleos). O modo leve NUNCA desliga funcionalidade nenhuma: só ajusta
 * custo de coisas que o operador não vê (memória do cache do SQLite,
 * quando as tarefas de segundo plano começam depois de abrir o app,
 * animações da interface).
 *
 * Preferência manual (Configurações → Geral → Desempenho) é guardada
 * pelo renderer em localStorage e só afeta a interface; o lado do
 * processo principal usa sempre a detecção automática -- é ela que
 * decide quanta memória o banco pode usar, e isso não deveria depender
 * de alguém lembrar de marcar uma opção.
 */

const GB = 1024 ** 3;

function getPerfil() {
  const memoriaTotalGb = os.totalmem() / GB;
  const nucleos = os.cpus()?.length || 1;
  const cpuModelo = os.cpus()?.[0]?.model?.trim() || 'desconhecido';
  // 4.6 em vez de 4.0: máquina "de 4 GB" reporta um pouco menos (memória
  // reservada pro vídeo integrado) ou um pouco mais (arredondamento).
  const pouca_memoria = memoriaTotalGb <= 4.6;
  const poucos_nucleos = nucleos <= 2;
  const cpuDeEntrada = /celeron|pentium|atom|athlon|sempron|n4\d{3}|n5\d{3}|j\d{4}/i.test(cpuModelo);
  return {
    memoriaTotalGb: Math.round(memoriaTotalGb * 10) / 10,
    nucleos,
    cpuModelo,
    modoLeveAutomatico: pouca_memoria || poucos_nucleos || (cpuDeEntrada && memoriaTotalGb <= 8),
  };
}

let cache = null;
function perfil() {
  if (!cache) cache = getPerfil();
  return cache;
}

function modoLeve() {
  return perfil().modoLeveAutomatico;
}

module.exports = { perfil, modoLeve, getPerfil };
