const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb } = require('./helpers/testDb');
const teste = require('../electron/services/testeGratisService');
const licenseService = require('../electron/services/licenseService');

// aplicarDadosDoServidor também repassa o documento a outros serviços
// (mensagem, grupo, módulos pagos, atualização, backup) -- alguns abrem
// escuta no Firestore e seguram o processo do teste. Aqui só interessa o
// teste grátis: troca esses repasses por funções vazias.
for (const [modulo, funcoes] of Object.entries({
  messageService: ['aplicarMensagemDaInstalacao'],
  syncStateService: ['aplicarGrupoDaInstalacao'],
  modulosPagosService: ['aplicarClienteIdDaInstalacao'],
  updateService: ['aplicarOverrideDaInstalacao', 'aplicarControleDaInstalacao'],
  backupService: ['restaurarSolicitadoSeHouver', 'executarBackupRemotoSeSolicitado'],
})) {
  try {
    const m = require(`../electron/services/${modulo}`);
    for (const f of funcoes) m[f] = () => Promise.resolve();
  } catch { /* módulo que nem carrega fora do Electron: o repasse já falha em silêncio */ }
}

const DIA = 86400000;
const ts = (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) });

function estado(db) {
  return db.prepare('SELECT * FROM license_state WHERE id = 1').get();
}

test('fim do teste: criadoEm do servidor + dias; testeAte da Central tem prioridade; cliente vinculado não tem prazo', () => {
  const criado = Date.UTC(2026, 9, 1);
  assert.equal(teste.fimDoTeste({ teste: { dias: 14 }, criadoEm: ts(criado) }), criado + 14 * DIA);
  assert.equal(teste.fimDoTeste({ teste: { dias: 14 }, criadoEm: ts(criado), testeAte: ts(criado + 30 * DIA) }), criado + 30 * DIA);
  assert.equal(teste.fimDoTeste({ teste: { dias: 14 }, criadoEm: ts(criado), clienteId: 'c1' }), null);
  // instalação antiga (sem `teste`) e documento ainda sem criadoEm do servidor
  assert.equal(teste.fimDoTeste({ criadoEm: ts(criado) }), null);
  assert.equal(teste.fimDoTeste({ teste: { dias: 14 }, criadoEm: null }), null);
  assert.equal(teste.fimDoTeste({ teste: { dias: 'muitos' }, criadoEm: ts(criado) }), null);
});

test('situação: dias restantes arredondam pra cima; no fim, expirado', () => {
  const fim = Date.UTC(2026, 9, 15);
  assert.deepEqual(teste.situacao(fim, fim - 30 * 3600000), { expirado: false, diasRestantes: 2, fimEm: new Date(fim).toISOString() });
  assert.equal(teste.situacao(fim, fim).expirado, true);
  assert.equal(teste.situacao(null, fim), null);
});

test('link de WhatsApp: número brasileiro ganha 55; lixo não vira link', () => {
  assert.equal(teste.linkWhatsapp('(81) 99999-1234', 'oi'), 'https://wa.me/5581999991234?text=oi');
  assert.equal(teste.linkWhatsapp('5581999991234'), 'https://wa.me/5581999991234');
  assert.equal(teste.linkWhatsapp('123'), null);
});

test('instalação nova em teste: app libera com aviso e bloqueia quando acaba (relógio sincronizado)', () => {
  const { db } = freshTestDb();
  const timeService = require('../electron/services/timeService');
  const original = timeService.nowMs;
  try {
    const agora = Date.UTC(2026, 9, 10, 12);
    timeService.nowMs = () => agora;
    licenseService.aplicarDadosDoServidor({ ativo: true, teste: { dias: 14 }, criadoEm: ts(agora - 12 * DIA) });
    const r = licenseService.computeAccessStatus();
    assert.equal(r.status, 'ok');
    assert.equal(r.teste.diasRestantes, 2);

    timeService.nowMs = () => agora + 3 * DIA;
    const fim = licenseService.computeAccessStatus();
    assert.equal(fim.status, 'bloqueado');
    assert.equal(fim.motivo, 'teste_expirado');

    // Central estende (testeAte) -> volta a funcionar
    licenseService.aplicarDadosDoServidor({ ativo: true, teste: { dias: 14 }, criadoEm: ts(agora - 12 * DIA), testeAte: ts(agora + 10 * DIA) });
    assert.equal(licenseService.computeAccessStatus().status, 'ok');

    // Central converte (vincula a um cliente) -> sem prazo nenhum
    licenseService.aplicarDadosDoServidor({ ativo: true, teste: { dias: 14 }, criadoEm: ts(agora - 40 * DIA), clienteId: 'c1' });
    assert.equal(estado(db).teste_fim, null);
    const conv = licenseService.computeAccessStatus();
    assert.equal(conv.status, 'ok');
    assert.equal(conv.teste, undefined);
  } finally {
    timeService.nowMs = original;
  }
});

test('instalação antiga (documento sem teste) nunca entra em teste', () => {
  const { db } = freshTestDb();
  licenseService.aplicarDadosDoServidor({ ativo: true, criadoEm: ts(Date.UTC(2025, 0, 1)) });
  assert.equal(estado(db).teste_fim, null);
  assert.deepEqual(licenseService.computeAccessStatus(), { status: 'ok' });
});

test('documento parcial (criadoEm ainda pendente) não apaga um fim de teste já conhecido', () => {
  const { db } = freshTestDb();
  const criado = Date.now() - DIA;
  licenseService.aplicarDadosDoServidor({ ativo: true, teste: { dias: 14 }, criadoEm: ts(criado) });
  const fim = estado(db).teste_fim;
  assert.ok(fim);
  licenseService.aplicarDadosDoServidor({ ativo: true, teste: { dias: 14 }, criadoEm: null });
  assert.equal(estado(db).teste_fim, fim);
});

test('contato comercial guardado aparece no bloqueio com link de WhatsApp', () => {
  const { db } = freshTestDb();
  licenseService.computeAccessStatus(); // cria a linha
  db.prepare(`UPDATE license_state SET teste_fim = ?, contato_comercial = ? WHERE id = 1`)
    .run(new Date(Date.now() - DIA).toISOString(), JSON.stringify({ whatsapp: '81999991234', mensagem: 'Fale comigo', empresa: 'Vetta Sistemas' }));
  const r = licenseService.computeAccessStatus();
  assert.equal(r.motivo, 'teste_expirado');
  assert.equal(r.contato.empresa, 'Vetta Sistemas');
  assert.match(r.contato.link, /^https:\/\/wa\.me\/5581999991234\?text=/);
});

test('instalação nova que NUNCA falou com o servidor é bloqueada depois de 14 dias; antiga sem a marca, não', () => {
  const { db } = freshTestDb();
  licenseService.computeAccessStatus(); // cria a linha com primeira_execucao = agora
  assert.ok(estado(db).primeira_execucao);
  assert.equal(licenseService.computeAccessStatus().status, 'ok');
  db.prepare(`UPDATE license_state SET primeira_execucao = ? WHERE id = 1`).run(new Date(Date.now() - 15 * DIA).toISOString());
  assert.deepEqual(licenseService.computeAccessStatus(), { status: 'bloqueado', motivo: 'sem_internet' });
  // linha antiga (sem primeira_execucao), mesmo sem contato: continua como antes
  db.prepare(`UPDATE license_state SET primeira_execucao = NULL WHERE id = 1`).run();
  assert.equal(licenseService.computeAccessStatus().status, 'ok');
});
