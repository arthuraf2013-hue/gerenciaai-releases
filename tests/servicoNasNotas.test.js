// Nota e pré-nota com os dois totais fixos: sem serviço e com serviço opcional (nov/2026).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../electron/services/impressaoLayout');

const texto = (html) => html.replace(/<style[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('configuração: vale para nota e pré-nota, desligada por padrão e % limitada', () => {
  for (const tipo of ['nota', 'prenota']) {
    assert.equal(L.normalizarConfig(tipo, {}).mostrarComESemServico, false);
    assert.equal(L.normalizarConfig(tipo, {}).taxaSugeridaPercentual, 0);
    assert.equal(L.normalizarConfig(tipo, { mostrarComESemServico: true }).mostrarComESemServico, true);
    assert.equal(L.normalizarConfig(tipo, { taxaSugeridaPercentual: 99 }).taxaSugeridaPercentual, 30);
    assert.equal(L.normalizarConfig(tipo, { taxaSugeridaPercentual: -5 }).taxaSugeridaPercentual, 0);
  }
});

test('pré-nota com taxa: total sem serviço e com serviço, também na parte de cada pessoa', () => {
  const dados = L.exemplo('prenota'); // itens 160,30 e taxa de 10%
  const t = texto(L.montarPreNota({ mostrarComESemServico: true }, dados));
  assert.match(t, /Total sem serviço R\$ 160,30/);
  assert.match(t, /Total com serviço \(10%, opcional\) R\$ 176,33/);
  assert.match(t, /Sem serviço · com serviço \(10%\) R\$ 73,90 · R\$ 81,29/); // Ana
  assert.match(t, /Sem serviço · com serviço \(10%\) R\$ 86,40 · R\$ 95,04/); // Bruno
  const soAna = texto(L.montarPreNota({ mostrarComESemServico: true }, { ...dados, pessoaNumero: 1 }));
  assert.match(soAna, /Total sem serviço R\$ 73,90 Total com serviço \(10%, opcional\) R\$ 81,29/);
  // Desligado: como antes, sem os dois totais.
  assert.doesNotMatch(texto(L.montarPreNota({}, dados)), /Total sem serviço/);
});

test('pré-nota com desconto: o serviço é calculado sobre o valor já com desconto', () => {
  const dados = { ...L.exemplo('prenota'), desconto: 10.3, pessoas: [] };
  const t = texto(L.montarPreNota({ mostrarComESemServico: true }, dados));
  assert.match(t, /Total sem serviço R\$ 150,00 Total com serviço \(10%, opcional\) R\$ 165,00/);
});

test('conta sem taxa: usa a % configurada; sem % configurada, não inventa serviço', () => {
  const dados = { ...L.exemplo('prenota'), taxaServicoPercentual: 0 };
  const t = texto(L.montarPreNota({ mostrarComESemServico: true, taxaSugeridaPercentual: 12 }, dados));
  assert.match(t, /Total R\$ 160,30/);
  assert.match(t, /Total sem serviço R\$ 160,30 Total com serviço \(12%, opcional\) R\$ 179,54/);
  assert.doesNotMatch(t, /Serviço opcional/, 'não repete a sugestão antiga');
  assert.doesNotMatch(texto(L.montarPreNota({ mostrarComESemServico: true }, dados)), /Total sem serviço/);
});

test('nota: com taxa cobrada e sem taxa', () => {
  const nota = L.exemplo('nota'); // 160,30 sem taxa
  const semTaxa = texto(L.montarNota({ mostrarComESemServico: true, taxaSugeridaPercentual: 10 }, nota));
  assert.match(semTaxa, /Total R\$ 160,30 Total sem serviço R\$ 160,30 Total com serviço \(10%, opcional\) R\$ 176,33/);
  const comTaxa = texto(L.montarNota({ mostrarComESemServico: true }, { ...nota, taxaServicoPercentual: 10, taxaServicoValor: 16.03, totalFinal: 176.33 }));
  assert.match(comTaxa, /Total R\$ 176,33 Total sem serviço R\$ 160,30 Total com serviço \(10%, opcional\) R\$ 176,33/);
  assert.doesNotMatch(texto(L.montarNota({}, nota)), /Total sem serviço/);
});
