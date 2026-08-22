const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const timeService = require('../electron/services/timeService');

test('localDateRangeToUtcBounds — dia único, dentro do mesmo mês', () => {
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds('2026-08-22', '2026-08-22');
  assert.equal(inicioUtc, '2026-08-22 03:00:00');
  assert.equal(fimUtcExclusivo, '2026-08-23 03:00:00');
});

test('localDateRangeToUtcBounds — intervalo de vários dias', () => {
  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds('2026-08-01', '2026-08-22');
  assert.equal(inicioUtc, '2026-08-01 03:00:00');
  assert.equal(fimUtcExclusivo, '2026-08-23 03:00:00');
});

test('localDateRangeToUtcBounds — virada de mês (dia 31 -> mês seguinte)', () => {
  const { fimUtcExclusivo } = timeService.localDateRangeToUtcBounds('2026-01-01', '2026-01-31');
  assert.equal(fimUtcExclusivo, '2026-02-01 03:00:00');
});

test('localDateRangeToUtcBounds — virada de ano (31/12 -> 01/01 do ano seguinte)', () => {
  const { fimUtcExclusivo } = timeService.localDateRangeToUtcBounds('2026-12-01', '2026-12-31');
  assert.equal(fimUtcExclusivo, '2027-01-01 03:00:00');
});

test('localDateRangeToUtcBounds — fevereiro de ano bissexto (29 dias)', () => {
  const { fimUtcExclusivo } = timeService.localDateRangeToUtcBounds('2024-02-01', '2024-02-29');
  assert.equal(fimUtcExclusivo, '2024-03-01 03:00:00');
});

test('localDateRangeToUtcBounds — fevereiro de ano NÃO bissexto (28 dias)', () => {
  const { fimUtcExclusivo } = timeService.localDateRangeToUtcBounds('2026-02-01', '2026-02-28');
  assert.equal(fimUtcExclusivo, '2026-03-01 03:00:00');
});

/**
 * Verificação mais forte: confirma que o filtro sargable novo
 * (`criado_em >= inicioUtc AND criado_em < fimUtcExclusivo`) seleciona
 * EXATAMENTE as mesmas linhas que o padrão antigo
 * (`date(criado_em, '-3 hours') BETWEEN date(?) AND date(?)`) pra uma
 * bateria de timestamps em cima de cada fronteira de dia local possível
 * -- é essa equivalência que garante que trocar o padrão em
 * dashboardService/saleService/etc não muda nenhum resultado de
 * relatório, só a velocidade da consulta.
 */
test('localDateRangeToUtcBounds — filtro sargable bate exatamente com o padrão antigo date(col,"-3 hours") BETWEEN', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE eventos (id INTEGER PRIMARY KEY, criado_em TEXT)');

  // Uma bateria de timestamps UTC cobrindo as fronteiras críticas do dia
  // local (que em UTC-3 cai às 03:00 UTC): logo antes, exatamente em
  // cima, e logo depois -- tanto no início quanto no fim do intervalo
  // pedido, incluindo virada de mês. Lembrando: local = UTC - 3h.
  const timestamps = [
    '2026-07-31 02:59:59', // = 30/07 23:59:59 local -- fora (dia anterior ao início)
    '2026-07-31 03:00:00', // = 31/07 00:00:00 local -- dentro (1º instante do início)
    '2026-08-15 12:00:00', // meio do intervalo -- dentro
    '2026-09-01 02:59:59', // = 31/08 23:59:59 local -- dentro (último instante do fim)
    '2026-09-01 03:00:00', // = 01/09 00:00:00 local -- fora (dia seguinte ao fim)
  ];
  const insert = db.prepare('INSERT INTO eventos (criado_em) VALUES (?)');
  timestamps.forEach((ts) => insert.run(ts));

  const dataInicio = '2026-07-31';
  const dataFim = '2026-08-31';

  const antigo = db.prepare(
    `SELECT criado_em FROM eventos WHERE date(criado_em, '-3 hours') BETWEEN date(?) AND date(?) ORDER BY criado_em`
  ).all(dataInicio, dataFim).map((r) => r.criado_em);

  const { inicioUtc, fimUtcExclusivo } = timeService.localDateRangeToUtcBounds(dataInicio, dataFim);
  const novo = db.prepare(
    `SELECT criado_em FROM eventos WHERE criado_em >= ? AND criado_em < ? ORDER BY criado_em`
  ).all(inicioUtc, fimUtcExclusivo).map((r) => r.criado_em);

  assert.deepEqual(novo, antigo);
  assert.deepEqual(novo, ['2026-07-31 03:00:00', '2026-08-15 12:00:00', '2026-09-01 02:59:59']);

  db.close();
});
