const https = require('https');

// Domínios grandes e estáveis — usamos só o cabeçalho HTTP "Date" da
// resposta, que todo servidor HTTPS envia. Evita depender de uma API de
// horário específica (que pode cair) ou de um formato de resposta frágil.
const HOSTS = ['www.google.com', 'www.cloudflare.com', 'www.microsoft.com'];

let offsetMs = 0; // diferença entre o horário real (internet) e o relógio do sistema
let lastSyncOk = false;
let lastSyncAt = null;

function fetchHttpDate(hostname) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, method: 'HEAD', path: '/', timeout: 5000 }, (res) => {
      const dateHeader = res.headers.date;
      if (!dateHeader) return reject(new Error('Resposta sem cabeçalho Date.'));
      const parsed = new Date(dateHeader).getTime();
      if (Number.isNaN(parsed)) return reject(new Error('Data inválida no cabeçalho.'));
      resolve(parsed);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/** Tenta sincronizar com o primeiro host que responder. Se todos falharem
 * (sem internet), mantém o offset anterior e marca como não sincronizado —
 * o app volta a usar o relógio do sistema puro, sem travar nada. */
async function syncNow() {
  for (const host of HOSTS) {
    try {
      const networkNow = await fetchHttpDate(host);
      offsetMs = networkNow - Date.now();
      lastSyncOk = true;
      lastSyncAt = new Date();
      return getStatus();
    } catch {
      // tenta o próximo host
    }
  }
  lastSyncOk = false;
  return getStatus();
}

function nowMs() {
  return Date.now() + offsetMs;
}

/** Formato idêntico ao datetime('now') do SQLite ("YYYY-MM-DD HH:MM:SS",
 * UTC) — é essa função que substitui datetime('now') em todo o schema, para
 * que todo registro do banco use o relógio sincronizado, não o do sistema. */
function nowSyncedUTCString() {
  return new Date(nowMs()).toISOString().slice(0, 19).replace('T', ' ');
}

/** Hora de Brasília formatada, para exibir no relógio da interface. */
function getBrasiliaNowParts() {
  const now = new Date(nowMs());
  const dateFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return { data: dateFmt.format(now), hora: timeFmt.format(now) };
}

/** "Hoje" no fuso de São Paulo, em formato YYYY-MM-DD — nunca UTC puro
 * (que já é "amanhã" das 21h à meia-noite locais). Pra comparações de
 * "já fiz isso hoje?" que precisam bater com o calendário do negócio,
 * não com o calendário UTC. */
function hojeLocalISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs()));
}

/** Mesma ideia de hojeLocalISO(), mas pra uma data N dias no futuro (ou
 * passado, com dias negativo) — pra prazos tipo "vence em até X dias",
 * sempre no calendário de Brasília, nunca UTC puro. */
function diasAPartirDeHojeLocalISO(dias) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs() + dias * 86400000));
}

function getStatus() {
  return {
    sincronizado: lastSyncOk,
    ultimaSincronizacao: lastSyncAt ? lastSyncAt.toISOString() : null,
    offsetMs,
    nowMs: nowMs(),
  };
}

function startAutoSync() {
  syncNow();
  setInterval(syncNow, 15 * 60 * 1000); // resincroniza a cada 15 minutos
}

module.exports = { syncNow, nowMs, nowSyncedUTCString, getBrasiliaNowParts, hojeLocalISO, diasAPartirDeHojeLocalISO, getStatus, startAutoSync };
