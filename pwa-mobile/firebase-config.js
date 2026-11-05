// Mesmo projeto Firebase único do GerenciaAI (gerenciaai-licencas) usado
// pelo Electron -- ver LICENSE_FIREBASE_CONFIG em
// electron/services/licenseService.js. Não é segredo: essa mesma config
// já vai embutida no instalador do desktop, então repeti-la aqui não
// expõe nada que já não estivesse público.
//
// O SDK vem do npm (package.json, versão fixada em 11.10.0) e entra no
// build -- antes vinha do CDN (gstatic.com), que o service worker não
// guardava: sem internet, o app nem abria. Agora o SDK é um arquivo do
// próprio app e fica no cache junto com o resto (ver vite.config.js).
import { initializeApp } from 'firebase/app';
import * as authMod from 'firebase/auth';
import * as firestoreMod from 'firebase/firestore';
import * as appCheckMod from 'firebase/app-check';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDcfANHaWg7pDGuTZpJJYpHCFXk88DCCrk',
  authDomain: 'gerenciaai-licencas.firebaseapp.com',
  projectId: 'gerenciaai-licencas',
  storageBucket: 'gerenciaai-licencas.firebasestorage.app',
  messagingSenderId: '178576716496',
  appId: '1:178576716496:web:c3bbe7d59299fd135524d5',
};

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
const RECAPTCHA_ENTERPRISE_SITE_KEY = '6Lfl46otAAAAAOm70sNp8ZCdAqTZma6acynM4Dle';
// Teste de ponta a ponta com os emuladores do Firebase (build com
// VITE_FIREBASE_EMULADOR=1, ver README): nada aqui roda no app publicado.
const EMULADOR = import.meta.env.VITE_FIREBASE_EMULADOR === '1';
if (!EMULADOR && RECAPTCHA_ENTERPRISE_SITE_KEY && RECAPTCHA_ENTERPRISE_SITE_KEY !== 'PREENCHA_AQUI_DEPOIS_DE_REGISTRAR') {
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

if (EMULADOR) {
  authMod.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  firestoreMod.connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

export { app, auth, db };
export const authFns = authMod;
export const firestoreFns = firestoreMod;
