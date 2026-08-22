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

/**
 * Converte um intervalo de datas "locais" (Brasil, UTC-3 fixo — sem
 * horário de verão desde 2019, mesmo offset fixo que todo SQL deste app
 * já usava via `date(col, '-3 hours')`) em limites UTC sargable, pra
 * filtrar colunas tipo `criado_em`/`finalizada_em` (sempre gravadas em
 * UTC, formato "YYYY-MM-DD HH:MM:SS", ver nowSyncedUTCString acima).
 *
 * Existia um padrão espalhado por vários services (dashboard, caixa,
 * relatórios, NFC-e, histórico de vendas...):
 *   WHERE date(criado_em, '-3 hours') BETWEEN date(?) AND date(?)
 * Isso dá o resultado certo, mas embrulha a COLUNA numa função — o
 * SQLite não consegue usar nenhum índice em criado_em pra esse filtro,
 * e escaneia a tabela inteira toda vez, mesmo pedindo só "hoje". Numa
 * tabela que só cresce (sales, audit_log, stock_movements nunca têm
 * linha apagada), isso fica mais lento a cada ano de uso.
 *
 * A troca: em vez de converter a COLUNA pra comparar com a data local,
 * converte o INTERVALO pedido (só duas strings, calculado uma vez) pros
 * limites UTC equivalentes — o filtro vira uma comparação direta
 * (`criado_em >= inicioUtc AND criado_em < fimUtcExclusivo`), sargable,
 * que usa o índice normalmente.
 *
 * @param {string} dataInicio "YYYY-MM-DD" (data local, inclusiva)
 * @param {string} dataFim "YYYY-MM-DD" (data local, inclusiva)
 * @returns {{inicioUtc: string, fimUtcExclusivo: string}} use como
 *   `criado_em >= inicioUtc AND criado_em < fimUtcExclusivo`
 */
function localDateRangeToUtcBounds(dataInicio, dataFim) {
  const inicioUtc = `${dataInicio} 03:00:00`;
  const [ano, mes, dia] = dataFim.split('-').map(Number);
  // Date.UTC normaliza sozinho a virada de mês/ano (dia+1 no dia 31 vira
  // dia 1 do mês seguinte, 31/12 vira 01/01 do ano seguinte, etc.) --
  // não precisa de lógica de calendário manual aqui.
  const proximoDia = new Date(Date.UTC(ano, mes - 1, dia + 1));
  const fimUtcExclusivo = `${proximoDia.toISOString().slice(0, 10)} 03:00:00`;
  return { inicioUtc, fimUtcExclusivo };
}

/**
 * Mesma ideia de localDateRangeToUtcBounds, mas SEM o deslocamento de
 * -3h — pra deixar sargable um filtro que já usava `date(col) BETWEEN
 * date(?) AND date(?)` (sem `'-3 hours'`) tal como estava, sem mudar o
 * resultado. Existem poucos lugares assim (ex: fechamento de caixa em
 * cashService.js) — não é necessariamente "certo" ignorar o fuso, mas
 * não é este ajuste de performance que deve mudar esse comportamento
 * por conta própria, então preserva exatamente o que já fazia.
 */
function utcDateRangeToBounds(dataInicio, dataFim) {
  const inicioUtc = `${dataInicio} 00:00:00`;
  const [ano, mes, dia] = dataFim.split('-').map(Number);
  const proximoDia = new Date(Date.UTC(ano, mes - 1, dia + 1));
  const fimUtcExclusivo = `${proximoDia.toISOString().slice(0, 10)} 00:00:00`;
  return { inicioUtc, fimUtcExclusivo };
}

/** "Agora" no fuso de São Paulo, no formato 'YYYY-MM-DD HH:MM:SS' -- o
 * mesmo formato usado por appointments.data_hora_inicio e
 * reservations.data_hora (hora local, não UTC). Usado pelo poller de
 * lembrete de reserva em main.js pra comparar com data_hora sem precisar
 * fazer a conta de fuso manualmente em cada lugar. */
function agoraLocalString() {
  const now = new Date(nowMs());
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return `${dateFmt.format(now)} ${timeFmt.format(now)}`;
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

module.exports = {
  syncNow, nowMs, nowSyncedUTCString, getBrasiliaNowParts, hojeLocalISO, diasAPartirDeHojeLocalISO,
  agoraLocalString, getStatus, startAutoSync, localDateRangeToUtcBounds, utcDateRangeToBounds,
};
