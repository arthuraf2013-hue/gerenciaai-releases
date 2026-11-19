const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../electron/services/nuvemDisjuntorService');

const iso = (ms) => new Date(ms).toISOString();

test('cota do Firestore renova à meia-noite do Pacífico (com horário de verão)', () => {
  assert.equal(iso(d.proximoResetDaCota(Date.parse('2026-11-19T00:58:00Z'))), '2026-11-19T08:00:00.000Z', 'nov: 05:00 em Brasília');
  assert.equal(iso(d.proximoResetDaCota(Date.parse('2026-11-19T08:00:00Z'))), '2026-11-20T08:00:00.000Z', 'na hora exata já é o dia seguinte');
  assert.equal(iso(d.proximoResetDaCota(Date.parse('2026-07-01T12:00:00Z'))), '2026-07-02T07:00:00.000Z', 'jul: 04:00 em Brasília');
  assert.equal(iso(d.proximoResetDaCota(Date.parse('2026-03-07T12:00:00Z'))), '2026-03-08T08:00:00.000Z', 'véspera da entrada do horário de verão');
  assert.equal(iso(d.proximoResetDaCota(Date.parse('2026-10-31T12:00:00Z'))), '2026-11-01T07:00:00.000Z', 'véspera da saída do horário de verão');
});

test('reconhece o erro de cota no texto do SDK e da REST', () => {
  assert.equal(d.ehErroDeCota("GrpcConnection RPC 'Write' stream 0x2f error. Code: 8 Message: 8 RESOURCE_EXHAUSTED: Quota exceeded."), true);
  assert.equal(d.ehErroDeCota('[code=resource-exhausted]: Quota exceeded.'), true);
  assert.equal(d.ehErroDeCota('Missing or insufficient permissions.'), false);
  assert.equal(d.ehErroDeCota(null), false);
});

test('sem cota: pausa as escritas até a renovação, sonda a cada 10 min, volta sozinho', () => {
  d._zerarParaTeste();
  const t0 = Date.parse('2026-11-18T13:10:00Z');
  assert.equal(d.podeEscrever('ping', 1, t0), true);
  d.registrarFaltaDeCota({ tipo: 'escrita', agoraMs: t0 });
  assert.equal(d.podeEscrever('ping', 1, t0 + 1000), false);
  assert.equal(d.status(t0 + 1000).escritaPausada, true);
  assert.equal(d.status(t0 + 1000).escritaVoltaEm, '2026-11-19T08:00:00.000Z');
  assert.equal(d.deveSondar(t0 + 60 * 1000), false, 'acabou de descobrir: não sonda logo');
  assert.equal(d.deveSondar(t0 + d.SONDA_MS), true, 'depois de 10 min, uma sonda');
  assert.equal(d.deveSondar(t0 + d.SONDA_MS + 1000), false, 'só uma por janela');
  assert.equal(d.podeLer(t0 + 1000), true, 'leitura tem cota separada');
  // passou da renovação
  assert.equal(d.podeEscrever('ping', 1, Date.parse('2026-11-19T08:00:01Z')), true);
  assert.equal(d.status(Date.parse('2026-11-19T08:00:01Z')).escritaPausada, false);
});

test('sonda que passou (ex.: plano pago ligado) libera na hora', () => {
  d._zerarParaTeste();
  const t0 = Date.parse('2026-11-18T13:10:00Z');
  d.registrarFaltaDeCota({ tipo: 'escrita', agoraMs: t0 });
  assert.equal(d.podeEscrever(null, 1, t0 + 5000), false);
  d.registrarEscritaOk();
  assert.equal(d.podeEscrever(null, 1, t0 + 6000), true);
});

test('conta as escritas do dia por origem e zera na virada da cota', () => {
  d._zerarParaTeste();
  const t0 = Date.parse('2026-11-18T13:10:00Z');
  d.podeEscrever('statusAoVivo', 1, t0);
  d.podeEscrever('statusAoVivo', 1, t0 + 1);
  d.podeEscrever('historicoGrupo', 400, t0 + 2);
  d.contar('ping', 1, t0 + 3);
  assert.deepEqual(d.escritasDeHoje(t0 + 4), { statusAoVivo: 2, historicoGrupo: 400, ping: 1 });
  assert.deepEqual(d.escritasDeHoje(Date.parse('2026-11-19T08:00:01Z')), {}, 'dia novo da cota');
});

test('comPrazo: devolve o resultado, ou desiste no prazo sem travar quem chamou', async () => {
  assert.equal(await d.comPrazo(Promise.resolve(7), 50), 7);
  const vivo = setInterval(() => {}, 1000); // o relógio do prazo é unref (não segura o app aberto)
  try {
    const parada = new Promise(() => {});
    await assert.rejects(d.comPrazo(parada, 30, 'ping'), (e) => e.code === 'prazo-esgotado');
  } finally {
    clearInterval(vivo);
  }
});
