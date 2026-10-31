const test = require('node:test');
const assert = require('node:assert/strict');
const { freshTestDb, createProduct } = require('./helpers/testDb');
const motor = require('../electron/services/motorTributarioService');
const { REGRAS_PADRAO } = require('../electron/services/regrasTributariasPadrao');
const { garantirGatilhosErp } = require('../electron/db/database');

const ICMS_PE = { nome: 'ICMS interno PE', tributo: 'ICMS', regime: 'lucro_presumido', ufOrigem: 'PE', ufDestino: 'PE', cst: '00', aliquota: 20.5, vigenciaInicio: '2024-01-01' };

test('regras do sistema: semeadas uma vez só, e desativar não é desfeito na próxima abertura', () => {
  const { db } = freshTestDb();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tax_rules WHERE origem = 'sistema'").get().n, REGRAS_PADRAO.length);
  db.prepare("UPDATE tax_rules SET ativo = 0 WHERE id = 'sis-pis-mei'").run();
  garantirGatilhosErp(db); // o que roda a cada abertura
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tax_rules WHERE origem = 'sistema'").get().n, REGRAS_PADRAO.length);
  assert.equal(db.prepare("SELECT ativo FROM tax_rules WHERE id = 'sis-pis-mei'").get().ativo, 0);
  // nenhuma alíquota de ICMS semeada: isso é da loja/contador
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tax_rules WHERE tributo = 'ICMS' AND aliquota > 0").get().n, 0);
});

test('Simples: CSOSN 102 sem ST, 500 na revenda com ST; tudo no DAS, nada destacado', () => {
  freshTestDb();
  const sem = motor.calcularItem({ regime: 'simples_nacional', cfop: '5102', ncm: '22021000', quantidade: 2, precoUnitario: 10, data: '2026-10-31' });
  assert.equal(sem.ok, true);
  const icms = sem.tributos.find((t) => t.tributo === 'ICMS');
  assert.equal(icms.cst, '102');
  assert.equal(icms.recolhidoNoDas, true);
  assert.equal(icms.valor, 0);
  assert.equal(sem.totalDestacado, 0);
  assert.deepEqual(sem.semRegra, []);
  assert.equal(sem.tributos.some((t) => t.tributo === 'IBS' || t.tributo === 'CBS'), false, 'Simples fora do teste de IBS/CBS');
  const st = motor.calcularItem({ regime: 'simples_nacional', cfop: '5405', quantidade: 1, precoUnitario: 10, data: '2026-10-31' });
  assert.equal(st.tributos.find((t) => t.tributo === 'ICMS').cst, '500');
});

test('IBS/CBS de teste só em 2026 e só no regime regular; informativos, fora do total', () => {
  freshTestDb();
  const r = motor.calcularItem({ regime: 'lucro_presumido', quantidade: 1, precoUnitario: 1000, data: '2026-08-10' });
  assert.equal(r.tributos.find((t) => t.tributo === 'CBS').valor, 9);
  assert.equal(r.tributos.find((t) => t.tributo === 'IBS').valor, 1);
  assert.equal(r.totalDestacado, 0);
  assert.deepEqual(r.semRegra.sort(), ['COFINS', 'ICMS', 'PIS']); // regime regular: a loja cadastra
  const em2027 = motor.calcularItem({ regime: 'lucro_presumido', quantidade: 1, precoUnitario: 1000, data: '2027-01-02' });
  assert.equal(em2027.tributos.some((t) => t.tributo === 'CBS'), false);
  assert.ok(em2027.semRegra.includes('CBS'), 'avisa que falta a regra de 2027');
  const em2025 = motor.calcularItem({ regime: 'lucro_presumido', quantidade: 1, precoUnitario: 1000, data: '2025-12-31' });
  assert.equal(em2025.semRegra.includes('CBS'), false, 'antes de 2026 não cobra regra de IBS/CBS');
});

test('a regra mais específica vence; no empate a da loja vence a do sistema', () => {
  freshTestDb();
  assert.equal(motor.criar(ICMS_PE).ok, true);
  const bebida = motor.criar({ ...ICMS_PE, nome: 'ICMS bebidas PE', ncmPrefixo: '2202', aliquota: 22.5 });
  assert.equal(bebida.ok, true);
  const ctx = { regime: 'lucro_presumido', ufOrigem: 'PE', ufDestino: 'PE', quantidade: 1, precoUnitario: 100, data: '2026-10-31' };
  assert.equal(motor.calcularItem({ ...ctx, ncm: '22021000' }).tributos.find((t) => t.tributo === 'ICMS').valor, 22.5);
  assert.equal(motor.calcularItem({ ...ctx, ncm: '19053100' }).tributos.find((t) => t.tributo === 'ICMS').valor, 20.5);
  // loja cria CSOSN 101 genérico para o Simples: mesmo peso da regra do sistema -> vence a da loja
  motor.criar({ nome: 'Simples com crédito', tributo: 'ICMS', regime: 'simples_nacional', cst: '101', recolhidoNoDas: true, vigenciaInicio: '2007-01-01' }); // mais antiga que a do sistema: vence pela origem
  assert.equal(motor.calcularItem({ regime: 'simples_nacional', cfop: '5102', quantidade: 1, precoUnitario: 1, data: '2026-10-31' }).tributos.find((t) => t.tributo === 'ICMS').cst, '101');
  // mas a do sistema mais específica (CFOP 5405) continua valendo para ST
  assert.equal(motor.calcularItem({ regime: 'simples_nacional', cfop: '5405', quantidade: 1, precoUnitario: 1, data: '2026-10-31' }).tributos.find((t) => t.tributo === 'ICMS').cst, '500');
});

test('nova versão encerra a anterior na véspera e cada data usa a versão vigente', () => {
  const { db } = freshTestDb();
  const { id } = motor.criar(ICMS_PE);
  const grupoId = db.prepare('SELECT grupo_id FROM tax_rules WHERE id = ?').get(id).grupo_id;
  const v2 = motor.novaVersao({ grupoId, ...ICMS_PE, aliquota: 21, vigenciaInicio: '2026-04-01' });
  assert.equal(v2.ok, true, v2.error);
  assert.equal(v2.versao, 2);
  assert.equal(db.prepare('SELECT vigencia_fim FROM tax_rules WHERE id = ?').get(id).vigencia_fim, '2026-03-31');
  const ctx = { regime: 'lucro_presumido', ufOrigem: 'PE', ufDestino: 'PE', quantidade: 1, precoUnitario: 100 };
  assert.equal(motor.calcularItem({ ...ctx, data: '2026-03-31' }).tributos.find((t) => t.tributo === 'ICMS').valor, 20.5);
  assert.equal(motor.calcularItem({ ...ctx, data: '2026-04-01' }).tributos.find((t) => t.tributo === 'ICMS').valor, 21);
  assert.equal(motor.novaVersao({ grupoId, ...ICMS_PE, vigenciaInicio: '2026-04-01' }).ok, false, 'precisa começar depois da atual');
  assert.equal(motor.novaVersao({ grupoId, ...ICMS_PE, tributo: 'PIS', vigenciaInicio: '2026-06-01' }).ok, false, 'mesmo tributo');
  assert.equal(motor.listar({ tributo: 'ICMS' }).filter((r) => r.grupo_id === grupoId).length, 2, 'histórico fica');
});

test('base reduzida, ICMS-ST com MVA descontando o ICMS próprio e desconto do item', () => {
  freshTestDb();
  motor.criar({ ...ICMS_PE, aliquota: 18, reducaoBase: 10 });
  motor.criar({ nome: 'ST PE', tributo: 'ICMS_ST', regime: 'lucro_presumido', ufOrigem: 'PE', ufDestino: 'PE', mva: 40, aliquotaInternaDestino: 18, vigenciaInicio: '2024-01-01' });
  const r = motor.calcularItem({ regime: 'lucro_presumido', ufOrigem: 'PE', ufDestino: 'PE', quantidade: 2, precoUnitario: 55, desconto: 10, data: '2026-10-31' });
  assert.equal(r.baseOperacao, 100);
  const icms = r.tributos.find((t) => t.tributo === 'ICMS');
  assert.equal(icms.base, 90);
  assert.equal(icms.valor, 16.2);
  const st = r.tributos.find((t) => t.tributo === 'ICMS_ST');
  assert.equal(st.base, 140);
  assert.equal(st.valor, 9); // 140 x 18% = 25,20 - 16,20 próprio
  assert.equal(motor.calcularItem({ quantidade: 1, precoUnitario: 5, desconto: 6 }).ok, false);
});

test('validação: UF, CFOP, NCM, alíquota e vigência inválidos são recusados', () => {
  freshTestDb();
  const casos = [
    { ufDestino: 'XX' }, { cfop: '9102' }, { ncmPrefixo: '2' }, { aliquota: 101 }, { reducaoBase: 100 },
    { vigenciaInicio: '2026-02-30' }, { vigenciaInicio: '2026-13-01' }, { vigenciaFim: '2023-01-01' }, { tributo: 'DIFAL' }, { cclassTrib: '123' }, { nome: '' },
  ];
  for (const c of casos) assert.equal(motor.criar({ ...ICMS_PE, ...c }).ok, false, JSON.stringify(c));
  assert.equal(motor.criar({ nome: 'ST sem alíquota', tributo: 'ICMS_ST', mva: 30, vigenciaInicio: '2026-01-01' }).ok, false);
});

test('simulação do produto usa o cadastro e aponta CSOSN divergente; DIFAL é avisado, não inventado', () => {
  const { db } = freshTestDb();
  db.prepare(`INSERT INTO fiscal_config (id, regime_tributario, uf) VALUES ('default', 'simples_nacional', 'PE')
              ON CONFLICT(id) DO UPDATE SET regime_tributario = 'simples_nacional', uf = 'PE'`).run();
  const pid = createProduct(db, { preco: 12 });
  db.prepare("UPDATE products SET ncm = '22021000', cfop = '5102', cst_csosn = '500' WHERE id = ?").run(pid);
  const r = motor.simularProduto({ productId: pid, quantidade: 1, data: '2026-10-31' });
  assert.equal(r.ok, true);
  assert.equal(r.baseOperacao, 12);
  assert.match(r.divergencias[0], /500.*102/);
  const inter = motor.simularProduto({ productId: pid, ufDestino: 'BA', perfilCliente: 'nao_contribuinte', data: '2026-10-31' });
  assert.ok(inter.avisos.some((a) => /DIFAL/.test(a)));
  assert.equal(motor.simularProduto({ productId: 'nao-existe' }).ok, false);
});

test('regra desativada deixa de valer e some da lista padrão', () => {
  freshTestDb();
  const { id } = motor.criar(ICMS_PE);
  assert.equal(motor.desativar({ id }).ok, true);
  assert.equal(motor.desativar({ id }).ok, false);
  const r = motor.calcularItem({ regime: 'lucro_presumido', ufOrigem: 'PE', ufDestino: 'PE', quantidade: 1, precoUnitario: 100, data: '2026-10-31' });
  assert.equal(r.tributos.some((t) => t.tributo === 'ICMS'), false);
  assert.equal(motor.listar({ tributo: 'ICMS' }).some((x) => x.id === id), false);
  assert.equal(motor.listar({ tributo: 'ICMS', incluirInativas: true }).some((x) => x.id === id), true);
});
