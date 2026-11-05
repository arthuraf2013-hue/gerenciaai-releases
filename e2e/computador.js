// "Computador da loja" para o teste de ponta a ponta: os serviços de verdade
// do GerenciaAI (pareamento, status ao vivo, PDV móvel, mesas pelo celular)
// com um SQLite de teste, falando com os emuladores do Firebase.
const http = require('http');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { initializeApp } = require('firebase/app');
const F = require('firebase/firestore');
const { freshTestDb, createProduct, addStock } = require('../tests/helpers/testDb');

const PROJETO = 'gerenciaai-licencas';
const INSTALL = 'pc-e2e';

const app = initializeApp({ projectId: PROJETO, apiKey: 'fake' }, 'computador');
const fs = F.getFirestore(app);
F.connectFirestoreEmulator(fs, '127.0.0.1', 8080);

require('../electron/services/licenseService').getLicenseFirestore = () => fs;
require('../electron/services/pdvRegistryService').getOrCreateDeviceUid = () => INSTALL;

async function semearFirestore() {
  const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
  const env = await initializeTestEnvironment({ projectId: PROJETO, firestore: { host: '127.0.0.1', port: 8080 } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await db.doc(`installations/${INSTALL}`).set({ clienteId: 'cli-e2e', ativo: true });
    await db.doc('clientes/cli-e2e').set({ modulosAtivos: { consultaRemota: true, appGarcom: true, pdvMobile: true } });
  });
}

async function main() {
  await semearFirestore();
  const ctx = freshTestDb();
  const { db } = ctx;
  ctx.garcomId = randomUUID();
  db.prepare(`INSERT INTO users (id, nome, role, pin_hash) VALUES (?, 'Rafa Garçom', 'garcom', ?)`).run(ctx.garcomId, bcrypt.hashSync('2468', 10));
  const produtos = [['Prato feito', 30, 'Pratos'], ['Suco', 8, 'Bebidas'], ['Água', 4.5, 'Bebidas'], ['Pudim', 12, 'Sobremesas']];
  for (const [nome, preco, categoria] of produtos) {
    const id = createProduct(db, { nome, preco, categoria });
    if (nome !== 'Pudim') addStock(db, { productId: id, locationId: ctx.locationId, quantidade: 50, operadorId: ctx.adminId });
  }
  const tableService = require('../electron/services/tableService');
  for (const n of ['1', '2', '3', '4']) tableService.createTable({ locationId: ctx.locationId, numero: n });
  require('../electron/services/cashService').openSession({ locationId: ctx.locationId, operadorId: ctx.gerenteId, valorAbertura: 100 });

  require('../electron/services/pairingService').iniciarEscutaPareamentos();
  require('../electron/services/pdvMobileSyncService').iniciarPdvMobile();
  require('../electron/services/mesaCelularService').iniciar();
  const live = require('../electron/services/liveStatusSyncService');

  const json = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/codigo') {
        const tipo = url.searchParams.get('tipo');
        const vinculoUserId = tipo === 'garcom' ? ctx.garcomId : ctx.operadorId;
        return json(res, await require('../electron/services/pairingService').gerarCodigo({ tipo, vinculoUserId, requestingUserId: ctx.gerenteId }));
      }
      if (url.pathname === '/publicar') {
        await live.publicarStatusAoVivo();
        await require('../electron/services/pdvMobileConfigService').publicarConfig();
        return json(res, { ok: true });
      }
      if (url.pathname === '/cozinha') {
        const r = db.prepare(
          `UPDATE sale_items SET status_preparo = ? WHERE cancelado = 0 AND product_id = (SELECT id FROM products WHERE nome = ?)`
        ).run(url.searchParams.get('status'), url.searchParams.get('nome'));
        return json(res, { ok: true, mudou: r.changes });
      }
      if (url.pathname === '/estado') {
        return json(res, {
          mesas: db.prepare('SELECT numero, status, sale_id, pessoas FROM restaurant_tables ORDER BY numero').all(),
          vendas: db.prepare('SELECT id, status, operador_id, total, taxa_servico_percentual FROM sales').all(),
          itens: db.prepare(
            `SELECT p.nome, si.quantidade, si.pessoa_numero, si.observacao, si.status_preparo, si.cancelado, si.sale_id
             FROM sale_items si JOIN products p ON p.id = si.product_id ORDER BY si.rowid`
          ).all(),
          pessoas: db.prepare('SELECT sale_id, numero, nome FROM sale_people ORDER BY numero').all(),
          pagamentos: db.prepare('SELECT metodo, valor, detalhes FROM payments ORDER BY rowid').all(),
          dispositivos: db.prepare('SELECT id, tipo, ativo FROM paired_devices').all(),
          comandos: db.prepare('SELECT tipo, ok, erro FROM mobile_comandos_mesa ORDER BY criado_em, rowid').all(),
          auditoria: db.prepare(`SELECT tipo_evento, sucesso FROM audit_log WHERE tipo_evento LIKE 'cancelamento%'`).all(),
          tentativasGerente: db.prepare('SELECT tentativas_falhas FROM users WHERE id = ?').get(ctx.gerenteId).tentativas_falhas,
        });
      }
      res.writeHead(404); res.end();
    } catch (err) {
      console.error(err);
      res.writeHead(500); res.end(String(err.stack || err));
    }
  }).listen(7070, () => console.log('COMPUTADOR PRONTO'));
}

main().catch((err) => { console.error(err); process.exit(1); });
