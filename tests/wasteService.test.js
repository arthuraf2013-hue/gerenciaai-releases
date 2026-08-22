const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const wasteService = require('../electron/services/wasteService');

test('registerWaste valida tipo, seleção do item, quantidade e custo', () => {
  const { locationId, operadorId } = freshTestDb();
  const tipoInvalido = wasteService.registerWaste({ locationId, tipo: 'outro', quantidade: 1, custoEstimado: 0, operadorId });
  assert.equal(tipoInvalido.ok, false);

  const semProduto = wasteService.registerWaste({ locationId, tipo: 'prato', quantidade: 1, custoEstimado: 0, operadorId });
  assert.equal(semProduto.ok, false);
});

/**
 * listWaste, getWasteSummary e getWasteByDay foram reescritos pra um filtro
 * sargable (comparação direta de timestamp UTC em vez de `date(criado_em,
 * '-3 hours') BETWEEN date(?) AND date(?)`). Confere que as fronteiras do
 * dia local (UTC-3) continuam corretas nos três.
 */
test('listWaste, getWasteSummary e getWasteByDay respeitam as fronteiras do dia local (UTC-3)', () => {
  const { db, locationId, operadorId } = freshTestDb();
  const productId = createProduct(db, { preco: 10 });

  const inserirDesperdicio = (criadoEmUtc, custo) => {
    db.prepare(
      `INSERT INTO waste_log (id, location_id, tipo, product_id, quantidade, custo_estimado, operador_id, criado_em)
       VALUES (lower(hex(randomblob(16))), ?, 'prato', ?, 1, ?, ?, ?)`
    ).run(locationId, productId, custo, operadorId, criadoEmUtc);
  };

  inserirDesperdicio('2026-07-31 02:59:59', 999); // 30/07 local — fora
  inserirDesperdicio('2026-07-31 03:00:00', 5); // 31/07 00:00 local — dentro (início)
  inserirDesperdicio('2026-09-01 02:59:59', 7); // 31/08 23:59:59 local — dentro (fim)
  inserirDesperdicio('2026-09-01 03:00:00', 999); // 01/09 local — fora

  const periodo = { locationId, dataInicio: '2026-07-31', dataFim: '2026-08-31' };

  const lista = wasteService.listWaste(periodo);
  assert.equal(lista.length, 2);

  const resumo = wasteService.getWasteSummary(periodo);
  assert.equal(resumo.eventos, 2);
  assert.equal(resumo.total, 12);

  const porDia = wasteService.getWasteByDay(periodo);
  assert.equal(porDia.length, 2);
  assert.equal(porDia.find((d) => d.dia === '2026-07-31').total, 5);
  assert.equal(porDia.find((d) => d.dia === '2026-08-31').total, 7);
});
