/**
 * Sinal simples de "conseguimos falar com o Firestore agora?" — não é
 * `navigator.onLine` (isso só diz se a placa de rede está ligada, não se
 * o servidor responde; dá pra estar "online" numa rede sem internet de
 * verdade, ou atrás de algo que bloqueia especificamente o Firestore).
 *
 * Em vez de um teste de conectividade dedicado (mais uma chamada de rede
 * só pra isso, rodando toda hora mesmo sem nenhuma venda acontecendo),
 * reaproveita o resultado das chamadas que a própria instalação já faz:
 * o ping de presença (a cada 2 min — ver licenseService.enviarPing) e,
 * bem mais frequente numa loja vendendo ativamente, cada tentativa de
 * confirmar estoque do grupo (ver
 * stockSyncService.verificarEDebitarEstoqueRemoto).
 *
 * Estado só em memória, de propósito — não precisa sobreviver a reinício
 * do app (a próxima tentativa, segundos depois de abrir, já atualiza
 * sozinha) e evita gravar no SQLite a cada mudança de sinal.
 */
let online = true; // otimista até a primeira tentativa dizer o contrário —
// evita mostrar "offline" por 1-2s só porque o app ainda não teve chance
// de tentar nada.
let ultimaAtualizacao = null;

function marcarOnline() {
  online = true;
  ultimaAtualizacao = new Date().toISOString();
}

function marcarOffline() {
  online = false;
  ultimaAtualizacao = new Date().toISOString();
}

function getStatus() {
  return { online, ultimaAtualizacao };
}

module.exports = { marcarOnline, marcarOffline, getStatus };
