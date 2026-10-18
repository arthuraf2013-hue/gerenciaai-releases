import test from 'node:test';
import assert from 'node:assert/strict';
import { bancoNovo } from './ajuda.js';
import { nuvemFalsa } from './nuvemFalsa.js';
import { ServicoLicenca, aplicarDadosDoServidor } from '../src/services/licenca.js';
import { ServicoTerminal, aplicarCatalogo, pendentesNaoConfirmados } from '../src/services/terminal.js';
import { definirRelogioDoDispositivo, ctx, lerConfig } from '../src/services/base.js';
import { abrirCaixa } from '../src/services/caixa.js';
import { salvarProduto, movimentarEstoque, definirProdutoAtivo, obterProduto } from '../src/services/produtos.js';
import { salvarCliente, receberFiado, obterCliente } from '../src/services/clientes.js';
import { finalizarVenda, cancelarVenda } from '../src/services/vendas.js';
import { listarUsuarios, criarUsuario } from '../src/services/usuarios.js';
import { gerarDump, restaurarDump } from '../src/services/backup.js';
import { partirCatalogo, juntarCatalogo } from '../src/services/terminalMemoria.js';

const T0 = Date.UTC(2026, 9, 16, 15, 0, 0);
const MIN = 60000;

/** Espera até `cond()` ficar verdadeira (os ouvintes da nuvem disparam trabalho em segundo plano). */
async function ate(cond, rotulo = 'condição') {
  for (let i = 0; i < 500; i++) {
    if (await cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`não aconteceu: ${rotulo}`);
}

async function preparar(opcoes = {}) {
  const db = await bancoNovo();
  let relogio = T0;
  definirRelogioDoDispositivo(() => relogio);
  const nuvem = nuvemFalsa({ relogioServidor: () => relogio });
  nuvem.ativacoes.set('ABCD2345', { clienteId: 'cli-1', usado: false, expiraEmMs: T0 + 7 * 86400000 });
  const lic = new ServicoLicenca({ db, nuvem, versaoApp: '1.0.0' });
  await lic.carregar();
  const { installId } = await lic.ativar({ codigo: 'ABCD2345', nomeNegocio: 'Mercadinho', adminNome: 'Dona Ana', adminPin: '1234' });
  const admin = (await listarUsuarios(db))[0].id;
  const gerente = await criarUsuario(db, { nome: 'Gerente', papel: 'gerente', pin: '2222' });
  const coca = await salvarProduto(db, { nome: 'Coca-Cola Lata', precoCentavos: 550, codigoBarras: '7894900011517', estoqueInicialMil: 10000 }, admin);
  const pao = await salvarProduto(db, { nome: 'Pão de forma', precoCentavos: 900, codigoBarras: '789000000001', estoqueInicialMil: 5000 }, admin);
  await abrirCaixa(db, { valorAberturaCentavos: 5000 }, admin);
  const terminal = new ServicoTerminal({ db, nuvem, licenca: lic, atrasoAposFatoMs: opcoes.atrasoAposFatoMs ?? null });
  await terminal.iniciar();
  return { db, nuvem, lic, terminal, installId, admin, gerente, coca, pao, mudarRelogio: (ms) => { relogio = ms; } };
}

const vender = (db, operador, produtoId, qtdMil, valorCentavos, extra = {}) =>
  finalizarVenda(db, { itens: [{ produtoId, qtdMil }], pagamentos: [{ metodo: 'pix', valorCentavos }], ...extra }, operador);

async function virarTerminal(nuvem, installId, terminal, corteMs) {
  nuvem.painelAltera(installId, { migradoPara: 'pc-1', migradoParaNome: 'Caixa do balcão', migradoCorteMs: corteMs });
  nuvem.painelAltera(installId, { modoOperacao: 'terminal', servidorInstallId: 'pc-1', servidorNome: 'Caixa do balcão' });
  await ate(() => terminal.ativo, 'terminal ativo');
  await terminal.fila;
}

test('licença: modo vem do documento; terminal sem computador indicado continua autônomo', () => {
  const e = { ativado: true };
  assert.equal(aplicarDadosDoServidor(e, { modoOperacao: 'terminal', servidorInstallId: 'pc-1', servidorNome: 'PC' }, null).modoOperacao, 'terminal');
  assert.equal(aplicarDadosDoServidor(e, { modoOperacao: 'terminal' }, null).modoOperacao, 'autonomo');
  const voltou = aplicarDadosDoServidor({ ...e, modoOperacao: 'terminal', servidorInstallId: 'pc-1' }, { modoOperacao: 'autonomo' }, null);
  assert.deepEqual([voltou.modoOperacao, voltou.servidorInstallId], ['autonomo', null]);
  assert.equal(aplicarDadosDoServidor(e, { migradoCorteMs: 123 }, null).migradoCorteMs, 123);
});

test('virar terminal: só o que veio DEPOIS da migração sobe; cadastro de produto trava; venda segue', async (t) => {
  const { db, nuvem, lic, terminal, installId, admin, coca, pao, mudarRelogio } = await preparar();
  t.after(() => { terminal.parar(); lic.pararSincronizacao(); });

  const antes = await vender(db, admin, coca, 1000, 550); // já foi pro computador na importação
  mudarRelogio(T0 + 10 * MIN);
  const depois = await vender(db, admin, pao, 2000, 1800); // entre a migração e virar terminal
  const cliNovo = await salvarCliente(db, { nome: 'João', telefone: '81999990000' }, admin);
  await movimentarEstoque(db, { produtoId: coca, modo: 'entrada', qtdMil: 12000, motivo: 'NF 99' }, admin); // idem
  assert.equal(await db.valor('SELECT COUNT(*) FROM sync_saida'), 0, 'autônomo não enfileira nada');

  await virarTerminal(nuvem, installId, terminal, T0 + 5 * MIN);
  assert.equal(ctx().modoTerminal, true);
  assert.equal(ctx().servidorNome, 'Caixa do balcão');
  await terminal.enviarPendentes();
  const subiram = nuvem.computador.eventos(installId);
  assert.deepEqual(subiram.map((e) => e.tipo).sort(), ['cliente', 'estoque', 'venda']);
  assert.equal(subiram.find((e) => e.tipo === 'venda').refId, depois.id);
  assert.equal(subiram.find((e) => e.tipo === 'cliente').refId, cliNovo);
  const entrada = JSON.parse(subiram.find((e) => e.tipo === 'estoque').dadosJson);
  assert.deepEqual([entrada.movimento.tipo, entrada.movimento.qtd_mil, entrada.produto.id], ['entrada', 12000, coca]);
  assert.ok(!subiram.some((e) => e.refId === antes.id));
  const ev = JSON.parse(subiram.find((e) => e.tipo === 'venda').dadosJson);
  assert.equal(ev.venda.numero, depois.numero);
  assert.equal(ev.itens.length, 1);
  assert.equal(ev.movimentos[0].qtd_mil, -2000);
  assert.equal(ev.produtos[0].codigo_barras, '789000000001');
  assert.equal(ev.operador.nome, 'Dona Ana');
  assert.equal(nuvem.instalacoes.get(installId).terminalPendentes, 3);

  // Reativar o modo (ex.: app reaberto) não enfileira o atraso de novo.
  await terminal.sincronizarModo();
  assert.equal(await db.valor('SELECT COUNT(*) FROM sync_saida'), 3);

  await assert.rejects(salvarProduto(db, { nome: 'X', precoCentavos: 100 }, admin), (e) => e.codigo === 'modo_terminal' && /Caixa do balcão/.test(e.message));
  await assert.rejects(movimentarEstoque(db, { produtoId: coca, modo: 'entrada', qtdMil: 1000 }, admin), (e) => e.codigo === 'modo_terminal');
  await assert.rejects(definirProdutoAtivo(db, coca, false, admin), (e) => e.codigo === 'modo_terminal');

  const v3 = await vender(db, admin, coca, 3000, 1650);
  const linha = await db.get('SELECT * FROM sync_saida WHERE ref_id = ?', [v3.id]);
  assert.deepEqual([linha.tipo, linha.status], ['venda', 'pendente']);
});

test('offline: vende e enfileira; ao voltar a rede sobe na ordem; confirmação do computador fecha o ciclo', async (t) => {
  const { db, nuvem, lic, terminal, installId, admin, gerente, coca, mudarRelogio } = await preparar();
  t.after(() => { terminal.parar(); lic.pararSincronizacao(); });
  await virarTerminal(nuvem, installId, terminal, T0 + 1);

  nuvem.ficarOffline(true);
  mudarRelogio(T0 + MIN);
  const v1 = await vender(db, admin, coca, 1000, 550);
  mudarRelogio(T0 + 2 * MIN);
  const cli = await salvarCliente(db, { nome: 'Maria' }, admin);
  mudarRelogio(T0 + 3 * MIN);
  const v2 = await finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 2000 }], clienteId: cli, pagamentos: [{ metodo: 'fiado', valorCentavos: 1100 }] }, admin);
  mudarRelogio(T0 + 4 * MIN);
  await receberFiado(db, { clienteId: cli, valorCentavos: 600, metodo: 'dinheiro' }, admin);
  mudarRelogio(T0 + 5 * MIN);
  await cancelarVenda(db, { vendaId: v1.id, motivo: 'cliente desistiu', pinGerente: '2222' }, admin);

  const r = await terminal.enviarPendentes();
  assert.match(r.erro, /internet/);
  assert.equal((await terminal.resumo()).naoEnviados, 5);

  nuvem.ficarOffline(false);
  await terminal.enviarPendentes();
  const tipos = nuvem.computador.eventos(installId).map((e) => e.tipo);
  assert.deepEqual(tipos, ['venda', 'cliente', 'venda', 'fiado_pagamento', 'venda_cancelada']);
  const cancel = JSON.parse(nuvem.computador.eventos(installId).at(-1).dadosJson);
  assert.equal(cancel.vendaId, v1.id);
  assert.equal(cancel.movimentos[0].qtd_mil, 1000);
  assert.equal(cancel.cancelador.id, gerente);
  const pag = JSON.parse(nuvem.computador.eventos(installId)[3].dadosJson);
  assert.equal(pag.lancamento.valor_centavos, -600);

  // Computador aplica tudo, menos a venda fiado (recusa) -> fica em erro, dá pra mandar de novo.
  const idVenda2 = (await db.get(`SELECT id FROM sync_saida WHERE ref_id = ?`, [v2.id])).id;
  for (const e of nuvem.computador.eventos(installId)) {
    nuvem.computador.confirmar(installId, e.id, e.id === idVenda2 ? { status: 'erro', erro: 'Cliente bloqueado no computador' } : { resultado: { nfce: { status: 'emitida' } } });
  }
  await ate(async () => (await terminal.resumo()).pendentes === 0, 'acks aplicados');
  const res = await terminal.resumo();
  assert.equal(res.confirmados, 4);
  assert.equal(res.erros.length, 1);
  assert.match(res.erros[0].erro, /bloqueado/);
  assert.equal(nuvem.computador.acks(installId).size, 0, 'recibo apagado depois de lido');
  await ate(() => nuvem.instalacoes.get(installId).terminalErros === 1, 'relato de erro na Central');
  assert.equal((await terminal.situacaoDaVenda(v1.id))[0].resultado.nfce.status, 'emitida');

  await terminal.tentarNovamente(idVenda2);
  assert.equal((await db.get('SELECT status FROM sync_saida WHERE id = ?', [idVenda2])).status, 'enviado');
});

test('catálogo do computador: preço/estoque de lá menos o que ainda não chegou; produto que sumiu fica inativo; código de barras muda de dono', async (t) => {
  const { db, nuvem, lic, terminal, installId, admin, coca, pao } = await preparar();
  t.after(() => { terminal.parar(); lic.pararSincronizacao(); });
  const cli = await salvarCliente(db, { nome: 'Maria', limiteFiadoCentavos: 10000 }, admin);
  await virarTerminal(nuvem, installId, terminal, T0 + 1);

  await vender(db, admin, coca, 2000, 1100); // pendente: -2 coca
  await finalizarVenda(db, { itens: [{ produtoId: coca, qtdMil: 1000 }], clienteId: cli, pagamentos: [{ metodo: 'fiado', valorCentavos: 550 }] }, admin); // -1 coca, +5,50 fiado
  const novoPc = 'aaaaaaaa-0000-4000-8000-000000000001';
  nuvem.computador.publicarCatalogo(installId, {
    versao: 'v1',
    produtos: [
      { id: coca, nome: 'Coca-Cola Lata 350ml', codigo_barras: '7894900011517', unidade: 'un', preco_centavos: 600, custo_centavos: 300, estoque_mil: 48000, controla_estoque: 1 },
      // O computador ligou o código do pão a um produto dele (o do celular sai de cena).
      { id: novoPc, nome: 'Pão de forma Seven Boys', codigo_barras: '789000000001', unidade: 'UN', preco_centavos: 1090, estoque_mil: 20000, controla_estoque: 1, categoria: 'Padaria' },
    ],
    clientes: [{ id: cli, nome: 'Maria da Silva', telefone: '81988887777', documento: null, saldo_fiado_centavos: 1200 }],
  });
  await ate(async () => (await lerConfig(db, 'terminal_catalogo'))?.versao === 'v1', 'catálogo aplicado');

  const c = await obterProduto(db, coca);
  assert.deepEqual([c.nome, c.preco_centavos, c.estoque_mil], ['Coca-Cola Lata 350ml', 600, 48000 - 3000]);
  const p = await obterProduto(db, novoPc);
  assert.deepEqual([p.nome, p.unidade, p.codigo_barras, p.ativo, p.estoque_mil], ['Pão de forma Seven Boys', 'un', '789000000001', 1, 20000]);
  const velho = await obterProduto(db, pao);
  assert.deepEqual([velho.codigo_barras, velho.ativo], [null, 0]);
  assert.equal((await obterCliente(db, cli)).saldo_fiado_centavos, 1200 + 550);
  assert.equal((await obterCliente(db, cli)).nome, 'Maria da Silva');
  // O livro de estoque NÃO é tocado pelo catálogo (o cache vem do computador).
  assert.equal(await db.valor(`SELECT COUNT(*) FROM movimentos_estoque WHERE produto_id = ?`, [novoPc]), 0);

  // Mesma versão de novo: não reaplica.
  await db.run('UPDATE produtos SET preco_centavos = 1 WHERE id = ?', [coca]);
  nuvem.computador.publicarCatalogo(installId, { versao: 'v1', produtos: [], clientes: [] });
  await new Promise((r) => setImmediate(r));
  assert.equal((await obterProduto(db, coca)).preco_centavos, 1);

  // Depois que o computador confirma, a dedução some (já está no estoque dele).
  await terminal.enviarPendentes();
  nuvem.computador.confirmarTodos(installId);
  await ate(async () => (await terminal.resumo()).pendentes === 0, 'confirmados');
  const pend = await pendentesNaoConfirmados(db);
  assert.equal(pend.estoque.size, 0);
});

test('aplicarCatalogo: cliente editado aqui e ainda não enviado não é sobrescrito', async (t) => {
  const { db, nuvem, lic, terminal, installId, admin } = await preparar();
  t.after(() => { terminal.parar(); lic.pararSincronizacao(); });
  await virarTerminal(nuvem, installId, terminal, T0 + 1);
  const cli = await salvarCliente(db, { nome: 'Nome novo no celular' }, admin);
  await aplicarCatalogo(db, { versao: 'x', produtos: [], clientes: [{ id: cli, nome: 'Nome antigo', saldo_fiado_centavos: 0 }] });
  assert.equal((await obterCliente(db, cli)).nome, 'Nome novo no celular');
});

test('voltar a autônomo destrava o cadastro; backup não leva a fila nem o vínculo e força reaplicar o catálogo', async (t) => {
  const { db, nuvem, lic, terminal, installId, admin, coca, mudarRelogio } = await preparar();
  t.after(() => { terminal.parar(); lic.pararSincronizacao(); });
  await virarTerminal(nuvem, installId, terminal, T0 + 1);
  mudarRelogio(T0 + MIN);
  await vender(db, admin, coca, 1000, 550);
  nuvem.computador.publicarCatalogo(installId, { versao: 'v9', produtos: [{ id: coca, nome: 'Coca', preco_centavos: 600, estoque_mil: 10000, controla_estoque: 1 }], clientes: [] });
  await ate(async () => (await lerConfig(db, 'terminal_catalogo'))?.versao === 'v9', 'catálogo');

  const dump = await gerarDump(db, { installId });
  assert.equal(dump.tabelas.sync_saida, undefined);
  const chaves = dump.tabelas.config.linhas.map((l) => l[0]);
  assert.ok(!chaves.some((k) => k.startsWith('terminal_')));
  await restaurarDump(db, dump);
  assert.equal(await lerConfig(db, 'terminal_catalogo'), null, 'catálogo será reaplicado na reabertura');
  assert.equal(await db.valor('SELECT COUNT(*) FROM sync_saida'), 1, 'fila do aparelho sobrevive à restauração');

  // Voltou a autônomo com a venda ainda na fila (sem rede): continua mandando até esvaziar.
  assert.equal(nuvem.computador.eventos(installId).length, 0);
  mudarRelogio(T0 + 10 * MIN);
  nuvem.painelAltera(installId, { modoOperacao: 'autonomo' });
  await ate(() => !terminal.ativo, 'voltou a autônomo');
  await ate(() => nuvem.computador.eventos(installId).length === 1, 'fila drenada depois de voltar a autônomo');
  assert.equal(ctx().modoTerminal, false);
  await salvarProduto(db, { nome: 'Bala', precoCentavos: 10 }, admin);
  mudarRelogio(T0 + 20 * MIN);
  const v = await vender(db, admin, coca, 1000, 600);
  assert.equal(await db.valor('SELECT COUNT(*) FROM sync_saida WHERE ref_id = ?', [v.id]), 0);

  // Vira terminal de novo: o que foi vendido no período autônomo vai junto (e só isso).
  nuvem.painelAltera(installId, { modoOperacao: 'terminal', servidorInstallId: 'pc-1' });
  await ate(() => terminal.ativo, 'terminal de novo');
  await terminal.fila;
  const linhas = await db.all('SELECT tipo, ref_id FROM sync_saida ORDER BY criado_em_ms');
  assert.equal(linhas.filter((l) => l.ref_id === v.id).length, 1);
  assert.equal(linhas.filter((l) => l.tipo === 'venda').length, 2, 'a venda do primeiro período não é repetida');
});

test('catálogo: evento que o computador já aplicou não é descontado de novo; apelidos somam no produto/cliente do computador', async (t) => {
  const { db, nuvem, lic, terminal, installId, admin, coca, pao } = await preparar();
  t.after(() => { terminal.parar(); lic.pararSincronizacao(); });
  const cli = await salvarCliente(db, { nome: 'Zé', documento: '12345678909', limiteFiadoCentavos: 10000 }, admin);
  await virarTerminal(nuvem, installId, terminal, T0 + 1);
  await terminal.enviarPendentes();
  nuvem.computador.confirmarTodos(installId);
  await ate(async () => (await terminal.resumo()).pendentes === 0, 'cliente confirmado');

  const v1 = await vender(db, admin, coca, 2000, 1100);
  const v2 = await finalizarVenda(db, { itens: [{ produtoId: pao, qtdMil: 1000 }], clienteId: cli, pagamentos: [{ metodo: 'fiado', valorCentavos: 900 }] }, admin);
  await terminal.enviarPendentes();
  const idV1 = (await db.get('SELECT id FROM sync_saida WHERE ref_id = ?', [v1.id])).id;
  const pcCoca = coca;
  const pcPao = 'bbbbbbbb-0000-4000-8000-000000000002';
  const pcCli = 'cccccccc-0000-4000-8000-000000000003';
  // O computador já aplicou a v1 (recibo ainda não chegou); a v2 ainda não.
  // O pão e o Zé do celular foram ligados a cadastros do computador.
  nuvem.computador.publicarCatalogo(installId, {
    versao: 'v2', eventosAplicados: [idV1],
    produtos: [
      { id: pcCoca, nome: 'Coca', preco_centavos: 550, estoque_mil: 8000, controla_estoque: 1 },
      { id: pcPao, nome: 'Pão', codigo_barras: '789000000001', preco_centavos: 900, estoque_mil: 30000, controla_estoque: 1, apelidos: [pao] },
    ],
    clientes: [{ id: pcCli, nome: 'José', documento: '12345678909', saldo_fiado_centavos: 5000, apelidos: [cli] }],
  });
  await ate(async () => (await lerConfig(db, 'terminal_catalogo'))?.versao === 'v2', 'catálogo v2');
  assert.equal((await obterProduto(db, pcCoca)).estoque_mil, 8000, 'v1 já está no estoque do computador');
  assert.equal((await db.get('SELECT status FROM sync_saida WHERE id = ?', [idV1])).status, 'aplicado');
  assert.equal((await obterProduto(db, pcPao)).estoque_mil, 30000 - 1000, 'v2 (pão do celular) ainda pendente, conta no pão do computador');
  assert.equal((await obterProduto(db, pao)).ativo, 0);
  assert.equal((await obterCliente(db, pcCli)).saldo_fiado_centavos, 5000 + 900);
  assert.equal((await obterCliente(db, cli)).ativo, 0);
  assert.ok(v2.id);
});

test('venda no terminal sobe sozinha logo depois (sem esperar o ciclo de 1 min)', async (t) => {
  const { db, nuvem, lic, terminal, installId, admin, coca } = await preparar({ atrasoAposFatoMs: 1 });
  t.after(() => { terminal.parar(); lic.pararSincronizacao(); });
  await virarTerminal(nuvem, installId, terminal, T0 + 1);
  const v = await vender(db, admin, coca, 1000, 550);
  await new Promise((r) => setTimeout(r, 30));
  await ate(() => nuvem.computador.eventos(installId).some((e) => e.refId === v.id), 'venda enviada');
});

test('catálogo em partes: junta na ordem e recusa mistura de versões', () => {
  const produtos = Array.from({ length: 2500 }, (_, i) => ({ id: `p${i}` }));
  const { partes, partesProdutos, partesClientes } = partirCatalogo({ produtos, clientes: [] });
  assert.deepEqual([partesProdutos, partesClientes], [3, 0]);
  const docs = Object.fromEntries(Object.entries(partes).map(([k, v]) => [k, { versao: 'a', itensJson: JSON.stringify(v) }]));
  assert.equal(juntarCatalogo({ versao: 'a', partesProdutos: 3, partesClientes: 0 }, docs).produtos.at(-1).id, 'p2499');
  docs.p1.versao = 'b';
  assert.throws(() => juntarCatalogo({ versao: 'a', partesProdutos: 3, partesClientes: 0 }, docs), /atualização/);
});
