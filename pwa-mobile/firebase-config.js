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
const appCheckMod = await import(
  `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app-check.js`
);

const app = initializeApp(FIREBASE_CONFIG);

// ⚠️ App Check (reCAPTCHA Enterprise -- o Console do Firebase hoje só
// oferece esse provedor pra registrar um app Web novo, o clássico v3
// foi descontinuado pra novas integrações) -- ver LICENCIAMENTO.md,
// Passo 3.7. Não é segredo (site keys do reCAPTCHA são públicas por
// natureza -- só a "secret key", que fica do lado do Google, é
// privada), mesmo espírito do FIREBASE_CONFIG acima. Grátis até 10 mil
// verificações/mês (nível "Essentials", sem precisar de cartão/
// faturamento no projeto Google Cloud) -- bem acima do que este app
// gera. Até você preencher a site key de verdade, isto não faz nada
// (nem quebra nada) -- o app continua exatamente como hoje, sem token
// de App Check anexado nas chamadas ao Firestore.
const RECAPTCHA_ENTERPRISE_SITE_KEY = 'PREENCHA_AQUI_DEPOIS_DE_REGISTRAR';
if (RECAPTCHA_ENTERPRISE_SITE_KEY && RECAPTCHA_ENTERPRISE_SITE_KEY !== 'PREENCHA_AQUI_DEPOIS_DE_REGISTRAR') {
  appCheckMod.initializeAppCheck(app, {
    provider: new appCheckMod.ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}

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
