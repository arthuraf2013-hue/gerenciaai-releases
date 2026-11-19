// Servidor do grupo em outro processo (outro banco), para o teste da mesa
// compartilhada. Recebe comandos JSON (uma linha cada) e responde uma linha.
const bcrypt = require('bcryptjs');
const { freshTestDb, createProduct, addStock } = require('./testDb');
const { db, locationId } = freshTestDb();
const G = process.env.GRUPO_TESTE;
db.prepare('UPDATE sync_state SET grupo_sincronizacao_id = ?, servidor_do_grupo = 1 WHERE id = ?').run(G, 'default');
require('../../electron/services/pdvRegistryService').getOrCreateDeviceUid = () => 'servidor-mesa-0001';
require('../../electron/services/licenseService').nomeDoComputador = () => 'PDV1-SERVIDOR';
const armazem = require('../../electron/services/lanArmazemService');
armazem.gravarMeta(`espelho_pronto:${G}`, '1');
armazem.gravarMeta('hub_grupo', G);

// Mesmos usuários e produtos do caixa, com ids daqui diferentes (como na vida real).
const usuario = (id, nome, role, pin, doc) => {
  db.prepare('INSERT INTO users (id, nome, role, pin_hash) VALUES (?, ?, ?, ?)').run(id, nome, role, bcrypt.hashSync(pin, 4));
  db.prepare('INSERT INTO user_group_sync (user_id, grupo_id, doc_id, versao_ms) VALUES (?, ?, ?, 1)').run(id, G, doc);
};
usuario('srv-operador', 'Geyse', 'operador', '1111', 'doc-operador');
usuario('srv-gerente', 'Gerente', 'gerente', '2222', 'doc-gerente');
const produto = (nome, preco, doc, extra = {}) => {
  const id = createProduct(db, { nome, preco, ...extra });
  db.prepare(`INSERT INTO grupo_replica (entidade, local_id, grupo_id, doc_id, versao_ms) VALUES ('produtos', ?, ?, ?, 1)`).run(id, G, doc);
  addStock(db, { productId: id, locationId, quantidade: 50, operadorId: 'srv-gerente' });
  return id;
};
const ids = {
  suco: produto('Suco', 8, 'doc-suco'),
  caldinho: produto('Caldinho de charque', 12, 'doc-caldinho'),
  agua: produto('Água', 4, 'doc-agua'),
};
db.prepare(`INSERT INTO customers (id, nome) VALUES ('srv-cliente', 'Maria')`).run();
db.prepare(`INSERT INTO grupo_replica (entidade, local_id, grupo_id, doc_id, versao_ms) VALUES ('clientes', 'srv-cliente', ?, 'doc-maria', 1)`).run(G);
const tableService = require('../../electron/services/tableService');
const mesas = {};
for (const n of ['1', '2', '3', '4']) mesas[n] = tableService.createTable({ locationId, numero: n }).id;

const hub = require('../../electron/services/lanHubService');
const mc = require('../../electron/services/mesaCompartilhadaService');
const saleService = require('../../electron/services/saleService');
(async () => {
  const porta = await hub.ligar({ grupoId: G, hubId: 'servidor-mesa-0001', nome: 'PDV1-SERVIDOR' }, { portaPreferida: 0, descoberta: false, host: '127.0.0.1' });
  const { codigo } = hub.gerarCodigo();
  process.stdout.write(JSON.stringify({ porta, codigo, mesas, ids, locationId }) + '\n');
  let buf = '';
  process.stdin.on('data', (b) => {
    buf += b.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const c = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      let r;
      try {
        if (c.cmd === 'sql') r = db.prepare(c.sql).all(...(c.params || []));
        else if (c.cmd === 'run') r = db.prepare(c.sql).run(...(c.params || []));
        else if (c.cmd === 'trava') r = mc.recusaPorTrava(c.canal, c.payload);
        else if (c.cmd === 'celular') r = mc.travaDoComandoCelular(c.dados);
        else if (c.cmd === 'addItemDireto') r = saleService.addItem({ ...c.args, locationId, operadorId: 'srv-operador', deviceId: 'qr' });
        else if (c.cmd === 'pagarAqui') {
          saleService.addPayment({ saleId: c.saleId, metodo: 'dinheiro', valor: c.valor });
          r = { ok: true };
        } else if (c.cmd === 'destravar') r = mc.destravar({ tableId: c.tableId, operadorId: 'srv-gerente' });
        else if (c.cmd === 'codigo') r = hub.gerarCodigo();
      } catch (err) { r = { erro: err.message }; }
      process.stdout.write(JSON.stringify({ r: r === undefined ? null : r }) + '\n');
    }
  });
})();
