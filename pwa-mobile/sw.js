// Service worker do app do celular. Este arquivo é um MODELO: o build
// (vite.config.js, gerarServiceWorker) troca __ARQUIVOS__ pela lista exata
// dos arquivos de dist/ e __VERSAO__ por um hash do conteúdo deles, e grava
// o resultado em dist/sw.js. Não registre este arquivo direto (no `npm run
// dev` o app nem registra service worker).
//
// O que ele faz:
//  1) guarda o app inteiro no aparelho na instalação (inclusive o SDK do
//     Firebase, que agora faz parte do build) -- o app abre sem internet;
//  2) arquivos com hash no nome (assets/*) nunca mudam: vêm do cache;
//  3) a página (HTML) tenta a rede primeiro, pra nunca ficar presa numa
//     versão velha, e cai no cache se estiver sem internet;
//  4) versão nova NÃO assume sozinha: fica esperando até a pessoa tocar em
//     "Atualizar" (app.js) -- trocar de versão no meio de uma venda ou de
//     um pedido perderia o que está na tela.
// Nunca intercepta chamada de outro endereço (Firestore, Firebase Auth):
// a fila offline dos pedidos é do próprio SDK do Firestore (IndexedDB).

const VERSAO = '__VERSAO__';
const CACHE = `gerenciaai-app-${VERSAO}`;
const ARQUIVOS = __ARQUIVOS__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ARQUIVOS.map((url) => new Request(url, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((k) => k.startsWith('gerenciaai-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'atualizar') self.skipWaiting();
});

function ehPagina(request) {
  return request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (ehPagina(request)) {
    event.respondWith(
      fetch(request)
        .then((resposta) => {
          if (resposta.ok) {
            const copia = resposta.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copia)).catch(() => {});
          }
          return resposta;
        })
        .catch(() => caches.match(request, { ignoreSearch: true })
          .then((salva) => salva || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((salva) => salva || fetch(request).then((resposta) => {
      if (resposta.ok) {
        const copia = resposta.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copia)).catch(() => {});
      }
      return resposta;
    }))
  );
});
