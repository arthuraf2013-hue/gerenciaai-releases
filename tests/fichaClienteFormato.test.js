// Formatação e período da Ficha do cliente (src/utils/fichaCliente.js, ESM do
// renderer): empacota com o esbuild do projeto para rodar aqui no node.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildSync } = require('esbuild');

const saida = buildSync({
  entryPoints: [path.join(__dirname, '../src/utils/fichaCliente.js')],
  bundle: true, format: 'cjs', platform: 'node', write: false,
});
const m = { exports: {} };
new Function('module', 'exports', 'require', saida.outputFiles[0].text)(m, m.exports, require);
const f = m.exports;

// 05/11/2026 (quinta-feira) 10:00 em São Paulo = 13:00 UTC.
const quinta = new Date(Date.UTC(2026, 10, 5, 13, 0, 0));

test('períodos iguais ao Histórico, no fuso de São Paulo', () => {
  assert.deepEqual(f.intervaloDoPeriodo('tudo', quinta), { dataInicio: '', dataFim: '' });
  assert.deepEqual(f.intervaloDoPeriodo('hoje', quinta), { dataInicio: '2026-11-05', dataFim: '2026-11-05' });
  assert.deepEqual(f.intervaloDoPeriodo('semana', quinta), { dataInicio: '2026-11-02', dataFim: '2026-11-05' }, 'semana começa na segunda');
  assert.deepEqual(f.intervaloDoPeriodo('mes', quinta), { dataInicio: '2026-11-01', dataFim: '2026-11-05' });
  assert.equal(f.intervaloDoPeriodo('personalizado', quinta), null, 'personalizado não mexe nas datas');
  // 23:30 de domingo em SP já é segunda em UTC: continua sendo domingo (semana de segunda 26/10).
  const domingoNoite = new Date(Date.UTC(2026, 10, 2, 2, 30, 0));
  assert.deepEqual(f.intervaloDoPeriodo('semana', domingoNoite), { dataInicio: '2026-10-26', dataFim: '2026-11-01' });
  assert.deepEqual(f.intervaloDoPeriodo('hoje', domingoNoite), { dataInicio: '2026-11-01', dataFim: '2026-11-01' });
});

test('datas e valores', () => {
  assert.equal(f.dataHora('2026-11-05 13:00:00'), '05/11/2026, 10:00');
  assert.equal(f.dataDoBanco('2026-11-01 02:30:00'), '31/10/2026', 'dia local, não o de UTC');
  assert.equal(f.dataCalendario('2026-03-09'), '09/03/2026');
  assert.equal(f.dataCalendario(null), '—');
  assert.equal(f.dataHora(null), '—');
  assert.match(f.moeda(1280), /R\$\s?1\.280,00/);
  assert.equal(f.quantidade(2), '2');
  assert.equal(f.quantidade(0.35, 'kg'), '0,35 kg');
});

test('especificações e receita', () => {
  assert.equal(f.valorDaEspecificacao({ tipo: 'boolean', valor: true }), 'Sim');
  assert.equal(f.valorDaEspecificacao({ tipo: 'data', valor: '2027-05-01' }), '01/05/2027');
  assert.equal(f.valorDaEspecificacao({ tipo: 'numero', valor: 12 }), '12');
  assert.equal(f.valorDaEspecificacao({ tipo: 'texto', valor: '-2,50' }), '-2,50');
  assert.equal(f.dioptria(-2.5), '-2,50');
  assert.equal(f.dioptria(1.25), '+1,25');
  assert.equal(f.dioptria(0), '0,00');
  assert.equal(f.dioptria(null), '—');
  assert.equal(f.eixo(90), '90°');
  assert.equal(f.eixo(null), '—');
});

test('receita que valia no dia da compra: a mais nova até aquele dia', () => {
  const receitas = [
    { id: 'b', dataReceita: '2026-09-15' }, { id: 'a', dataReceita: '2025-03-01' }, { id: 'x', dataReceita: null },
  ];
  assert.equal(f.receitaDaCompra(receitas, '2026-10-20 15:00:00').id, 'b');
  assert.equal(f.receitaDaCompra(receitas, '2026-09-15 12:00:00').id, 'b', 'no próprio dia já vale');
  assert.equal(f.receitaDaCompra(receitas, '2026-01-10 15:00:00').id, 'a');
  assert.equal(f.receitaDaCompra(receitas, '2024-01-10 15:00:00'), null);
  assert.equal(f.receitaDaCompra([], '2026-01-10 15:00:00'), null);
});

test('seções: as do perfil vêm antes das compras (mesmo vazias); as outras só com dado', () => {
  const base = { cliente: { telefone: '81999990000', saldoFiado: 0 }, receitas: [], pets: [], agenda: { proximos: [], historico: [] },
    reservas: [], orcamentos: [], preferencias: [], fiado: [], entregas: { lista: [] } };
  assert.deepEqual(f.secoesDaFicha({ ...base, perfil: { id: 'otica' } }), { antes: ['receitas'], depois: [] });
  assert.deepEqual(f.secoesDaFicha({ ...base, perfil: { id: 'petshop' } }), { antes: ['pets'], depois: [] });
  assert.deepEqual(f.secoesDaFicha({ ...base, perfil: { id: 'salao_beleza' } }), { antes: ['agenda'], depois: [] });
  assert.deepEqual(f.secoesDaFicha({ ...base, perfil: { id: 'material_construcao' } }), { antes: ['orcamentos'], depois: [] });
  assert.deepEqual(f.secoesDaFicha({ ...base, perfil: { id: 'vestuario' } }), { antes: ['preferencias'], depois: [] });
  assert.deepEqual(f.secoesDaFicha({ ...base, perfil: { id: 'restaurante' } }), { antes: ['reservas'], depois: [] });
  assert.deepEqual(f.secoesDaFicha({ ...base, perfil: { id: 'restaurante' }, cliente: { telefone: null } }), { antes: [], depois: [] },
    'sem telefone não dá para achar reserva: não mostra o bloco vazio');
  assert.deepEqual(f.secoesDaFicha({ ...base, perfil: { id: 'generico' } }), { antes: [], depois: [] });
  // Genérico com dados de outros blocos: aparecem depois das compras.
  const cheio = { ...base, perfil: { id: 'generico' }, cliente: { telefone: null, saldoFiado: 12 }, pets: [{}], entregas: { lista: [{}] }, orcamentos: [{}] };
  assert.deepEqual(f.secoesDaFicha(cheio), { antes: [], depois: ['pets', 'orcamentos', 'entregas', 'fiado'] });
  assert.deepEqual(f.secoesDaFicha(null), { antes: [], depois: [] });
});

test('hora local da agenda/reserva', () => {
  assert.equal(f.dataHoraLocal('2026-11-12 14:00:00'), '12/11/2026 14:00');
  assert.equal(f.dataHoraLocal('2026-11-12T09:30'), '12/11/2026 09:30');
  assert.equal(f.dataHoraLocal(null), '—');
});
