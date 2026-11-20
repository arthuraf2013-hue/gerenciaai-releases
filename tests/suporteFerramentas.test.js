const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { freshTestDb, createProduct, createSuporteUser } = require('./helpers/testDb');
const suporte = require('../electron/services/suporteService');
const saleService = require('../electron/services/saleService');

// Ferramentas da aba Suporte: zerar, clonar do servidor, conferir, diagnóstico.

function cenario() {
  const base = freshTestDb();
  const { db, locationId, operadorId } = base;
  const suporteId = createSuporteUser(db);
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'suporte-'));
  suporte._definirPastaBaseParaTeste(pasta);
  fs.mkdirSync(path.join(pasta, 'fotos-produtos'));
  fs.writeFileSync(path.join(pasta, 'fotos-produtos', 'a.jpg'), 'x');
  db.prepare("UPDATE locations SET device_uid = 'uid-da-maquina', numero_pdv = 'PDV002' WHERE id = ?").run(locationId);
  db.prepare("INSERT OR REPLACE INTO license_state (id, status_atual, ultimo_contato_ok) VALUES (1, 'ativa', '2026-11-20 10:00:00')").run();
  db.prepare("INSERT OR REPLACE INTO fiscal_config (id, cnpj, serie_nfce, proximo_numero_nfce) VALUES ('default', '12345678000199', '2', 57)").run();
  createProduct(db, { nome: 'Coca' });
  db.prepare("INSERT INTO customers (id, nome) VALUES ('c1', 'Maria')").run();
  return { ...base, suporteId, pasta };
}

const n = (db, t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

test('só o papel suporte pode zerar', async () => {
  const { operadorId, adminId } = cenario();
  assert.equal((await suporte.zerar({ solicitanteId: operadorId })).ok, false);
  assert.equal((await suporte.zerar({ solicitanteId: adminId })).ok, false);
});

test('pendência (venda aberta) trava o zerar até o suporte mandar descartar', async () => {
  const { db, locationId, operadorId, suporteId } = cenario();
  saleService.openSale({ locationId, operadorId });
  const r = await suporte.zerar({ solicitanteId: suporteId });
  assert.equal(r.ok, false);
  assert.equal(r.pendencias[0].chave, 'vendasAbertas');
  assert.equal(n(db, 'products'), 1, 'nada apagado');
});

test('zerar: apaga os dados, mantém licença, identidade da máquina e numeração da NFC-e; guarda cópia e pastas', async () => {
  const { db, locationId, operadorId, suporteId, pasta } = cenario();
  saleService.openSale({ locationId, operadorId });
  const r = await suporte.zerar({ solicitanteId: suporteId, descartarPendencias: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.reiniciar, true);
  assert.equal(n(db, 'products'), 0);
  assert.equal(n(db, 'customers'), 0);
  assert.equal(n(db, 'sales'), 0);
  const users = db.prepare('SELECT role, pin_temporario FROM users').all();
  assert.deepEqual(users, [{ role: 'admin', pin_temporario: 1 }], 'só o admin de fábrica (PIN 0000), como instalação nova');
  const loc = db.prepare('SELECT id, device_uid, numero_pdv FROM locations').get();
  assert.deepEqual(loc, { id: locationId, device_uid: 'uid-da-maquina', numero_pdv: 'PDV002' });
  assert.equal(db.prepare('SELECT status_atual FROM license_state').get().status_atual, 'ativa');
  assert.equal(db.prepare('SELECT proximo_numero_nfce FROM fiscal_config').get().proximo_numero_nfce, 57);
  assert.ok(fs.existsSync(path.join(pasta, 'backups', r.backup)), 'cópia do banco antes de zerar');
  assert.ok(fs.existsSync(path.join(pasta, 'backups', r.backup.replace('.sqlite3', '-arquivos'), 'fotos-produtos', 'a.jpg')), 'fotos guardadas');
  assert.equal(fs.existsSync(path.join(pasta, 'fotos-produtos')), false);
  const aud = db.prepare("SELECT motivo FROM audit_log WHERE tipo_evento = 'suporte_zerar_instalacao'").get();
  assert.match(aud.motivo, /Pendências descartadas: 1 vendas/);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('clonar: recusa fora de grupo e no servidor', async () => {
  const { db, suporteId } = cenario();
  assert.match((await suporte.clonar({ solicitanteId: suporteId })).error, /não está em um grupo/);
  db.prepare("UPDATE sync_state SET grupo_sincronizacao_id = 'g1', servidor_do_grupo = 1 WHERE id = 'default'").run();
  assert.match((await suporte.clonar({ solicitanteId: suporteId })).error, /é o servidor/);
});

test('clonar: mantém grupo, rede local e impressora deste PC; aplica a configuração da loja do servidor', async () => {
  const { db, suporteId } = cenario();
  db.prepare("UPDATE sync_state SET grupo_sincronizacao_id = 'g1', servidor_do_grupo = 0 WHERE id = 'default'").run();
  db.prepare("INSERT INTO lan_cliente (id, grupo_id, hub_install_id, hub_nome, chave) VALUES ('default', 'g1', 'hub-1', 'PDV1-SERVIDOR', 'k')").run();
  db.prepare("INSERT OR REPLACE INTO receipt_config (id, largura_mm, rodape_texto, impressora_padrao) VALUES ('default', 58, 'antigo', 'EPSON-CAIXA2')").run();
  const configServidor = {
    tabelas: {
      business_profile: [{ id: 'default', perfil_ativo: 'restaurante', config_json: '{}', coluna_que_nao_existe: 1 }],
      receipt_config: [{ id: 'default', largura_mm: 80, rodape_texto: 'Volte sempre', imprimir_automatico: 1, impressora_padrao: 'IMPRESSORA-DO-SERVIDOR' }],
      payment_config: [{ id: 'default', pix_chave: 'pix@loja.com' }],
      categories: [{ id: 'cat1', nome: 'Bebidas', criado_em: '2026-11-01 10:00:00' }],
    },
  };
  const travado = await suporte.zerar({ solicitanteId: suporteId, modo: 'clonar', configServidor });
  assert.equal(travado.pendencias[0].chave, 'cadastrosParaEnviar', 'cadastro que não foi para o grupo trava');
  const r = await suporte.zerar({ solicitanteId: suporteId, modo: 'clonar', configServidor, descartarPendencias: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(db.prepare('SELECT grupo_sincronizacao_id g FROM sync_state').get().g, 'g1');
  assert.equal(n(db, 'lan_cliente'), 1);
  assert.equal(n(db, 'products'), 0, 'produtos chegam pela réplica ao reabrir');
  assert.equal(db.prepare('SELECT perfil_ativo FROM business_profile').get().perfil_ativo, 'restaurante');
  assert.deepEqual(db.prepare('SELECT largura_mm, rodape_texto, impressora_padrao FROM receipt_config').get(),
    { largura_mm: 80, rodape_texto: 'Volte sempre', impressora_padrao: 'EPSON-CAIXA2' });
  assert.equal(db.prepare('SELECT pix_chave FROM payment_config').get().pix_chave, 'pix@loja.com');
  assert.equal(db.prepare('SELECT nome FROM categories').get().nome, 'Bebidas');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE tipo_evento = 'suporte_clonar_servidor'").get());
});

test('configuração da loja do servidor sai com as tabelas da lista', () => {
  cenario();
  const c = suporte.configDaLoja();
  assert.ok(Array.isArray(c.tabelas.business_profile));
  assert.ok(Array.isArray(c.tabelas.receipt_config));
  assert.equal(c.tabelas.products, undefined, 'cadastros vão pela réplica, não por aqui');
});

test('conferir: aponta o que falta aqui e o que só existe aqui', () => {
  const { db } = cenario();
  const coca = db.prepare("SELECT id FROM products WHERE nome = 'Coca'").get().id;
  db.prepare("INSERT INTO grupo_replica (entidade, local_id, grupo_id, doc_id, versao_ms) VALUES ('produtos', ?, 'g1', 'doc-coca', 1)").run(coca);
  createProduct(db, { nome: 'Só no caixa' });
  const r = suporte.comparar(db, 'g1', {
    produtos: [{ doc: 'doc-coca', nome: 'Coca', ativo: true }, { doc: 'doc-pao', nome: 'Pão', ativo: true }, { doc: 'doc-velho', nome: 'Velho', ativo: false }],
    clientes: [],
    usuarios: [],
  });
  assert.equal(r.produtos.noGrupo, 2);
  assert.equal(r.produtos.aqui, 2);
  assert.deepEqual(r.produtos.nomesFaltandoAqui, ['Pão']);
  assert.deepEqual(r.produtos.nomesSoAqui, ['Só no caixa']);
  assert.equal(r.clientes.soAqui, 1);
});

test('diagnóstico fora de grupo vira um relatório legível', async () => {
  cenario();
  const d = await suporte.diagnostico();
  assert.equal(d.grupo.papel, 'fora de grupo');
  assert.equal(d.contagens.produtos, 1);
  const texto = suporte.relatorioEmTexto(d);
  assert.match(texto, /Grupo: - \(fora de grupo\)/);
  assert.match(texto, /1 produtos ativos/);
  assert.match(texto, /Fotos: 0 para enviar \| 0 para baixar/);
  assert.doesNotMatch(texto, /\?/, 'nada de campo com "?"');
  d.grupo = { ...d.grupo, papel: 'servidor', redeLocal: { ligada: true, enderecos: ['192.168.1.74:47820'], caixas: [{ nome: 'PDV2', ultimoContato: '2026-11-20 14:45:51' }] } };
  assert.match(suporte.relatorioEmTexto(d), /PDV2 \(último contato 20\/11\/2026, 11:45:51\)/, 'horário de Brasília');
});

test('pendências: lista o que ainda não saiu deste computador', () => {
  const { db, locationId, operadorId } = cenario();
  assert.deepEqual(suporte.pendencias(), [], 'fora de grupo, fila de cadastro não é pendência');
  saleService.openSale({ locationId, operadorId });
  assert.deepEqual(suporte.pendencias().map((p) => p.chave), ['vendasAbertas']);
  db.prepare("UPDATE sync_state SET grupo_sincronizacao_id = 'g1' WHERE id = 'default'").run();
  db.prepare("INSERT INTO estoque_grupo_pendente (id, grupo_id, product_id, delta, motivo) VALUES ('e1', 'g1', 'p', -1, 'venda')").run();
  assert.deepEqual(suporte.pendencias().map((p) => p.chave).sort(), ['cadastrosParaEnviar', 'estoqueParaEnviar', 'vendasAbertas']);
});
