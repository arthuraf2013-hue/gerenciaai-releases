import { VERSAO_SCHEMA } from '../src/db/schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { lojaPronta, bancoNovo } from './ajuda.js';
import { nuvemFalsa } from './nuvemFalsa.js';
import { gerarDump, restaurarDump, selecionarParaApagar, compactar, descompactar, ServicoBackup, FORMATO } from '../src/services/backup.js';
import { gravarConfig, lerConfig, definirRelogioDoDispositivo, carregarRelogioMax } from '../src/services/base.js';
import { finalizarVenda } from '../src/services/vendas.js';
import { obterProduto } from '../src/services/produtos.js';

const H = 3600000;
const D = 24 * H;

async function snapshot(db) {
  const o = {};
  for (const t of ['produtos', 'vendas', 'venda_itens', 'pagamentos', 'movimentos_estoque', 'usuarios', 'caixas', 'clientes']) {
    o[t] = await db.all(`SELECT * FROM ${t} ORDER BY id`);
  }
  return o;
}

test('backup -> restaurar devolve exatamente os mesmos dados; licença do aparelho e numeração não voltam pra trás', async () => {
  const { db, operador, coca } = await lojaPronta();
  await gravarConfig(db, 'licenca', { ativado: true, installId: 'ESTE-APARELHO' });
  await finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 2000 }], pagamentos: [{ metodo: 'pix', valorCentavos: 1100 }] }, operador);
  const antes = await snapshot(db);
  const json = JSON.stringify(await gerarDump(db, { installId: 'ESTE-APARELHO' }));
  const dump = JSON.parse(await descompactar(await compactar(json)));
  assert.equal(dump.formato, FORMATO);
  assert.equal(dump.tabelas.config.linhas.some((l) => l[0] === 'licenca'), false, 'licença não vai no backup');

  // Bagunça tudo depois do backup.
  await finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 3000 }], pagamentos: [{ metodo: 'pix', valorCentavos: 1650 }] }, operador);
  await db.run(`UPDATE produtos SET preco_centavos = 1 WHERE id = ?`, [coca]);
  await gravarConfig(db, 'licenca', { ativado: true, installId: 'ESTE-APARELHO', marca: 'atual' });

  await restaurarDump(db, dump);
  assert.deepEqual(await snapshot(db), antes);
  assert.equal((await lerConfig(db, 'licenca')).marca, 'atual', 'licença local preservada');
  assert.equal(await lerConfig(db, 'seq_venda'), 2, 'a venda nº 2 (perdida na restauração) nunca é reusada');
  const nova = await finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 1000 }], pagamentos: [{ metodo: 'pix', valorCentavos: 550 }] }, operador);
  assert.equal(nova.numero, 'MT-000003');
});

test('restauração recusa arquivo que não é backup do app e não altera nada', async () => {
  const { db, coca } = await lojaPronta();
  await assert.rejects(restaurarDump(db, { formato: 'outra-coisa' }), /não é um backup/);
  await assert.rejects(restaurarDump(db, { formato: FORMATO, versaoFormato: 99, versaoSchema: 1, tabelas: {} }), /versão mais nova/);
  // Backup com referência quebrada: transação inteira desfeita.
  const dump = await gerarDump(db, { installId: 'x' });
  dump.tabelas.venda_itens.linhas.push(dump.tabelas.venda_itens.colunas.map((c) => ({ id: 'i1', venda_id: 'NAO-EXISTE', produto_id: coca, nome: 'x', unidade: 'un', preco_unit_centavos: 1, qtd_mil: 1000, total_centavos: 1 })[c]));
  await assert.rejects(restaurarDump(db, dump), /inconsistente/);
  assert.equal((await obterProduto(db, coca)).nome, 'Coca-Cola Lata');
});

test('retenção: tudo das últimas 48 h + 1 por dia até o limite; nada além; o mais recente sempre fica', () => {
  const agora = Date.UTC(2026, 9, 16, 12, 0, 0);
  const lista = [];
  for (let h = 0; h < 40 * 24; h++) lista.push({ nomeArquivo: `b${h}`, criadoEmMs: agora - h * H });
  const apagar = new Set(selecionarParaApagar(lista, { agoraMs: agora, retencaoDias: 30 }).map((b) => b.nomeArquivo));
  const ficam = lista.filter((b) => !apagar.has(b.nomeArquivo));
  assert.ok(ficam.every((b) => agora - b.criadoEmMs <= 30 * D), 'nada com mais de 30 dias');
  assert.equal(ficam.filter((b) => agora - b.criadoEmMs <= 48 * H).length, 49, 'todos das últimas 48 h');
  const dias = new Map();
  for (const b of ficam.filter((x) => agora - x.criadoEmMs > 48 * H)) {
    const d = new Date(b.criadoEmMs); const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    dias.set(k, (dias.get(k) || 0) + 1);
  }
  assert.ok([...dias.values()].every((n) => n === 1), 'no máximo um por dia depois das 48 h');
  assert.ok(ficam.length <= 49 + 30, `total enxuto (${ficam.length})`);
  // Aparelho que ficou 60 dias sem backup: o último fica mesmo vencido.
  const sozinho = [{ nomeArquivo: 'velho', criadoEmMs: agora - 60 * D }];
  assert.equal(selecionarParaApagar(sozinho, { agoraMs: agora, retencaoDias: 30 }).length, 0);
});

async function servicoPronto() {
  const loja = await lojaPronta();
  let agora = Date.UTC(2026, 9, 16, 12, 0, 0);
  definirRelogioDoDispositivo(() => agora);
  // lojaPronta() rodou com o relógio real (mais à frente que `agora`) e o
  // relógio confiável nunca volta pra trás -- zera pra o tempo simulado andar.
  carregarRelogioMax(0);
  const nuvem = nuvemFalsa({ relogioServidor: () => agora });
  const licenca = { estado: { ativado: true, installId: 'inst-1', backupFrequenciaHoras: 1, backupRetencaoDias: 30 }, aoReceberDadosDoServidor() {} };
  let restaurou = 0;
  const backup = new ServicoBackup({ db: loja.db, nuvem, licenca, aoRestaurar: () => { restaurou += 1; } });
  return { ...loja, nuvem, licenca, backup, avancar: (ms) => { agora += ms; }, restaurou: () => restaurou };
}

test('agendado: sobe na frequência da Central, pula quando nada mudou, registra pra aba Backups', async () => {
  const s = await servicoPronto();
  await s.backup.verificarAgendado();
  assert.equal(s.nuvem.chamadas.filter((c) => c[0] === 'upload').length, 1);
  const meta = [...s.nuvem.backups.get('inst-1').values()][0];
  assert.match(meta.caminhoStorage, /^backups\/inst-1\/mobile-\d{8}-\d{6}\.json\.gz$/);
  assert.equal(s.nuvem.instalacoes.get('inst-1').ultimoBackupNuvemOk, true);

  s.avancar(30 * 60000);
  await s.backup.verificarAgendado();
  assert.equal(s.nuvem.chamadas.filter((c) => c[0] === 'upload').length, 1, 'antes de 1 h não faz');
  s.avancar(31 * 60000);
  await s.backup.verificarAgendado();
  assert.equal(s.nuvem.chamadas.filter((c) => c[0] === 'upload').length, 1, 'passou 1 h mas nada mudou: não sobe');
  await finalizarVenda(s.db, { itens: [{ produtoId: s.coca, qtdMil: 1000 }], pagamentos: [{ metodo: 'pix', valorCentavos: 550 }] }, s.operador);
  s.avancar(61 * 60000);
  await s.backup.verificarAgendado();
  assert.equal(s.nuvem.chamadas.filter((c) => c[0] === 'upload').length, 2);

  s.licenca.estado.backupFrequenciaHoras = 6;
  await finalizarVenda(s.db, { itens: [{ produtoId: s.coca, qtdMil: 1000 }], pagamentos: [{ metodo: 'pix', valorCentavos: 550 }] }, s.operador);
  s.avancar(2 * H);
  await s.backup.verificarAgendado();
  assert.equal(s.nuvem.chamadas.filter((c) => c[0] === 'upload').length, 2, 'com 6 h programado, 2 h não basta');
});

test('falha de rede: registra o erro, espera 10 min e tenta de novo', async () => {
  const s = await servicoPronto();
  s.nuvem.ficarOffline(true);
  await assert.rejects(s.backup.verificarAgendado());
  assert.match((await s.backup.estado()).ultimoErro, /sem internet/);
  s.nuvem.ficarOffline(false);
  s.avancar(5 * 60000);
  await s.backup.verificarAgendado();
  assert.equal(s.nuvem.chamadas.length, 0, 'ainda dentro da espera');
  s.avancar(6 * 60000);
  await s.backup.verificarAgendado();
  assert.equal(s.nuvem.chamadas.filter((c) => c[0] === 'upload').length, 1);
});

test('Central: "fazer backup agora" e "restaurar" (com backup de segurança antes; sem ele, não restaura)', async () => {
  const s = await servicoPronto();
  await s.backup.processarDadosDoServidor({ backupSolicitadoEm: 1000 });
  await s.backup.processarDadosDoServidor({ backupSolicitadoEm: 1000 }); // mesmo pedido: não repete
  assert.equal(s.nuvem.chamadas.filter((c) => c[0] === 'upload').length, 1);
  const alvo = [...s.nuvem.backups.get('inst-1').values()][0];

  await finalizarVenda(s.db, { itens: [{ produtoId: s.coca, qtdMil: 4000 }], pagamentos: [{ metodo: 'pix', valorCentavos: 2200 }] }, s.operador);
  assert.equal((await obterProduto(s.db, s.coca)).estoque_mil, 6000);

  // Sem conseguir o backup de segurança, não mexe em nada.
  s.nuvem.falharUpload = true;
  await assert.rejects(s.backup.processarDadosDoServidor({ restaurarBackupSolicitado: { ...alvo, solicitadoEmMs: 1 } }), /restauração cancelada/);
  assert.equal((await obterProduto(s.db, s.coca)).estoque_mil, 6000);
  assert.equal(s.nuvem.instalacoes.get('inst-1').restauracaoStatus, 'falhou');

  s.nuvem.falharUpload = false;
  s.avancar(1000);
  await s.backup.processarDadosDoServidor({ restaurarBackupSolicitado: { ...alvo, solicitadoEmMs: 2 } });
  assert.equal((await obterProduto(s.db, s.coca)).estoque_mil, 10000);
  assert.equal(s.nuvem.instalacoes.get('inst-1').restauracaoStatus, 'concluida');
  assert.equal(s.restaurou(), 1);
  assert.ok([...s.nuvem.backups.get('inst-1').keys()].some((n) => n.includes('antes-de-restaurar')));
});

test('banco novo vazio também gera backup válido (aparelho recém-ativado)', async () => {
  const db = await bancoNovo();
  const dump = await gerarDump(db, { installId: 'x' });
  await restaurarDump(db, dump);
  assert.equal(dump.versaoSchema, VERSAO_SCHEMA);
});
