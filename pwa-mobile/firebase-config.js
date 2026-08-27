// Mesmo projeto Firebase único do GerenciaAI (gerenciaai-licencas) usado
// pelo Electron -- ver LICENSE_FIREBASE_CONFIG em
// electron/services/licenseService.js. Não é segredo: essa mesma config
// já vai embutida no instalador do desktop, então repeti-la aqui não
// expõe nada que já não estivesse público.
//
// Import direto do CDN (mesmo padrão do admin-panel/index.html) -- este
// app é 100% estático, sem passo de build, pra poder ser publicado em
// qualquer hospedagem de arquivo estático (Firebase Hosting, Netlify,
// GitHub Pages...) só copiando a pasta. Versão fixada (11.10.0) pra não
// quebrar silenciosamente quando o CDN atualizar a "latest".
const FIREBASE_SDK_VERSION = '11.10.0';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDcfANHaWg7pDGuTZpJJYpHCFXk88DCCrk',
  authDomain: 'gerenciaai-licencas.firebaseapp.com',
  projectId: 'gerenciaai-licencas',
  storageBucket: 'gerenciaai-licencas.firebasestorage.app',
  messagingSenderId: '178576716496',
  appId: '1:178576716496:web:c3bbe7d59299fd135524d5',
};

const { initializeApp } = await import(
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`
);
const authMod = await import(
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`
);
const firestoreMod = await import(
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`
);

const app = initializeApp(FIREBASE_CONFIG);
const auth = authMod.getAuth(app);

// Cache local persistente (IndexedDB) -- é isso que dá a "fila offline"
// do app do garçom de graça: um addDoc() feito sem internet resolve na
// hora (aplicado no cache local) e o SDK sincroniza sozinho pro
// Firestore assim que a conexão voltar, sem fila feita à mão aqui.
// tabManager de aba única -- este app não espera múltiplas abas abertas
// ao mesmo tempo no mesmo celular.
const db = firestoreMod.initializeFirestore(app, {
  localCache: firestoreMod.persistentLocalCache({
    tabManager: firestoreMod.persistentSingleTabManager({}),
  }),
});

export { app, auth, db };
export const authFns = authMod;
export const firestoreFns = firestoreMod;
