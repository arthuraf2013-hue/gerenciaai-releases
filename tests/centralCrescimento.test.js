const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// As contas da tela "Crescimento" da Central moram dentro do HTML
// (admin-panel/index.html, entre os marcadores <crescimento-logica>), que é
// publicado como um arquivo só. Este teste roda exatamente aquele trecho.
const html = fs.readFileSync(path.join(__dirname, '..', 'admin-panel', 'index.html'), 'utf8');
const inicio = html.indexOf('// <crescimento-logica>');
const fim = html.indexOf('// </crescimento-logica>');
assert.ok(inicio > 0 && fim > inicio, 'marcadores <crescimento-logica> não encontrados');
const C = {};
vm.runInNewContext(`${html.slice(inicio, fim)}
  Object.assign(exportar, { crescFimDoTeste, crescEtapasDoTeste, crescFunilDoTeste, crescTesteRepetido, crescNotaDeRisco,
    crescRelatorioDoCliente, crescComparacaoPorSegmento, crescPosicao, crescMediana, CRESC_DIA_MS });`, { exportar: C });

const DIA = 86400000;
const agora = Date.UTC(2026, 9, 23, 15);
const ts = (ms) => ({ toMillis: () => ms });

test('teste: prazo pelo criadoEm, extensão da Central e conversão em cliente', () => {
  const criado = agora - 10 * DIA;
  assert.equal(C.crescFimDoTeste({ teste: { dias: 14 }, criadoEm: ts(criado) }), criado + 14 * DIA);
  assert.equal(C.crescFimDoTeste({ teste: { dias: 14 }, criadoEm: ts(criado), testeAte: ts(agora + DIA) }), agora + DIA);
  assert.equal(C.crescFimDoTeste({ teste: { dias: 14 }, criadoEm: ts(criado), clienteId: 'c' }), null);
  assert.equal(C.crescFimDoTeste({ criadoEm: ts(criado) }), null); // instalação antiga
});

test('teste: etapas e onde parou', () => {
  const inst = {
    teste: { dias: 14 }, criadoEm: ts(agora - 9 * DIA), ultimoPing: ts(agora - 3 * DIA),
    produtosCadastrados: 40, totalVendasHistorico: 0,
  };
  const r = C.crescEtapasDoTeste(inst, agora);
  assert.deepEqual({ ...r.etapas }, { instalou: true, produtos: true, primeiraVenda: false, voltou7: false, cliente: false });
  assert.equal(r.parouEm, 'Fez a 1ª venda');
  assert.equal(r.diasRestantes, 5);
  assert.equal(r.diasSemSinal, 3);
  // produtos também vale pela lista de primeiros passos (versão sem produtosCadastrados)
  const pelaSaude = C.crescEtapasDoTeste({ ...inst, produtosCadastrados: undefined, saude: { implantacaoFaltando: ['Configurar a chave Pix'] } }, agora);
  assert.equal(pelaSaude.etapas.produtos, true);
  // usou depois de 7 dias
  assert.equal(C.crescEtapasDoTeste({ ...inst, ultimoPing: ts(agora - DIA) }, agora).etapas.voltou7, true);
});

test('funil: só testes dos últimos 90 dias; percentual sobre os que começaram', () => {
  const base = { teste: { dias: 14 } };
  const insts = [
    { ...base, id: 'a', criadoEm: ts(agora - 20 * DIA), produtosCadastrados: 10, totalVendasHistorico: 3, ultimoPing: ts(agora), clienteId: 'c1' },
    { ...base, id: 'b', criadoEm: ts(agora - 5 * DIA), produtosCadastrados: 2 },
    { ...base, id: 'c', criadoEm: ts(agora - 200 * DIA), produtosCadastrados: 50 }, // fora do período
    { id: 'd', criadoEm: ts(agora - 5 * DIA) }, // instalação sem teste (antiga)
  ];
  const f = C.crescFunilDoTeste(insts, agora, { dias: 90 });
  assert.equal(f.total, 2);
  const porId = Object.fromEntries(f.etapas.map((e) => [e.id, [e.quantidade, e.percentual]]));
  assert.deepEqual(porId, { instalou: [2, 100], produtos: [1, 50], primeiraVenda: [1, 50], voltou7: [1, 50], cliente: [1, 50] });
});

test('mesmo computador com teste anterior é sinalizado', () => {
  const antes = { id: 'x', maquinaHash: 'h1', criadoEm: ts(agora - 40 * DIA) };
  const depois = { id: 'y', maquinaHash: 'h1', criadoEm: ts(agora - 2 * DIA) };
  assert.equal(C.crescTesteRepetido(depois, [antes, depois]).id, 'x');
  assert.equal(C.crescTesteRepetido(antes, [antes, depois]), null);
  assert.equal(C.crescTesteRepetido({ id: 'z', criadoEm: ts(agora) }, [antes]), null);
});

test('risco: cada sinal soma pontos com o motivo escrito; teto 100', () => {
  const ok = [{ ultimoPing: ts(agora - 3600000), vendasUltimos30Dias: 300, vendasAnteriores30Dias: 280, vendas7Dias: 70, criadoEm: ts(agora - 100 * DIA) }];
  assert.equal(C.crescNotaDeRisco(ok, { agoraMs: agora }).nivel, 'baixo');

  const sumido = [{ ultimoPing: ts(agora - 9 * DIA), vendasUltimos30Dias: 40, vendasAnteriores30Dias: 300, vendas7Dias: 0, criadoEm: ts(agora - 100 * DIA) }];
  const r = C.crescNotaDeRisco(sumido, { agoraMs: agora, mensalidadeVencida: true, errosUltimos7Dias: 4 });
  assert.equal(r.nivel, 'alto');
  assert.equal(r.pontos, 95); // 40 sem sinal + 25 queda + 20 vencida + 10 erros (sem "não vendeu" porque está sem sinal)
  assert.ok(r.motivos.some((m) => m.includes('caíram 87%')));
  assert.ok(!r.motivos.some((m) => m.includes('não vendeu')));

  const abreMasNaoVende = [{ ultimoPing: ts(agora - 3600000), vendasUltimos30Dias: 20, vendasAnteriores30Dias: 25, vendas7Dias: 0, criadoEm: ts(agora - 100 * DIA) }];
  assert.ok(C.crescNotaDeRisco(abreMasNaoVende, { agoraMs: agora }).motivos.some((m) => m.includes('não vendeu')));

  // versão antiga (sem vendas7Dias): não acusa "não vendeu"
  const antiga = [{ ultimoPing: ts(agora), vendasUltimos30Dias: 20, criadoEm: ts(agora - 100 * DIA) }];
  assert.equal(C.crescNotaDeRisco(antiga, { agoraMs: agora }).pontos, 0);
});

test('relatório do cliente: soma as máquinas do mês mais recente e recalcula o ticket', () => {
  const r = C.crescRelatorioDoCliente([
    { relatorioMensal: { mes: '2026-09', vendas: 100, faturamento: 3000, campanhasVoltaram: 2, campanhasReceita: 150 } },
    { relatorioMensal: { mes: '2026-09', vendas: 50, faturamento: 1000 } },
    { relatorioMensal: { mes: '2026-08', vendas: 999, faturamento: 99999 } }, // máquina atrasada: mês velho fica de fora
    { relatorioMensal: { mes: '<script>', vendas: 1 } },
  ]);
  assert.equal(r.mes, '2026-09');
  assert.equal(r.maquinas, 2);
  assert.equal(r.vendas, 150);
  assert.equal(r.faturamento, 4000);
  assert.equal(r.ticketMedio, 26.67);
  assert.equal(r.campanhasReceita, 150);
  assert.equal(C.crescRelatorioDoCliente([{}]), null);
});

test('segmento: só com 5 lojas ou mais; loja = cliente somando as máquinas; teste fica de fora', () => {
  const loja = (clienteId, vendas, faturamento, perfil = 'padaria') => ({ clienteId, perfilAtivo: perfil, vendasUltimos30Dias: vendas, faturamento30Dias: faturamento });
  const quatro = [loja('a', 100, 2000), loja('b', 100, 3000), loja('c', 100, 4000), loja('d', 100, 5000), { perfilAtivo: 'padaria', vendasUltimos30Dias: 100, faturamento30Dias: 9000 }];
  const s4 = C.crescComparacaoPorSegmento(quatro)[0];
  assert.equal(s4.lojas, 4);
  assert.equal(s4.suficiente, false);
  assert.equal(s4.ticketMedio, null);

  const cinco = [...quatro, loja('e', 50, 3000), loja('e', 50, 3000)]; // cliente e: 2 máquinas = 1 loja
  const s5 = C.crescComparacaoPorSegmento(cinco)[0];
  assert.equal(s5.lojas, 5);
  assert.equal(s5.suficiente, true);
  assert.equal(s5.ticketMedio.mediana, 40); // tickets 20, 30, 40, 50, 60
  assert.equal(s5._valores.e.ticketMedio, 60);
  assert.equal(C.crescPosicao(60, 40), '50% acima');
  assert.equal(C.crescPosicao(39, 40), 'na média');
  assert.equal(C.crescPosicao(30, 40), '25% abaixo');
});
