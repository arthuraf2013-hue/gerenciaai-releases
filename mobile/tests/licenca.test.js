import test from 'node:test';
import assert from 'node:assert/strict';
import { bancoNovo } from './ajuda.js';
import { nuvemFalsa } from './nuvemFalsa.js';
import { calcularStatus, ServicoLicenca } from '../src/services/licenca.js';
import { definirRelogioDoDispositivo, relogioMax } from '../src/services/base.js';
import { abrirCaixa } from '../src/services/caixa.js';
import { salvarProduto } from '../src/services/produtos.js';
import { finalizarVenda } from '../src/services/vendas.js';
import { listarUsuarios } from '../src/services/usuarios.js';

const H = 3600000;
const D = 24 * H;
const T0 = Date.UTC(2026, 9, 16, 15, 0, 0);
const base = { ativado: true, ultimoContatoOkMs: T0 };
const st = (estado, agora, max = 0) => calcularStatus(estado, { agoraDispositivoMs: agora, relogioMaxMs: max });

test('3 dias sem internet: aviso a partir do 2º dia, bloqueio no 3º', () => {
  assert.equal(st(base, T0 + 1 * D).status, 'ok');
  const dia2 = st(base, T0 + 2.5 * D);
  assert.equal(dia2.status, 'ok');
  assert.equal(dia2.alertaSemInternetHoras, 12);
  const dia3 = st(base, T0 + 3 * D);
  assert.deepEqual([dia3.status, dia3.motivo, dia3.podeVender], ['bloqueado', 'sem_internet', false]);
});

test('atrasar o relógio do celular não estica o prazo: bloqueia por relógio', () => {
  // Já viu T0 + 2,9 dias; usuário volta o relógio pra T0.
  const s = st(base, T0, T0 + 2.9 * D);
  assert.deepEqual([s.status, s.motivo], ['bloqueado', 'relogio_atrasado']);
  // Dentro da tolerância (5 min), não incomoda.
  assert.equal(st(base, T0 + D - 5 * 60000, T0 + D).status, 'ok');
});

test('congelada: 2 dias de aviso vendendo, depois somente leitura; bloqueio imediato vence tudo', () => {
  const cong = { ...base, congeladaDesdeMs: T0 };
  const a = st(cong, T0 + 1.5 * D);
  assert.deepEqual([a.status, a.horasRestantes, a.podeVender], ['aviso', 12, true]);
  const b = st(cong, T0 + 2 * D);
  assert.deepEqual([b.status, b.podeVender], ['somente_leitura', false]);
  assert.equal(st({ ...cong, bloqueioImediato: true, motivoBloqueio: 'Pendência' }, T0 + 1000).mensagem, 'Pendência');
  // Congelada vencida + sem internet: prevalece o mais restritivo.
  assert.equal(st(cong, T0 + 5 * D).status, 'bloqueado');
  assert.equal(st({ ativado: false }, T0).status, 'nao_ativado');
});

async function preparar({ agoraServidor = () => T0 } = {}) {
  const db = await bancoNovo();
  let relogioAparelho = T0;
  definirRelogioDoDispositivo(() => relogioAparelho);
  const nuvem = nuvemFalsa({ relogioServidor: agoraServidor });
  nuvem.ativacoes.set('ABCD2345', { clienteId: 'cli-1', usado: false, expiraEmMs: T0 + 7 * D });
  nuvem.ativacoes.set('VELHO999', { clienteId: 'cli-1', usado: false, expiraEmMs: T0 - 1 });
  nuvem.ativacoes.set('USADO123', { clienteId: 'cli-1', usado: true, usadoPorInstallId: 'outro' });
  const lic = new ServicoLicenca({ db, nuvem, versaoApp: '1.0.0' });
  await lic.carregar();
  return { db, nuvem, lic, mudarRelogio: (ms) => { relogioAparelho = ms; } };
}

test('ativação: recusa código errado/usado/expirado; com código válido cria instalação PDV mobile + admin', async (t) => {
  const { db, nuvem, lic } = await preparar();
  t.after(() => lic.pararSincronizacao());
  const dados = { nomeNegocio: 'Mercadinho Boa Vista', adminNome: 'Dona Ana', adminPin: '1234' };
  await assert.rejects(lic.ativar({ ...dados, codigo: 'NAOEXISTE' }), /não encontrado/);
  await assert.rejects(lic.ativar({ ...dados, codigo: 'USADO123' }), /já foi usado/);
  await assert.rejects(lic.ativar({ ...dados, codigo: 'VELHO999' }), /expirou/);
  nuvem.ficarOffline(true);
  await assert.rejects(lic.ativar({ ...dados, codigo: 'ABCD2345' }), /precisa de internet/);
  nuvem.ficarOffline(false);
  const estado = await lic.ativar({ ...dados, codigo: 'abcd-2345' });
  assert.equal(estado.ativado, true);
  const doc = nuvem.instalacoes.get(estado.installId);
  assert.equal(doc.tipo, 'pdv_mobile_autonomo');
  assert.equal(doc.clienteId, 'cli-1');
  assert.equal(doc.backupFrequenciaHoras, 1);
  assert.equal(nuvem.ativacoes.get('ABCD2345').usadoPorInstallId, estado.installId);
  assert.deepEqual((await listarUsuarios(db)).map((u) => [u.nome, u.papel]), [['Dona Ana', 'admin']]);
  assert.equal(lic.status().status, 'ok');
});

test('ativação que caiu no meio (código já resgatado por este aparelho) completa na segunda tentativa', async (t) => {
  const { nuvem, lic } = await preparar();
  t.after(() => lic.pararSincronizacao());
  const criar = nuvem.criarInstalacao;
  nuvem.criarInstalacao = async () => { throw new Error('rede caiu'); };
  await assert.rejects(lic.ativar({ codigo: 'ABCD2345', nomeNegocio: 'Loja', adminNome: 'A', adminPin: '1234' }));
  assert.equal(nuvem.ativacoes.get('ABCD2345').usado, true);
  nuvem.criarInstalacao = criar;
  const estado = await lic.ativar({ codigo: 'ABCD2345', nomeNegocio: 'Loja', adminNome: 'A', adminPin: '1234' });
  assert.equal(estado.installId, nuvem.ativacoes.get('ABCD2345').usadoPorInstallId);
});

test('Central congela / bloqueia em tempo real; a venda em si recusa quando bloqueado', async (t) => {
  const { db, nuvem, lic } = await preparar();
  t.after(() => lic.pararSincronizacao());
  const { installId } = await lic.ativar({ codigo: 'ABCD2345', nomeNegocio: 'Loja', adminNome: 'A', adminPin: '1234' });
  const adminId = (await listarUsuarios(db))[0].id;
  const p = await salvarProduto(db, { nome: 'Água', precoCentavos: 250, estoqueInicialMil: 10000 }, adminId);
  await abrirCaixa(db, { valorAberturaCentavos: 0 }, adminId);
  const vender = () => finalizarVenda(db, { itens: [{ produtoId: p, qtdMil: 1000 }], pagamentos: [{ metodo: 'pix', valorCentavos: 250 }] }, adminId);

  await vender();
  nuvem.painelAltera(installId, { ativo: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lic.status().status, 'aviso');
  await vender(); // ainda na carência

  nuvem.painelAltera(installId, { bloqueioImediato: true, motivoBloqueio: 'Mensalidade em atraso' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lic.status().status, 'bloqueado');
  await assert.rejects(vender(), /Mensalidade em atraso/);

  nuvem.painelAltera(installId, { bloqueioImediato: false, ativo: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lic.status().status, 'ok');
  await vender();
});

test('horário do servidor corrige o relógio; documento apagado é recriado SEM perder o bloqueio', async (t) => {
  let servidor = T0;
  const { nuvem, lic, mudarRelogio } = await preparar({ agoraServidor: () => servidor });
  t.after(() => lic.pararSincronizacao());
  const { installId } = await lic.ativar({ codigo: 'ABCD2345', nomeNegocio: 'Loja', adminNome: 'A', adminPin: '1234' });
  servidor = T0 + 2 * D;
  mudarRelogio(T0 + 2 * D);
  await lic.ping();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(relogioMax(), T0 + 2 * D);
  assert.equal(lic.estado.ultimoContatoOkMs, T0 + 2 * D);
  // Usuário volta o relógio 1 dia: bloqueia mesmo com "1 dia" de prazo aparente.
  mudarRelogio(T0 + 1 * D);
  assert.equal(lic.status().motivo, 'relogio_atrasado');
  mudarRelogio(T0 + 2 * D + H);
  assert.equal(lic.status().status, 'ok');

  nuvem.painelAltera(installId, { bloqueioImediato: true });
  await new Promise((r) => setTimeout(r, 20));
  nuvem.instalacoes.delete(installId); // apagado direto no Firestore
  await lic.verificar();
  assert.equal(nuvem.instalacoes.get(installId).bloqueioImediato, true);
  assert.equal(nuvem.instalacoes.get(installId).recriadoPeloAparelho, true);
});

test('frequência e retenção de backup vêm da Central, com limites (1–24 h, 1–30 dias)', async (t) => {
  const { nuvem, lic } = await preparar();
  t.after(() => lic.pararSincronizacao());
  const { installId } = await lic.ativar({ codigo: 'ABCD2345', nomeNegocio: 'Loja', adminNome: 'A', adminPin: '1234' });
  nuvem.painelAltera(installId, { backupFrequenciaHoras: 6, backupRetencaoDias: 90 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(lic.estado.backupFrequenciaHoras, 6);
  assert.equal(lic.estado.backupRetencaoDias, 30);
});
