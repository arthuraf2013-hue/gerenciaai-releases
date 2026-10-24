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
  // Começa de um banco vazio: sem isso, rodar o arquivo duas vezes seguidas
  // no mesmo emulador falhava (documentos da rodada anterior transformam
  // `create` em `update`).
  await testEnv.clearFirestore();
  // Contas de administrador usadas nos testes (lista admins/{uid}).
  await testEnv.withSecurityRulesDisabled(async (context) => {
    for (const uid of ['uid-admin-teste', 'admin-1']) await context.firestore().doc(`admins/${uid}`).set({ nome: 'teste' });
  });
  return testEnv;
}

// Todo teste que envolve pareamento/dispositivo/pedido precisa que a
// instalação tenha um cliente vinculado com os módulos pagos ativos --
// desde a PARTE 1.5 das regras (módulos pagos), a ausência de
// clienteId ou de modulosAtivos conta como módulo DESATIVADO
// (fail-closed). setupModulos() dá o cliente "padrão" (tudo ativo) pros
// testes que não são especificamente sobre módulo pago/desativado; os
// testes de módulo usam clienteId/modulosAtivos próprios pra simular o
// cliente que não paga ou que teve o módulo desligado.
async function setupModulos(installId, { clienteId = `cliente-de-${installId}`, consultaRemota = true, appGarcom = true, pdvMobile = true } = {}) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc(`installations/${installId}`).set({ clienteId }, { merge: true });
    await db.doc(`clientes/${clienteId}`).set({ modulosAtivos: { consultaRemota, appGarcom, pdvMobile } });
  });
  return clienteId;
}

async function seed(installId, { pareamentoUsado = false, garcomVinculoId = 'user-garcom-1' } = {}) {
  const clienteId = await setupModulos(installId);
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
  return clienteId;
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

// Regressão: os testes de `.doc(...).get()` acima passam mesmo com uma
// regra que só existe dentro de `match /installations/{installId}/
// pareamentos/{codigo}` -- só que o app de verdade NUNCA lê por
// caminho direto, sempre por uma consulta collectionGroup (o celular
// não sabe o installId antes de digitar o código -- ver
// pwa-mobile/pairing.js). Regra de subcoleção comum não vale pra
// collectionGroup; precisa do match com curinga recursivo
// `{path=**}/pareamentos/{codigo}` (ver firestore.rules) -- sem esses
// dois testes abaixo, a suíte inteira passava "verde" mesmo com essa
// regra faltando, porque nenhum teste exercitava o tipo de consulta
// que o app realmente faz. Foi exatamente essa lacuna que causou a
// rodada mais longa de diagnóstico desta sessão (permission-denied no
// celular mesmo com a regra de `get` certinha e testada).
test('celular consegue achar um código de pareamento via collectionGroup (fluxo real de pairing.js)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-U');
  const celular = testEnv.authenticatedContext('uid-busca-1').firestore();
  const snap = await assertSucceeds(
    celular.collectionGroup('pareamentos').where('codigo', '==', '111111').get()
  );
  // Outras lojas dos testes anteriores também usam o código 111111 (ver
  // seed()) e o emulador é compartilhado pela suíte inteira -- o que
  // importa aqui é a busca funcionar e achar o desta loja.
  assert.ok(snap.docs.some((d) => d.ref.path.startsWith('installations/install-U/')));
});

test('celular sem autenticar não consegue achar código nenhum via collectionGroup', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await seed('install-V');
  const semAuth = testEnv.unauthenticatedContext().firestore();
  await assertFails(
    semAuth.collectionGroup('pareamentos').where('codigo', '==', '111111').get()
  );
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

// Excluir de vez o vínculo (botão "Excluir" em Configurações → Celular,
// ver pairingService.excluirDispositivo) -- diferente de revogar (só
// zera `ativo` via update, testado acima), isto some com o documento.
// Só o DESKTOP (sem autenticação) pode; o próprio celular NUNCA exclui
// seu vínculo (nem "esquecer loja" no PWA faz isso, só limpa a lista
// local do aparelho).

test('dispositivos: exclusão permitida sem autenticação (é o desktop quem exclui)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('installations/install-X1/dispositivos/uid-para-excluir').set({ tipo: 'consulta', ativo: true, vinculoUserId: 'user-admin-1' });
  });
  const semAuth = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(semAuth.doc('installations/install-X1/dispositivos/uid-para-excluir').delete());
});

test('dispositivos: exclusão negada pro próprio celular autenticado, mesmo sendo o dono do vínculo', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('installations/install-X2/dispositivos/uid-dono').set({ tipo: 'consulta', ativo: true, vinculoUserId: 'user-admin-1' });
  });
  const celular = testEnv.authenticatedContext('uid-dono').firestore();
  await assertFails(celular.doc('installations/install-X2/dispositivos/uid-dono').delete());
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
  await setupModulos('install-K');
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

// ---------------------------------------------------------------------
// gestao_usuarios (lista de funcionários pra consulta remota) --
// DELIBERADAMENTE mais restrita que status_ao_vivo: só dispositivo
// tipo === 'consulta', nunca 'garcom' (ver comentário em
// firestore.rules e em userStatusSyncService.js).
// ---------------------------------------------------------------------

test('gestao_usuarios: leitura permitida pra dispositivo pareado como consulta e ativo', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupModulos('install-U2');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-U2/gestao_usuarios/atual').set({ usuarios: [{ id: 'u1', nome: 'Fulano', role: 'gerente', ativo: true }] });
    await db.doc('installations/install-U2/dispositivos/uid-consulta-ok').set({ tipo: 'consulta', ativo: true, vinculoUserId: 'user-admin-1' });
  });
  const celular = testEnv.authenticatedContext('uid-consulta-ok').firestore();
  await assertSucceeds(celular.doc('installations/install-U2/gestao_usuarios/atual').get());
});

test('gestao_usuarios: leitura NEGADA pra dispositivo pareado como garçom (não deve enxergar outros funcionários)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupModulos('install-U3');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-U3/gestao_usuarios/atual').set({ usuarios: [{ id: 'u1', nome: 'Fulano', role: 'gerente', ativo: true }] });
    await db.doc('installations/install-U3/dispositivos/uid-garcom-ok').set({ tipo: 'garcom', ativo: true, vinculoUserId: 'user-garcom-1' });
  });
  const celular = testEnv.authenticatedContext('uid-garcom-ok').firestore();
  await assertFails(celular.doc('installations/install-U3/gestao_usuarios/atual').get());
});

test('gestao_usuarios: leitura negada pra dispositivo consulta já desativado (revogado)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupModulos('install-U4');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-U4/gestao_usuarios/atual').set({ usuarios: [] });
    await db.doc('installations/install-U4/dispositivos/uid-consulta-revogado').set({ tipo: 'consulta', ativo: false, vinculoUserId: 'user-admin-1' });
  });
  const celular = testEnv.authenticatedContext('uid-consulta-revogado').firestore();
  await assertFails(celular.doc('installations/install-U4/gestao_usuarios/atual').get());
});

test('gestao_usuarios: leitura negada sem autenticação nenhuma', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupModulos('install-U5');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('installations/install-U5/gestao_usuarios/atual').set({ usuarios: [] });
  });
  const semAuth = testEnv.unauthenticatedContext().firestore();
  await assertFails(semAuth.doc('installations/install-U5/gestao_usuarios/atual').get());
});

test('gestao_usuarios: escrita negada pra qualquer cliente autenticado (só o desktop publica)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const celular = testEnv.authenticatedContext('uid-qualquer-2').firestore();
  await assertFails(celular.doc('installations/install-U6/gestao_usuarios/atual').set({ usuarios: [] }));
});

// ---------------------------------------------------------------------
// historico_vendas (resumo de vendas dos últimos 7/30 dias pra consulta
// remota) -- mesma restrição de gestao_usuarios e pelo MESMO motivo
// (compartilha a função dispositivoConsultaAtiva em firestore.rules):
// só dispositivo tipo === 'consulta', nunca 'garcom'.
// ---------------------------------------------------------------------

test('historico_vendas: leitura permitida pra dispositivo pareado como consulta e ativo', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupModulos('install-H2');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-H2/historico_vendas/atual').set({ ultimos7: {}, ultimos30: {} });
    await db.doc('installations/install-H2/dispositivos/uid-consulta-ok').set({ tipo: 'consulta', ativo: true, vinculoUserId: 'user-admin-1' });
  });
  const celular = testEnv.authenticatedContext('uid-consulta-ok').firestore();
  await assertSucceeds(celular.doc('installations/install-H2/historico_vendas/atual').get());
});

test('historico_vendas: leitura NEGADA pra dispositivo pareado como garçom (histórico financeiro não é dele)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupModulos('install-H3');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-H3/historico_vendas/atual').set({ ultimos7: {}, ultimos30: {} });
    await db.doc('installations/install-H3/dispositivos/uid-garcom-ok').set({ tipo: 'garcom', ativo: true, vinculoUserId: 'user-garcom-1' });
  });
  const celular = testEnv.authenticatedContext('uid-garcom-ok').firestore();
  await assertFails(celular.doc('installations/install-H3/historico_vendas/atual').get());
});

test('historico_vendas: leitura negada pra dispositivo consulta já desativado (revogado)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupModulos('install-H4');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-H4/historico_vendas/atual').set({ ultimos7: {}, ultimos30: {} });
    await db.doc('installations/install-H4/dispositivos/uid-consulta-revogado').set({ tipo: 'consulta', ativo: false, vinculoUserId: 'user-admin-1' });
  });
  const celular = testEnv.authenticatedContext('uid-consulta-revogado').firestore();
  await assertFails(celular.doc('installations/install-H4/historico_vendas/atual').get());
});

test('historico_vendas: leitura negada sem autenticação nenhuma', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupModulos('install-H5');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('installations/install-H5/historico_vendas/atual').set({ ultimos7: {}, ultimos30: {} });
  });
  const semAuth = testEnv.unauthenticatedContext().firestore();
  await assertFails(semAuth.doc('installations/install-H5/historico_vendas/atual').get());
});

test('historico_vendas: escrita negada pra qualquer cliente autenticado (só o desktop publica)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const celular = testEnv.authenticatedContext('uid-qualquer-3').firestore();
  await assertFails(celular.doc('installations/install-H6/historico_vendas/atual').set({ ultimos7: {}, ultimos30: {} }));
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
  await setupModulos('install-M');
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

// ---------------------------------------------------------------------
// PARTE 1.5 — módulos pagos (Consulta remota, App do garçom). O ponto
// central destes testes: desligar um módulo no painel corta o acesso
// IMEDIATAMENTE, não só pra pareamento novo -- inclusive pra quem já
// estava pareado antes do módulo ser desligado (é por isso que o gate
// está em 4 pontos: criação do código, criação/re-pareamento do
// dispositivo, criação de pedido, e leitura do status ao vivo).
// ---------------------------------------------------------------------

test('pareamentos: create falha se o módulo do tipo (App do garçom) está desativado pro cliente', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupModulos('install-O', { appGarcom: false, consultaRemota: true });
  const desktop = testEnv.unauthenticatedContext().firestore();
  await assertFails(desktop.doc('installations/install-O/pareamentos/444444').set({
    codigo: '444444', tipo: 'garcom', installId: 'install-O', vinculoUserId: 'user-garcom-x',
    usado: false, expiraEm: new Date(Date.now() + 10 * 60 * 1000),
  }));
});

test('pareamentos: create funciona pro tipo consulta mesmo com appGarcom desativado (módulos são independentes)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupModulos('install-O2', { appGarcom: false, consultaRemota: true });
  const desktop = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(desktop.doc('installations/install-O2/pareamentos/444444').set({
    codigo: '444444', tipo: 'consulta', installId: 'install-O2', vinculoUserId: 'user-admin-x',
    usado: false, expiraEm: new Date(Date.now() + 10 * 60 * 1000),
  }));
});

test('pareamentos: create falha se o cliente é legado e não tem modulosAtivos nenhum (fail-closed)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-P').set({ clienteId: 'cliente-legado' }, { merge: true });
    await db.doc('clientes/cliente-legado').set({ nome: 'Cliente Antigo' }); // sem modulosAtivos
  });
  const desktop = testEnv.unauthenticatedContext().firestore();
  await assertFails(desktop.doc('installations/install-P/pareamentos/444444').set({
    codigo: '444444', tipo: 'consulta', installId: 'install-P', vinculoUserId: 'user-admin-x',
    usado: false, expiraEm: new Date(Date.now() + 10 * 60 * 1000),
  }));
});

test('pareamentos: create falha se a instalação nem tem clienteId vinculado ainda (fail-closed)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const desktop = testEnv.unauthenticatedContext().firestore();
  await assertFails(desktop.doc('installations/install-Q/pareamentos/444444').set({
    codigo: '444444', tipo: 'consulta', installId: 'install-Q', vinculoUserId: 'user-admin-x',
    usado: false, expiraEm: new Date(Date.now() + 10 * 60 * 1000),
  }));
});

test('dispositivos: criação falha se o módulo foi desligado DEPOIS do código gerado mas ANTES do resgate', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const clienteId = await seed('install-R', { garcomVinculoId: 'user-garcom-9' }); // código 111111 = garcom, gerado com módulo ativo
  // Cliente cancela o módulo "App do garçom" no painel antes do celular resgatar.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc(`clientes/${clienteId}`).update({ 'modulosAtivos.appGarcom': false });
  });
  const celular = testEnv.authenticatedContext('uid-garcom-tardio').firestore();
  await assertFails(celular.doc('installations/install-R/dispositivos/uid-garcom-tardio').set({
    tipo: 'garcom', vinculoUserId: 'user-garcom-9', pareamentoCodigo: '111111', ativo: true,
  }));
});

test('pedidos_garcom: create falha se o módulo appGarcom foi desligado depois que o dispositivo já estava pareado', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const clienteId = await setupModulos('install-S');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('installations/install-S/dispositivos/uid-garcom-cortado').set({ tipo: 'garcom', ativo: true, vinculoUserId: 'user-garcom-1' });
  });
  // Módulo desligado no painel DEPOIS que este dispositivo já estava pareado.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc(`clientes/${clienteId}`).update({ 'modulosAtivos.appGarcom': false });
  });
  const garcom = testEnv.authenticatedContext('uid-garcom-cortado').firestore();
  await assertFails(garcom.collection('installations/install-S/pedidos_garcom').add({
    garcomUid: 'uid-garcom-cortado', mesaNumero: '3', itens: [], status: 'novo',
  }));
});

test('status_ao_vivo: leitura é cortada quando o módulo é desligado, mesmo pra dispositivo já pareado e ativo', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const clienteId = await setupModulos('install-T');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-T/status_ao_vivo/atual').set({ resumoHoje: { faturamentoHoje: 100 } });
    await db.doc('installations/install-T/dispositivos/uid-consulta-cortado').set({ tipo: 'consulta', ativo: true, vinculoUserId: 'user-admin-1' });
  });
  // Módulo "Consulta remota" desligado no painel DEPOIS que este dispositivo já estava pareado.
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc(`clientes/${clienteId}`).update({ 'modulosAtivos.consultaRemota': false });
  });
  const celular = testEnv.authenticatedContext('uid-consulta-cortado').firestore();
  await assertFails(celular.doc('installations/install-T/status_ao_vivo/atual').get());
});

// ---------------------------------------------------------------------
// Coleções exclusivas do admin-panel (clientes/cobrança, log de
// auditoria, config, contas Google, erros reportados) -- ver
// ehAdminAutenticado() em firestore.rules. O admin-panel já pedia
// e-mail/senha pra entrar antes desta mudança, mas as regras nunca
// conferiam isso; agora exigem uma sessão REAL (Firebase Auth
// e-mail/senha, `firebase.sign_in_provider == 'password'`) -- uma
// sessão anônima do celular (mesmo autenticada) não passa.
// ---------------------------------------------------------------------

function adminContext(uid = 'uid-admin-teste') {
  return testEnv.authenticatedContext(uid, { firebase: { sign_in_provider: 'password' } }).firestore();
}

test('clientes: leitura permitida sem autenticação (o desktop escuta em tempo real pra saber se o módulo pago está ativo)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('clientes/cliente-A1').set({ nome: 'Loja A' });
  });
  const semAuth = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(semAuth.doc('clientes/cliente-A1').get());
});

test('clientes: escrita negada sem autenticação nenhuma', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const semAuth = testEnv.unauthenticatedContext().firestore();
  await assertFails(semAuth.doc('clientes/cliente-A2').set({ nome: 'Loja B' }));
});

test('clientes: escrita negada pra uma sessão anônima (celular pareado), mesmo autenticado', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const celular = testEnv.authenticatedContext('uid-celular-qualquer').firestore();
  await assertFails(celular.doc('clientes/cliente-A3').set({ nome: 'Loja C' }));
});

test('clientes: escrita permitida pra uma sessão de verdade do admin-panel (login e-mail/senha)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await assertSucceeds(adminContext().doc('clientes/cliente-A4').set({ nome: 'Loja D' }));
});

test('clientes/pagamentos: leitura e escrita negadas sem sessão do admin-panel', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('clientes/cliente-A5/pagamentos/pag-1').set({ valor: 100 });
  });
  const celular = testEnv.authenticatedContext('uid-celular-qualquer-2').firestore();
  await assertFails(celular.doc('clientes/cliente-A5/pagamentos/pag-1').get());
  await assertFails(celular.collection('clientes/cliente-A5/pagamentos').add({ valor: 50 }));
});

test('erros_reportados: criação permitida sem autenticação (é o desktop quem reporta um erro novo)', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const semAuth = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(semAuth.collection('erros_reportados').add({ mensagem: 'algo quebrou' }));
});

test('erros_reportados: leitura (listar) negada sem sessão do admin-panel', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const celular = testEnv.authenticatedContext('uid-celular-qualquer-3').firestore();
  await assertFails(celular.collection('erros_reportados').get());
});

test('erros_reportados: leitura e exclusão permitidas pro admin-panel', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('erros_reportados/erro-1').set({ mensagem: 'x' });
  });
  const admin = adminContext();
  await assertSucceeds(admin.collection('erros_reportados').get());
  await assertSucceeds(admin.doc('erros_reportados/erro-1').delete());
});

test('acoes_log: leitura e escrita negadas pra sessão anônima, permitidas pro admin-panel', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const celular = testEnv.authenticatedContext('uid-celular-qualquer-4').firestore();
  await assertFails(celular.collection('acoes_log').add({ acao: 'x' }));
  await assertSucceeds(adminContext().collection('acoes_log').add({ acao: 'y' }));
});

test('config: leitura permitida sem autenticação (desktop escuta atualização obrigatória/mensagem global); escrita exige admin-panel', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('config/atualizacao').set({ obrigatoria: false });
  });
  const semAuth = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(semAuth.doc('config/atualizacao').get());
  await assertFails(semAuth.doc('config/atualizacao').set({ obrigatoria: true }));
  await assertSucceeds(adminContext().doc('config/mensagem').set({ ativa: true, texto: 'oi' }));
});

test('contas_google: escrita permitida sem autenticação (cada instalação grava a própria conta), mas leitura exige admin-panel', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  const semAuth = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(semAuth.doc('contas_google/install-CG1').set({ email: 'x@y.com', senhaCifradaRsa: 'abc' }));
  await assertFails(semAuth.doc('contas_google/install-CG1').get());
  await assertSucceeds(adminContext().doc('contas_google/install-CG1').get());
});

// ---------------------------------------------------------------------
// PDV móvel (vendas_mobile, consultas_pdv, config_mobile) e a correção
// da leitura de pedidos_garcom pelo desktop (sem autenticação).
// ---------------------------------------------------------------------

async function setupPdv(installId, uid, { ativo = true, pdvMobile = true, tipo = 'pdv' } = {}) {
  await setupModulos(installId, { pdvMobile });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc(`installations/${installId}/dispositivos/${uid}`).set({ tipo, ativo, vinculoUserId: 'user-operador-1' });
  });
}

function vendaMobile(uid, extra = {}) {
  return {
    dispositivoUid: uid, status: 'novo',
    itens: [{ productId: 'p1', nome: 'X', quantidade: 1, precoUnitario: 10 }],
    pagamentos: [{ metodo: 'dinheiro', valor: 10 }],
    subtotalEsperado: 10, totalEsperado: 10,
    ...extra,
  };
}

test('pedidos_garcom: o DESKTOP (sem autenticação) consegue escutar os pedidos novos', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('installations/install-PG/pedidos_garcom/p1').set({ garcomUid: 'uid-x', status: 'novo', itens: [] });
  });
  const desktop = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(desktop.collection('installations/install-PG/pedidos_garcom').where('status', '==', 'novo').get());
});

test('pedidos_garcom: PDV móvel ativo também lança pedido de mesa', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupPdv('install-PDV1', 'uid-pdv-mesa');
  const pdv = testEnv.authenticatedContext('uid-pdv-mesa').firestore();
  await assertSucceeds(pdv.collection('installations/install-PDV1/pedidos_garcom').add({
    garcomUid: 'uid-pdv-mesa', mesaNumero: '3', itens: [{ productId: 'p1', quantidade: 1 }], status: 'novo',
  }));
});

test('vendas_mobile: PDV móvel ativo cria venda; garçom, revogado ou módulo desligado não', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupPdv('install-PDV2', 'uid-pdv-ok');
  const ok = testEnv.authenticatedContext('uid-pdv-ok').firestore();
  await assertSucceeds(ok.doc('installations/install-PDV2/vendas_mobile/v1').set(vendaMobile('uid-pdv-ok')));
  // em nome de outro celular
  await assertFails(ok.doc('installations/install-PDV2/vendas_mobile/v2').set(vendaMobile('uid-outro')));
  // já nascendo "finalizada"
  await assertFails(ok.doc('installations/install-PDV2/vendas_mobile/v3').set(vendaMobile('uid-pdv-ok', { status: 'finalizada' })));
  // campo fora da lista
  await assertFails(ok.doc('installations/install-PDV2/vendas_mobile/v4').set(vendaMobile('uid-pdv-ok', { saleId: 'forjado' })));

  await setupPdv('install-PDV3', 'uid-garcom-pdv', { tipo: 'garcom' });
  const garcom = testEnv.authenticatedContext('uid-garcom-pdv').firestore();
  await assertFails(garcom.doc('installations/install-PDV3/vendas_mobile/v1').set(vendaMobile('uid-garcom-pdv')));

  await setupPdv('install-PDV4', 'uid-pdv-revogado', { ativo: false });
  const revogado = testEnv.authenticatedContext('uid-pdv-revogado').firestore();
  await assertFails(revogado.doc('installations/install-PDV4/vendas_mobile/v1').set(vendaMobile('uid-pdv-revogado')));

  await setupPdv('install-PDV5', 'uid-pdv-sem-modulo', { pdvMobile: false });
  const semModulo = testEnv.authenticatedContext('uid-pdv-sem-modulo').firestore();
  await assertFails(semModulo.doc('installations/install-PDV5/vendas_mobile/v1').set(vendaMobile('uid-pdv-sem-modulo')));
});

test('vendas_mobile: celular não altera a própria venda depois de criada; desktop só mexe nos campos de resultado', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupPdv('install-PDV6', 'uid-pdv-6');
  const celular = testEnv.authenticatedContext('uid-pdv-6').firestore();
  await assertSucceeds(celular.doc('installations/install-PDV6/vendas_mobile/v1').set(vendaMobile('uid-pdv-6')));
  await assertFails(celular.doc('installations/install-PDV6/vendas_mobile/v1').update({ status: 'finalizada' }));
  await assertSucceeds(celular.doc('installations/install-PDV6/vendas_mobile/v1').get());

  const desktop = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(desktop.doc('installations/install-PDV6/vendas_mobile/v1').update({ status: 'finalizada', saleId: 's1', resumo: { total: 10 } }));
  await assertFails(desktop.doc('installations/install-PDV6/vendas_mobile/v1').update({ itens: [] }));
});

test('vendas_mobile: um celular não lê a venda de outro', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupPdv('install-PDV7', 'uid-pdv-7a');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('installations/install-PDV7/vendas_mobile/v1').set(vendaMobile('uid-pdv-7a'));
  });
  const outro = testEnv.authenticatedContext('uid-pdv-7b').firestore();
  await assertFails(outro.doc('installations/install-PDV7/vendas_mobile/v1').get());
});

test('consultas_pdv: PDV móvel cria consulta de tipo conhecido; desktop responde', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupPdv('install-PDV8', 'uid-pdv-8');
  const celular = testEnv.authenticatedContext('uid-pdv-8').firestore();
  await assertSucceeds(celular.doc('installations/install-PDV8/consultas_pdv/c1').set({ dispositivoUid: 'uid-pdv-8', status: 'novo', tipo: 'produtos', termo: 'coca' }));
  await assertFails(celular.doc('installations/install-PDV8/consultas_pdv/c2').set({ dispositivoUid: 'uid-pdv-8', status: 'novo', tipo: 'apagar_tudo' }));
  const desktop = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(desktop.doc('installations/install-PDV8/consultas_pdv/c1').update({ status: 'respondida', resultado: [] }));
});

test('config_mobile: só PDV móvel ativo lê; só o desktop escreve', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupPdv('install-PDV9', 'uid-pdv-9');
  const desktop = testEnv.unauthenticatedContext().firestore();
  await assertSucceeds(desktop.doc('installations/install-PDV9/config_mobile/pdv').set({ permitirVenda: true }));
  await assertSucceeds(testEnv.authenticatedContext('uid-pdv-9').firestore().doc('installations/install-PDV9/config_mobile/pdv').get());
  await assertFails(testEnv.authenticatedContext('uid-qualquer').firestore().doc('installations/install-PDV9/config_mobile/pdv').get());
  await assertFails(testEnv.authenticatedContext('uid-pdv-9').firestore().doc('installations/install-PDV9/config_mobile/pdv').set({ permitirVenda: false }));
});

// ---------------------------------------------------------------------
// gestao_pdv: mexer em produto pelo celular -- só celular que o
// computador liberou (config_mobile/pdv.gestaoLiberadaPara, ver
// pdvMobileConfigService.dispositivosComGestao).
// ---------------------------------------------------------------------

async function setupGestao(installId, { pdvMobile = true, liberados = ['uid-pdv-gerente'] } = {}) {
  await setupModulos(installId, { pdvMobile });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc(`installations/${installId}/dispositivos/uid-pdv-gerente`).set({ tipo: 'pdv', ativo: true, vinculoUserId: 'user-gerente-1' });
    await db.doc(`installations/${installId}/dispositivos/uid-pdv-operador`).set({ tipo: 'pdv', ativo: true, vinculoUserId: 'user-operador-1' });
    await db.doc(`installations/${installId}/config_mobile/pdv`).set({ gestaoProdutos: 'gestao', gestaoLiberadaPara: liberados });
  });
}

function pedidoPreco(uid, extra = {}) {
  return { dispositivoUid: uid, status: 'novo', tipo: 'preco', produtoId: 'p1', preco: 12.5, precoAnterior: 10, ...extra };
}

test('gestao_pdv: celular liberado cria pedido; celular de operador (fora da lista) não', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupGestao('install-GP1');
  const gerente = testEnv.authenticatedContext('uid-pdv-gerente').firestore();
  await assertSucceeds(gerente.doc('installations/install-GP1/gestao_pdv/g1').set(pedidoPreco('uid-pdv-gerente')));
  await assertSucceeds(gerente.doc('installations/install-GP1/gestao_pdv/g2').set({
    dispositivoUid: 'uid-pdv-gerente', status: 'novo', tipo: 'produto_novo', nome: 'Água', preco: 3, custo: null,
    unidade: 'un', estoqueInicial: 10, codigoBarras: '789', categoria: null,
  }));
  const operador = testEnv.authenticatedContext('uid-pdv-operador').firestore();
  await assertFails(operador.doc('installations/install-GP1/gestao_pdv/g3').set(pedidoPreco('uid-pdv-operador')));
});

test('gestao_pdv: tipo, campo ou formato fora do combinado é recusado', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupGestao('install-GP2');
  const gerente = testEnv.authenticatedContext('uid-pdv-gerente').firestore();
  const base = 'installations/install-GP2/gestao_pdv';
  await assertFails(gerente.doc(`${base}/a`).set(pedidoPreco('uid-pdv-gerente', { tipo: 'excluir_produto' })));
  await assertFails(gerente.doc(`${base}/b`).set(pedidoPreco('uid-pdv-gerente', { custoSecreto: 1 })));
  await assertFails(gerente.doc(`${base}/c`).set(pedidoPreco('uid-pdv-gerente', { preco: '12,50' })));
  await assertFails(gerente.doc(`${base}/d`).set(pedidoPreco('uid-pdv-gerente', { motivo: 'x'.repeat(121) })));
  await assertFails(gerente.doc(`${base}/e`).set(pedidoPreco('uid-pdv-gerente', { status: 'respondida' })));
  await assertFails(gerente.doc(`${base}/f`).set(pedidoPreco('uid-outro')));
});

test('gestao_pdv: módulo desligado ou celular revogado não cria, mesmo na lista', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupGestao('install-GP3', { pdvMobile: false });
  await assertFails(testEnv.authenticatedContext('uid-pdv-gerente').firestore()
    .doc('installations/install-GP3/gestao_pdv/x').set(pedidoPreco('uid-pdv-gerente')));

  await setupGestao('install-GP4');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context.firestore().doc('installations/install-GP4/dispositivos/uid-pdv-gerente').update({ ativo: false });
  });
  await assertFails(testEnv.authenticatedContext('uid-pdv-gerente').firestore()
    .doc('installations/install-GP4/gestao_pdv/x').set(pedidoPreco('uid-pdv-gerente')));
});

test('gestao_pdv: só o dono lê a resposta; só o desktop responde e apaga; celular não muda o pedido', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupGestao('install-GP5', { liberados: ['uid-pdv-gerente', 'uid-pdv-operador'] });
  const gerente = testEnv.authenticatedContext('uid-pdv-gerente').firestore();
  const ref = 'installations/install-GP5/gestao_pdv/g1';
  await assertSucceeds(gerente.doc(ref).set(pedidoPreco('uid-pdv-gerente')));
  await assertSucceeds(gerente.doc(ref).get());
  await assertFails(testEnv.authenticatedContext('uid-pdv-operador').firestore().doc(ref).get());
  await assertFails(gerente.doc(ref).update({ status: 'respondida', resultado: { mensagem: 'forjado' } }));
  await assertFails(gerente.doc(ref).delete());

  const desktop = testEnv.unauthenticatedContext().firestore();
  await assertFails(desktop.doc(ref).update({ preco: 1 }));
  await assertSucceeds(desktop.doc(ref).update({ status: 'respondida', resultado: { mensagem: 'ok' } }));
  await assertSucceeds(desktop.doc(ref).delete());
});

// ---------------------------------------------------------------------
// historico_vendas pelo PDV móvel: só celular que o computador liberou
// (config_mobile/pdv.metricasLiberadasPara -- ver
// pdvMobileConfigService.dispositivosComMetricas).
// ---------------------------------------------------------------------

test('historico_vendas: PDV móvel liberado pelo computador lê; PDV fora da lista não lê', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupModulos('install-HP1');
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-HP1/historico_vendas/atual').set({ hoje: {}, ultimos7: {}, ultimos30: {} });
    await db.doc('installations/install-HP1/dispositivos/uid-pdv-gerente').set({ tipo: 'pdv', ativo: true, vinculoUserId: 'user-gerente-1' });
    await db.doc('installations/install-HP1/dispositivos/uid-pdv-operador').set({ tipo: 'pdv', ativo: true, vinculoUserId: 'user-operador-1' });
    await db.doc('installations/install-HP1/config_mobile/pdv').set({ metricasLoja: 'gestao', metricasLiberadasPara: ['uid-pdv-gerente'] });
  });
  await assertSucceeds(testEnv.authenticatedContext('uid-pdv-gerente').firestore().doc('installations/install-HP1/historico_vendas/atual').get());
  await assertFails(testEnv.authenticatedContext('uid-pdv-operador').firestore().doc('installations/install-HP1/historico_vendas/atual').get());
});

test('historico_vendas: PDV móvel liberado mas com o módulo desligado ou desconectado não lê', { skip: !RODAR && SKIP_MSG }, async () => {
  await setupTestEnv();
  await setupModulos('install-HP2', { pdvMobile: false });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('installations/install-HP2/historico_vendas/atual').set({ hoje: {} });
    await db.doc('installations/install-HP2/dispositivos/uid-pdv-x').set({ tipo: 'pdv', ativo: true, vinculoUserId: 'user-gerente-1' });
    await db.doc('installations/install-HP2/config_mobile/pdv').set({ metricasLiberadasPara: ['uid-pdv-x'] });
  });
  await assertFails(testEnv.authenticatedContext('uid-pdv-x').firestore().doc('installations/install-HP2/historico_vendas/atual').get());
});

// ---------------------------------------------------------------------
// Fase A: licença e dados entre clientes. A máquina (sem login) continua
// gravando o próprio documento (ping, versão, métricas, pedidos que ela
// consome), mas não muda o que decide se ela funciona.
// ---------------------------------------------------------------------
const SK = { skip: !RODAR && SKIP_MSG };
const adminCtx = () => testEnv.authenticatedContext('admin-1', { firebase: { sign_in_provider: 'password' } }).firestore();
const semLogin = () => testEnv.unauthenticatedContext().firestore();

async function semRegras(fn) {
  await testEnv.withSecurityRulesDisabled(async (context) => fn(context.firestore()));
}

test('instalação: desktop cria o próprio documento como sempre fez (ativo, sem cliente)', SK, async () => {
  await setupTestEnv();
  await assertSucceeds(semLogin().doc('installations/novo-pc-1').set({
    ativo: true, bloqueioImediato: false, clienteId: null, nomeNegocio: null,
    totalVendasHistorico: 0, vendasUltimos30Dias: 0, perfilAtivo: null, versaoApp: '1.0.2',
  }));
});

test('instalação: desktop atualiza ping, versão, métricas e status de atualização', SK, async () => {
  await setupTestEnv();
  await semRegras((db) => db.doc('installations/pc-ok').set({ ativo: true, bloqueioImediato: false, clienteId: 'cli-1' }));
  const db = semLogin();
  await assertSucceeds(db.doc('installations/pc-ok').set({ ultimoPing: new Date(), versaoApp: '1.0.3', vendasUltimos30Dias: 9 }, { merge: true }));
  await assertSucceeds(db.doc('installations/pc-ok').set({ atualizacaoBaixado: true, atualizacaoVersaoAlvo: '1.0.4', atualizacaoRetida: true }, { merge: true }));
  // Prontidão do reparo automático (licenseService.enviarPing).
  await assertSucceeds(db.doc('installations/pc-ok').set({ ultimoPing: new Date(), reparo: { pronto: false, problema: 'sem_copia', copiaVersao: null, ultimoReparo: null, atualizadoEm: new Date() } }, { merge: true }));
  // Reenviar o MESMO valor de um campo de controle não é mudança.
  await assertSucceeds(db.doc('installations/pc-ok').set({ ativo: true, clienteId: 'cli-1' }, { merge: true }));
});

test('instalação: máquina congelada/bloqueada NÃO se reativa sozinha', SK, async () => {
  await setupTestEnv();
  await semRegras((db) => db.doc('installations/pc-bloq').set({ ativo: false, bloqueioImediato: true, motivoBloqueio: 'mensalidade' }));
  const db = semLogin();
  await assertFails(db.doc('installations/pc-bloq').set({ ativo: true }, { merge: true }));
  await assertFails(db.doc('installations/pc-bloq').set({ bloqueioImediato: false }, { merge: true }));
  await assertFails(db.doc('installations/pc-bloq').update({ motivoBloqueio: null }));
  // Nem apagando pra recriar ativo.
  await assertFails(db.doc('installations/pc-bloq').delete());
});

test('instalação: máquina não se vincula a cliente, grupo, override nem libera a própria atualização', SK, async () => {
  await setupTestEnv();
  await semRegras((db) => db.doc('installations/pc-x').set({ ativo: true, clienteId: null, atualizacaoSegurada: true, atualizacaoSeguradaVersao: '*' }));
  const db = semLogin();
  for (const campos of [
    { clienteId: 'cliente-que-paga' },
    { grupoSincronizacaoId: 'grupo-alheio' },
    { servidorDoGrupo: true },
    { overrideAtivo: true, versaoMinimaOverride: '0.0.1' },
    { atualizacaoSegurada: false },
    { excluidaEm: null },
    { modoOperacao: 'terminal', servidorInstallId: 'pc-atacante' },
    { restaurarBackupSolicitado: { nomeArquivo: 'velho.sqlite3' } },
  ]) {
    await assertFails(db.doc('installations/pc-x').set(campos, { merge: true }));
  }
});

test('instalação: ninguém cria documento novo já dizendo ser de um cliente (sem código de ativação)', SK, async () => {
  await setupTestEnv();
  await assertFails(semLogin().doc('installations/pc-falso').set({ ativo: true, clienteId: 'cliente-que-paga' }));
  await assertFails(semLogin().doc('installations/pc-falso2').set({ ativo: true, grupoSincronizacaoId: 'g1' }));
});

test('instalação: celular ativado com código resgatado por ELE cria o documento com o cliente do código', SK, async () => {
  await setupTestEnv();
  await semRegras((db) => db.doc('ativacoes_mobile/ABCD2345').set({ clienteId: 'cli-cel', usado: true, usadoPorInstallId: 'cel-0000000000000001' }));
  const db = semLogin();
  await assertSucceeds(db.doc('installations/cel-0000000000000001').set({
    tipo: 'pdv_mobile_autonomo', modoOperacao: 'autonomo', clienteId: 'cli-cel', nomeNegocio: 'Loja', ativo: true,
    bloqueioImediato: false, backupFrequenciaHoras: 1, backupRetencaoDias: 30, ativadoComCodigo: 'ABCD2345',
  }, { merge: true }));
  // Código de OUTRO aparelho não serve.
  await assertFails(db.doc('installations/cel-0000000000000002').set({ clienteId: 'cli-cel', ativadoComCodigo: 'ABCD2345', ativo: true }));
  // Código certo, cliente diferente do código: não.
  await assertFails(db.doc('installations/cel-0000000000000001').set({ clienteId: 'outro-cli', ativadoComCodigo: 'ABCD2345' }, { merge: true }));
});

test('instalação: computador registra a migração e pede backup no documento do celular', SK, async () => {
  await setupTestEnv();
  await semRegras((db) => db.doc('installations/cel-mig').set({ ativo: true, clienteId: 'cli-1', modoOperacao: 'autonomo' }));
  const db = semLogin();
  await assertSucceeds(db.doc('installations/cel-mig').set({ backupSolicitadoEm: Date.now() }, { merge: true }));
  await assertSucceeds(db.doc('installations/cel-mig').set({
    migradoPara: 'pc-1', migradoParaNome: 'Caixa', migradoEm: new Date(), migradoBackupArquivo: 'b.json.gz', migradoCorteMs: 1, backupRetencaoDias: 30,
  }, { merge: true }));
});

test('instalação: a Central (login com senha) continua mudando tudo', SK, async () => {
  await setupTestEnv();
  await semRegras((db) => db.doc('installations/pc-c').set({ ativo: true }));
  const db = adminCtx();
  await assertSucceeds(db.doc('installations/pc-c').update({ ativo: false, bloqueioImediato: true, motivoBloqueio: 'x', clienteId: 'c', grupoSincronizacaoId: 'g' }));
  await assertSucceeds(db.doc('installations/pc-c').update({ modoOperacao: 'terminal', servidorInstallId: 'pc-1', atualizacaoSegurada: true, excluidaEm: new Date() }));
  // Login anônimo (celular pareado) não é a Central.
  await assertFails(testEnv.authenticatedContext('anon-1').firestore().doc('installations/pc-c').update({ ativo: true }));
});

test('grupos: só a Central lista grupos; máquina usa vendas/produtos/estoque pelo id', SK, async () => {
  await setupTestEnv();
  await semRegras((db) => db.doc('grupos_sincronizacao/g-123').set({ nome: 'Rede X' }));
  await assertFails(semLogin().collection('grupos_sincronizacao').get());
  await assertFails(semLogin().doc('grupos_sincronizacao/g-123').get());
  await assertSucceeds(adminCtx().collection('grupos_sincronizacao').get());
  await assertSucceeds(semLogin().doc('grupos_sincronizacao/g-123/vendas/v1').set({ total: 10 }));
  await assertSucceeds(semLogin().collection('grupos_sincronizacao/g-123/vendas').get());
  await assertSucceeds(semLogin().doc('grupos_sincronizacao/g-123/estoque/p1').set({ quantidade: 5 }));
});

test('cofre: fechado para quem não é a Central', SK, async () => {
  await setupTestEnv();
  await semRegras((db) => db.doc('cofre_config/chave_contas_google').set({ chavePrivadaEnc: 'x' }));
  await assertFails(semLogin().doc('cofre_config/chave_contas_google').get());
  await assertFails(semLogin().collection('cofre_acessos').get());
  await assertFails(testEnv.authenticatedContext('anon').firestore().doc('cofre_config/verificacao').set({ salt: 'x' }));
  await assertSucceeds(adminCtx().doc('cofre_config/chave_contas_google').get());
});

test('estoque do grupo: movimento do livro é gravado uma vez e não muda depois', SK, async () => {
  await setupTestEnv();
  const db = semLogin();
  await assertSucceeds(db.doc('grupos_sincronizacao/g-9/estoque/p1/movimentos/m1').set({ delta: 3 }));
  await assertFails(db.doc('grupos_sincronizacao/g-9/estoque/p1/movimentos/m1').set({ delta: 300 }));
  await assertFails(db.doc('grupos_sincronizacao/g-9/estoque/p1/movimentos/m1').delete());
});

test('instalação: id fora do formato de UUID não é criado (evita HTML injetado pelo id na Central)', SK, async () => {
  await setupTestEnv();
  await assertFails(semLogin().doc('installations/x" onmouseover="alert(1)').set({ ativo: true }));
  await assertFails(semLogin().doc('installations/<img src=x>').set({ ativo: true }));
  await assertSucceeds(semLogin().doc('installations/0b6c1f9e-5d0a-4a8e-9a77-3f1f0c2b9d11').set({ ativo: true, clienteId: null }));
});

test('clientes: ninguém além da Central lista a carteira (nome, documento, mensalidade); get pelo id continua', SK, async () => {
  await setupTestEnv();
  await semRegras((db) => db.doc('clientes/cli-lgpd').set({ nome: 'Loja X', documento: '00.000.000/0001-00', valorMensalidade: 99 }));
  await assertFails(semLogin().collection('clientes').get());
  await assertFails(testEnv.authenticatedContext('anon-x').firestore().collection('clientes').get());
  await assertSucceeds(semLogin().doc('clientes/cli-lgpd').get());
  await assertSucceeds(adminCtx().collection('clientes').get());
});


test('admin: conta de e-mail/senha que NÃO está em admins/{uid} não é administradora (cadastro aberto no Firebase)', SK, async () => {
  await setupTestEnv();
  const intruso = testEnv.authenticatedContext('uid-qualquer', { firebase: { sign_in_provider: 'password' } }).firestore();
  await semRegras((db) => db.doc('installations/pc-alvo').set({ ativo: false, bloqueioImediato: true }));
  await assertFails(intruso.doc('installations/pc-alvo').update({ ativo: true, bloqueioImediato: false }));
  await assertFails(intruso.collection('clientes').get());
  await assertFails(intruso.doc('cofre_config/chave_contas_google').get());
  await assertFails(intruso.doc('admins/uid-qualquer').set({ nome: 'eu' }));
  // A lista não é legível nem gravável por ninguém pelo app; a própria conta lê o próprio registro.
  await assertSucceeds(testEnv.authenticatedContext('admin-1', { firebase: { sign_in_provider: 'password' } }).firestore().doc('admins/admin-1').get());
  await assertFails(testEnv.authenticatedContext('admin-1', { firebase: { sign_in_provider: 'password' } }).firestore().collection('admins').get());
  await assertSucceeds(adminCtx().doc('installations/pc-alvo').update({ ativo: true }));
});

// ---------------------------------------------------------------------
// Teste grátis (testeGratisService.js) e tela Crescimento da Central.
// ---------------------------------------------------------------------

test('teste grátis: desktop cria a instalação em teste de até 30 dias; não define prazo próprio', SK, async () => {
  await setupTestEnv();
  const db = semLogin();
  const base = { ativo: true, bloqueioImediato: false, clienteId: null, versaoApp: '1.0.5', maquinaHash: 'abc' };
  await assertSucceeds(db.doc('installations/teste-pc-1').set({ ...base, teste: { dias: 14 } }));
  await assertFails(db.doc('installations/teste-pc-2').set({ ...base, teste: { dias: 365 } }));
  await assertFails(db.doc('installations/teste-pc-3').set({ ...base, teste: { dias: 14, extra: true } }));
  await assertFails(db.doc('installations/teste-pc-4').set({ ...base, teste: { dias: 14 }, testeAte: new Date(2099, 0, 1) }));
});

test('teste grátis: depois de criada, a máquina não mexe no teste; a Central estende', SK, async () => {
  await setupTestEnv();
  await semRegras((db) => db.doc('installations/teste-pc-5').set({ ativo: true, teste: { dias: 14 }, clienteId: null }));
  const db = semLogin();
  await assertFails(db.doc('installations/teste-pc-5').set({ teste: { dias: 30 } }, { merge: true }));
  await assertFails(db.doc('installations/teste-pc-5').set({ testeAte: new Date(2099, 0, 1) }, { merge: true }));
  await assertFails(db.doc('installations/teste-pc-5').update({ teste: null }));
  // métricas, relatório e hash continuam livres pra máquina
  await assertSucceeds(db.doc('installations/teste-pc-5').set({ maquinaHash: 'h', produtosCadastrados: 10, relatorioMensal: { mes: '2026-09', vendas: 3 } }, { merge: true }));
  await assertSucceeds(adminCtx().doc('installations/teste-pc-5').update({ testeAte: new Date(2026, 11, 1) }));
});

test('crescimento: contato comercial é público pra ler e só a Central grava; crm é só da Central', SK, async () => {
  await setupTestEnv();
  await assertSucceeds(adminCtx().doc('config_publica/comercial').set({ whatsapp: '81999991234', empresa: 'Vetta' }));
  await assertSucceeds(semLogin().doc('config_publica/comercial').get());
  await assertFails(semLogin().doc('config_publica/comercial').set({ whatsapp: '11900000000' }));
  await assertSucceeds(adminCtx().doc('crm/contatos').set({ telefones: { c1: '81999991234' } }));
  await assertFails(semLogin().doc('crm/contatos').get());
  await assertFails(testEnv.authenticatedContext('uid-qualquer').firestore().doc('crm/contatos').get());
});

test('vitrine: endereço (com o WhatsApp dos pedidos) só a Central grava; página pública lê', SK, async () => {
  await setupTestEnv();
  await assertSucceeds(adminCtx().doc('vitrines/padaria-x').set({ clienteId: 'c1', installId: 'pc-vit', whatsapp: '81999991234', ativa: true }));
  await assertSucceeds(semLogin().doc('vitrines/padaria-x').get());
  // desktop sem login (ou qualquer celular) não troca o número para onde vão os pedidos
  await assertFails(semLogin().doc('vitrines/padaria-x').set({ clienteId: 'c1', installId: 'pc-vit', whatsapp: '11900000000', ativa: true }));
  await assertFails(testEnv.authenticatedContext('uid-qualquer').firestore().doc('vitrines/padaria-x').update({ whatsapp: '11900000000' }));
});

test('vitrine: o computador publica só catalogo/config; qualquer um lê; logado não grava; endereço na instalação é da Central', SK, async () => {
  await setupTestEnv();
  await semRegras((db) => db.doc('installations/pc-vit').set({ ativo: true, clienteId: 'c1' }));
  const desktop = semLogin();
  await assertSucceeds(desktop.doc('installations/pc-vit/vitrine/catalogo').set({ itens: [] }));
  await assertSucceeds(desktop.doc('installations/pc-vit/vitrine/config').set({ ativa: true }));
  await assertFails(desktop.doc('installations/pc-vit/vitrine/outra').set({ x: 1 }));
  await assertFails(testEnv.authenticatedContext('uid-qualquer').firestore().doc('installations/pc-vit/vitrine/catalogo').set({ itens: [] }));
  await assertSucceeds(testEnv.authenticatedContext('uid-qualquer').firestore().doc('installations/pc-vit/vitrine/catalogo').get());
  await assertFails(desktop.doc('installations/pc-vit').set({ vitrineSlug: 'outra-loja' }, { merge: true }));
  await assertSucceeds(adminCtx().doc('installations/pc-vit').update({ vitrineSlug: 'padaria-x' }));
});
