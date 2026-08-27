const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Testes das regras em firestore.rules — cobrem só a Parte 2 (pareamento
 * de celular, pedidos do garçom, status ao vivo), que são as regras de
 * verdade deste arquivo. A Parte 1 (superfície antiga, read/write livre
 * pra preservar comportamento) não precisa de teste — ela é
 * deliberadamente "se resource existe, todo mundo pode", não tem lógica
 * nenhuma pra quebrar.
 *
 * PRECISA DO EMULADOR DO FIRESTORE RODANDO (não executado neste ambiente
 * de desenvolvimento — sem rota de rede até o download do emulador
 * aqui). @firebase/rules-unit-testing já está no package.json
 * (devDependencies) -- falta só o emulador em si. Pra rodar de verdade:
 *   1. npm install -g firebase-tools
 *   2. firebase emulators:start --only firestore  (num terminal)
 *   3. FIRESTORE_EMULATOR_HOST=localhost:8080 node --test tests/firestoreRules.test.js
 * Sem a variável de ambiente acima, todo teste deste arquivo é pulado
 * (skip), pra não quebrar `npm test` em quem não tem o emulador.
 */

const RODAR = !!process.env.FIRESTORE_EMULATOR_HOST;
const SKIP_MSG = 'defina FIRESTORE_EMULATOR_HOST e rode `firebase emulators:start --only firestore` pra rodar este arquivo';

let testEnv;
let assertSucceeds, assertFails;

async function setupTestEnv() {
  if (testEnv) return testEnv;
  const fs = require('fs');
  const path = require('path');
  const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
  ({ assertSucceeds, assertFails } = require('@firebase/rules-unit-testing'));

  testEnv = await initializeTestEnvironment({
    projectId: 'gerenciaai-rules-test',
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf-8'),
    },
  });
  return testEnv;
}

async function seed(installId, { pareamentoUsado = false, garcomVinculoId = 'user-garcom-1' } = {}) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc(`installations/${installId}/pareamentos/111111`).set({
      codigo: '111111', tipo: 'garcom', installId, vinculoUserId: garcomVinculoId,
      nomeNegocio: 'Loja Teste', vinculoNome: 'Garçom 1',
      usado: pareamentoUsado, usadoPorUid: pareamentoUsado ? 'algum-uid-anterior' : null,
      expiraEm: new Date(Date.now() + 10 * 60 * 1000),
    });
    await db.doc(`installations/${installId}/pareamentos/222222`).set({
      codigo: '222222', tipo: 'consulta', installId, vinculoUserId: 'user-admin-1',
      nomeNegocio: 'Loja Teste', vinculoNome: 'Admin 1',
      usado: false, usadoPorUid: null,
      expiraEm: new Date(Date.now() + 10 * 60 * 1000),
    });
  });
}

test.after(async () => { if (testEnv) await testEnv.cleanup(); });

test('desktop (sem autenticação) pode publicar um código de pareamento', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-A');
  const desktop = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(desktop.doc('installations/install-A/pareamentos/333333').set({
    codigo: '333333', tipo: 'garcom', installId: 'install-A', vinculoUserId: 'user-garcom-2',
    usado: false, expiraEm: new Date(Date.now() + 10 * 60 * 1000),
  }));
});

test('celular sem autenticar não consegue ler um código de pareamento', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-B');
  const semAuth = testEnv.unauthenticatedContext().firestore();
  await assertFails(semAuth.doc('installations/install-B/pareamentos/111111').get());
});

test('celular autenticado (mesmo anônimo) consegue ler um código de pareamento', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-C');
  const celular = testEnv.authenticatedContext('uid-garcom-1').firestore();
  await assertSucceeds(celular.doc('installations/install-C/pareamentos/111111').get());
});

test('celular consegue resgatar um código válido (marcar usado, se atribuindo)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-D');
  const celular = testEnv.authenticatedContext('uid-garcom-2').firestore();
  await assertSucceeds(celular.doc('installations/install-D/pareamentos/111111').update({
    usado: true, usadoPorUid: 'uid-garcom-2',
  }));
});

test('resgate falha se o código já foi usado', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-E', { pareamentoUsado: true });
  const celular = testEnv.authenticatedContext('uid-garcom-3').firestore();
  await assertFails(celular.doc('installations/install-E/pareamentos/111111').update({
    usado: true, usadoPorUid: 'uid-garcom-3',
  }));
});

test('resgate falha se tentar mudar outro campo além de usado/usadoPorUid/usadoEm', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-F');
  const celular = testEnv.authenticatedContext('uid-garcom-4').firestore();
  await assertFails(celular.doc('installations/install-F/pareamentos/111111').update({
    usado: true, usadoPorUid: 'uid-garcom-4', tipo: 'consulta',
  }));
});

test('criar dispositivos/{uid} funciona quando o código é válido e os dados batem', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-G', { garcomVinculoId: 'user-garcom-9' });
  const celular = testEnv.authenticatedContext('uid-garcom-5').firestore();
  await assertSucceeds(celular.doc('installations/install-G/dispositivos/uid-garcom-5').set({
    tipo: 'garcom', vinculoUserId: 'user-garcom-9', pareamentoCodigo: '111111',
    nomeDispositivo: 'Celular do João', ativo: true,
  }));
});

test('criar dispositivos/{uid} falha se o uid do documento não é o do próprio autenticado', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-H', { garcomVinculoId: 'user-garcom-9' });
  const celular = testEnv.authenticatedContext('uid-garcom-6').firestore();
  await assertFails(celular.doc('installations/install-H/dispositivos/uid-de-outra-pessoa').set({
    tipo: 'garcom', vinculoUserId: 'user-garcom-9', pareamentoCodigo: '111111', ativo: true,
  }));
});

test('criar dispositivos/{uid} falha se o código já foi usado', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-I', { pareamentoUsado: true });
  const celular = testEnv.authenticatedContext('uid-garcom-7').firestore();
  await assertFails(celular.doc('installations/install-I/dispositivos/uid-garcom-7').set({
    tipo: 'garcom', vinculoUserId: 'user-garcom-1', pareamentoCodigo: '111111', ativo: true,
  }));
});

// Firestore trata set() num documento que JÁ EXISTE como "update", não
// "create" -- então re-parear um uid que já tinha um dispositivo aqui
// antes (ex: foi revogado, e o gerente emitiu um código novo pra mesma
// pessoa) passa pela regra de UPDATE, não pela de CREATE. Sem tratar
// esse caso explicitamente na regra, esse fluxo ficaria travado pra
// sempre depois da primeira revogação.
test('re-parear um dispositivo já existente (revogado) com um código novo funciona via update', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-J2', { garcomVinculoId: 'user-garcom-9' });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-J2/dispositivos/uid-recontratado').set({
      tipo: 'garcom', vinculoUserId: 'user-garcom-9', pareamentoCodigo: 'codigo-antigo-ja-gasto', ativo: false,
    });
  });
  const celular = testEnv.authenticatedContext('uid-recontratado').firestore();
  await assertSucceeds(celular.doc('installations/install-J2/dispositivos/uid-recontratado').set({
    tipo: 'garcom', vinculoUserId: 'user-garcom-9', pareamentoCodigo: '111111', ativo: true,
  }));
});

test('re-parear um dispositivo existente falha se o código novo não corresponde ao tipo/vínculo dele', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-J3', { garcomVinculoId: 'user-garcom-9' }); // 222222 é 'consulta', vinculado a user-admin-1
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-J3/dispositivos/uid-recontratado-2').set({
      tipo: 'garcom', vinculoUserId: 'user-garcom-9', pareamentoCodigo: 'codigo-antigo-ja-gasto', ativo: false,
    });
  });
  const celular = testEnv.authenticatedContext('uid-recontratado-2').firestore();
  await assertFails(celular.doc('installations/install-J3/dispositivos/uid-recontratado-2').set({
    tipo: 'consulta', vinculoUserId: 'user-garcom-9', pareamentoCodigo: '222222', ativo: true,
  }));
});

test('status_ao_vivo: leitura negada pra celular sem dispositivo pareado nesta loja', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('installations/install-J/status_ao_vivo/atual').set({ resumoHoje: { faturamentoHoje: 100 } });
  });
  const celular = testEnv.authenticatedContext('uid-sem-vinculo').firestore();
  await assertFails(celular.doc('installations/install-J/status_ao_vivo/atual').get());
});

test('status_ao_vivo: leitura permitida pra dispositivo pareado e ativo', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-K/status_ao_vivo/atual').set({ resumoHoje: { faturamentoHoje: 100 } });
    await db.doc('installations/install-K/dispositivos/uid-pareado-1').set({ tipo: 'consulta', ativo: true, vinculoUserId: 'user-admin-1' });
  });
  const celular = testEnv.authenticatedContext('uid-pareado-1').firestore();
  await assertSucceeds(celular.doc('installations/install-K/status_ao_vivo/atual').get());
});

test('status_ao_vivo: escrita negada pra qualquer cliente autenticado (só o desktop publica)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const celular = testEnv.authenticatedContext('uid-qualquer').firestore();
  await assertFails(celular.doc('installations/install-L/status_ao_vivo/atual').set({ resumoHoje: {} }));
});

test('dispositivos_pareados: só o próprio uid lê/escreve o próprio documento', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const dono = testEnv.authenticatedContext('uid-dono-1').firestore();
  const outro = testEnv.authenticatedContext('uid-outro-1').firestore();
  await assertSucceeds(dono.doc('dispositivos_pareados/uid-dono-1').set({ lojas: [] }));
  await assertFails(outro.doc('dispositivos_pareados/uid-dono-1').get());
});

test('pedidos_garcom: criação exige dispositivo garçom ativo vinculado a esta loja', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('installations/install-M/dispositivos/uid-garcom-ok').set({ tipo: 'garcom', ativo: true, vinculoUserId: 'user-garcom-1' });
  });
  const garcom = testEnv.authenticatedContext('uid-garcom-ok').firestore();
  await assertSucceeds(garcom.collection('installations/install-M/pedidos_garcom').add({
    garcomUid: 'uid-garcom-ok', mesaNumero: '7', itens: [{ productId: 'p1', quantidade: 2 }], status: 'novo',
  }));
});

test('pedidos_garcom: negado pra dispositivo do tipo consulta (não é garçom)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('installations/install-N/dispositivos/uid-consulta-1').set({ tipo: 'consulta', ativo: true, vinculoUserId: 'user-admin-1' });
  });
  const consulta = testEnv.authenticatedContext('uid-consulta-1').firestore();
  await assertFails(consulta.collection('installations/install-N/pedidos_garcom').add({
    garcomUid: 'uid-consulta-1', itens: [], status: 'novo',
  }));
});
