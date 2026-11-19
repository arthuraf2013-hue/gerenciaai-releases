// Servidor do grupo em outro processo (outro banco), para o teste de rede local.
const { freshTestDb } = require('./testDb');
const { db } = freshTestDb();
const G = process.env.GRUPO_TESTE;
db.prepare('UPDATE sync_state SET grupo_sincronizacao_id = ?, servidor_do_grupo = 1 WHERE id = ?').run(G, 'default');
require('../../electron/services/pdvRegistryService').getOrCreateDeviceUid = () => 'servidor-teste-0001';
require('../../electron/services/licenseService').nomeDoComputador = () => 'SERVIDOR-TESTE';
const armazem = require('../../electron/services/lanArmazemService');
armazem.gravarMeta(`espelho_pronto:${G}`, '1'); // sem nuvem no teste: cópia já "pronta"
armazem.gravarMeta('hub_grupo', G);
armazem.contadorDaNuvem(G, 'prod-ultima', 1); // uma unidade só
const hub = require('../../electron/services/lanHubService');
(async () => {
  const porta = await hub.ligar({ grupoId: G, hubId: 'servidor-teste-0001', nome: 'SERVIDOR-TESTE' }, { portaPreferida: 0, descoberta: false, host: '127.0.0.1' });
  const { codigo } = hub.gerarCodigo();
  process.stdout.write(JSON.stringify({ porta, codigo }) + '\n');
  process.stdin.on('data', (b) => {
    const cmd = b.toString().trim();
    if (cmd === 'codigo') process.stdout.write(JSON.stringify({ codigo: hub.gerarCodigo().codigo }) + '\n');
    if (cmd === 'caixas') process.stdout.write(JSON.stringify({ caixas: hub.listarCaixas().length }) + '\n');
    if (cmd === 'estoque') process.stdout.write(JSON.stringify({ estoque: [...armazem.lerContadores(G)] }) + '\n');
  });
})();
