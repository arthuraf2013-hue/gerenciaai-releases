const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { freshTestDb } = require('./helpers/testDb');

const mc = require('../electron/services/mesaCompartilhadaService');
const cont = require('../electron/services/mesaContingenciaService');

// Pedido de envio da fila com outro envio ainda em andamento: o que está
// rodando pode ter começado com o servidor fora (e parado no 1º erro). Quem
// pediu tem de esperar e mandar DE NOVO, não receber o resultado velho.
// (No GitHub, o envio de antes ainda estava rodando quando o servidor voltou.)
test('drenar no meio de outro envio: espera e manda de novo, com o servidor que voltou', async (t) => {
  const { db } = freshTestDb();
  for (let i = 0; i < 3; i++) {
    db.prepare("INSERT INTO mesa_fila_offline (id, hub_id, canal, args_json, meta_json, usuario_id) VALUES (?, NULL, 'sale:addItem', '{}', '{}', NULL)").run(randomUUID());
  }
  const original = { chamar: mc.chamarNoServidor, avisar: mc.avisarTelasDaqui };
  t.after(() => { mc.chamarNoServidor = original.chamar; mc.avisarTelasDaqui = original.avisar; });
  mc.avisarTelasDaqui = () => {};
  let servidorNoAr = false;
  let soltarPrimeira;
  const primeiraTravada = new Promise((r) => { soltarPrimeira = r; });
  let chamadas = 0;
  mc.chamarNoServidor = async () => {
    chamadas += 1;
    if (chamadas === 1) { await primeiraTravada; return { ok: false, rede: true, error: 'servidor fora' }; } // envio antigo, esperando a rede
    return servidorNoAr ? { ok: true } : { ok: false, rede: true, error: 'servidor fora' };
  };

  const antigo = cont.drenar(); // começou com o servidor fora
  await new Promise((r) => setImmediate(r));
  servidorNoAr = true; // o servidor voltou enquanto o antigo ainda esperava
  const novo = cont.drenar();
  soltarPrimeira();
  const rAntigo = await antigo;
  // O antigo pegou "servidor fora" na resposta que estava esperando: parou.
  assert.equal(rAntigo.enviados, 0);
  const r = await novo;
  assert.equal(r.restantes, 0, 'mandou tudo de novo depois que o antigo parou');
  assert.equal(r.enviados, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mesa_fila_offline WHERE estado = 'pendente'").get().n, 0);
  // A falha anotada pelo envio antigo não deixa o caixa preso no modo sem servidor.
  assert.equal(cont.podeTentar(), true, 'saiu do modo sem servidor');
  assert.equal(cont.offlineAgora(), false);
});
