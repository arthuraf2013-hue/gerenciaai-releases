const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const os = require('os');
const { freshTestDb, createSuporteUser } = require('./helpers/testDb');
const permissaoService = require('../electron/services/permissaoService');

// Permissões finas do ERP + canais do motor tributário, passando pela
// mesma política de acesso do app (ipcMain falso, como nos outros testes).
const canais = new Map();
const electronFalso = {
  ipcMain: { handle: (canal, fn) => canais.set(canal, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
  BrowserWindow: { getFocusedWindow: () => null },
  shell: { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} },
  app: { getVersion: () => '0.0.0-teste', getPath: () => os.tmpdir() },
};
const loadOriginal = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronFalso;
  return loadOriginal.call(this, request, parent, isMain);
};
const { registerIpcHandlers } = require('../electron/ipc/handlers');
const sessionService = require('../electron/services/sessionService');
registerIpcHandlers();
Module._load = loadOriginal;
const chamar = (canal, payload, id) => canais.get(canal)({ sender: { id } }, payload);

test('sem restrição nada muda: gerente abre tudo do ERP (instalação antiga continua igual)', async () => {
  const { gerenteId, locationId } = freshTestDb();
  sessionService.iniciarSessao(31, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  const st = await chamar('erp:status', undefined, 31);
  assert.deepEqual(st.permissoes, { compras: true, financeiro: true, estoque: true, fiscal: true });
  assert.equal((await chamar('assistenteFiscal:painel', { locationId }, 31)).ok, true);
});

test('admin retira o fiscal de um gerente: canais do fiscal e do motor recusam, o resto segue; fica na Auditoria', async () => {
  const { db, adminId, gerenteId, locationId } = freshTestDb();
  sessionService.iniciarSessao(32, { id: adminId, nome: 'Adm', role: 'admin' });
  sessionService.iniciarSessao(33, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  const r = await chamar('permissao:salvar', { usuarioId: gerenteId, permissoes: { 'erp.fiscal': false } }, 32);
  assert.equal(r.ok, true, r.error);
  for (const canal of ['assistenteFiscal:painel', 'tributacao:listar', 'tributacao:calcularItem']) {
    const x = await chamar(canal, { locationId }, 33);
    assert.equal(x.ok, false, canal);
    assert.equal(x.semPermissao, true, canal);
  }
  assert.equal((await chamar('financeiro:fluxoDeCaixa', { locationId, dataInicio: '2026-10-01', dataFim: '2026-10-31' }, 33)).ok, true);
  assert.equal((await chamar('erp:status', undefined, 33)).permissoes.fiscal, false);
  const ev = db.prepare("SELECT * FROM audit_log WHERE tipo_evento = 'permissao_erp_alterada'").get();
  assert.equal(ev.solicitante_id, adminId);
  assert.match(ev.motivo, /retirado/);
  // devolver
  assert.equal((await chamar('permissao:salvar', { usuarioId: gerenteId, permissoes: { 'erp.fiscal': true } }, 32)).ok, true);
  assert.equal((await chamar('tributacao:listar', {}, 33)).ok, true);
});

test('gerente não muda permissão (nem a própria); admin e suporte nunca ficam restritos', async () => {
  const { db, adminId, gerenteId } = freshTestDb();
  const suporteId = createSuporteUser(db);
  sessionService.iniciarSessao(34, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  const r = await chamar('permissao:salvar', { usuarioId: gerenteId, permissoes: { 'erp.fiscal': true } }, 34);
  assert.equal(r.ok, false);
  assert.match(r.error, /permissão/);
  assert.equal(permissaoService.salvar({ usuarioId: adminId, permissoes: { 'erp.fiscal': false } }).ok, false);
  // mesmo uma linha gravada direto no banco não restringe admin/suporte
  db.prepare("INSERT INTO user_permission_overrides (user_id, permissao, permitido) VALUES (?, 'erp.financeiro', 0), (?, 'erp.financeiro', 0)").run(adminId, suporteId);
  assert.equal(permissaoService.temPermissao(adminId, 'erp.financeiro'), true);
  assert.equal(permissaoService.temPermissao(suporteId, 'erp.financeiro'), true);
  assert.equal(permissaoService.salvar({ usuarioId: gerenteId, permissoes: { 'erp.inexistente': false } }).ok, false);
});

test('operador continua barrado pelo papel antes de chegar na permissão', async () => {
  const { operadorId } = freshTestDb();
  sessionService.iniciarSessao(35, { id: operadorId, nome: 'Op', role: 'operador' });
  for (const canal of ['tributacao:listar', 'tributacao:criar', 'permissao:salvar', 'permissao:doUsuario']) {
    const r = await chamar(canal, {}, 35);
    assert.equal(r.ok, false, canal);
    assert.match(r.error, /permissão/, canal);
  }
});

test('toda área do catálogo cobre canais que existem (prefixo errado não passa batido)', () => {
  for (const [chave, p] of Object.entries(permissaoService.PERMISSOES)) {
    for (const c of p.canais) {
      const existe = [...canais.keys()].some((k) => (c.endsWith(':') ? k.startsWith(c) : k === c));
      assert.ok(existe, `${chave}: ${c}`);
    }
  }
  assert.equal(permissaoService.permissaoDoCanal('custoMedio:historico'), null, 'custo médio não é área paga nem restringível');
  assert.equal(permissaoService.permissaoDoCanal('erp:status'), null, 'status precisa responder para mostrar o aviso certo');
});

test('motor tributário pelo IPC: criar com módulo ativo fica na Auditoria; módulo fiscal desligado recusa', async () => {
  const { db, gerenteId } = freshTestDb();
  sessionService.iniciarSessao(36, { id: gerenteId, nome: 'Ger', role: 'gerente' });
  const r = await chamar('tributacao:criar', { nome: 'ICMS PE', tributo: 'ICMS', regime: 'lucro_presumido', ufOrigem: 'PE', aliquota: 20.5, vigenciaInicio: '2026-01-01', operadorId: 'alguem-falso' }, 36);
  assert.equal(r.ok, true, r.error);
  assert.equal(db.prepare('SELECT criado_por FROM tax_rules WHERE id = ?').get(r.id).criado_por, gerenteId); // vem da sessão
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE tipo_evento = 'regra_tributaria_criada' AND solicitante_id = ?").get(gerenteId));
  db.prepare(`INSERT INTO modulos_pagos_state (id, cliente_id, erp_fiscal, ja_sincronizado) VALUES ('default', 'c1', 0, 1)
              ON CONFLICT(id) DO UPDATE SET erp_fiscal = 0, ja_sincronizado = 1`).run();
  const off = await chamar('tributacao:listar', {}, 36);
  assert.equal(off.moduloInativo, true);
});
