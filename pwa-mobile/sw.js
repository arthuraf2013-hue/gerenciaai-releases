// Service worker mínimo -- só cuida de dois trabalhos:
//  1) deixar o app instalável (PWA) e abrir instantaneamente mesmo com
//     internet ruim (cache do "app shell": HTML/CSS/JS, não dado).
//  2) nada de fila de pedido offline aqui -- isso já é resolvido pelo
//     cache local persistente do Firestore (ver firebase-config.js).
//
// Estratégia network-first pros arquivos do app: tenta buscar a versão
// nova primeiro (pra nunca travar numa versão velha depois de um
// deploy), cai pro cache só se a rede falhar (offline de verdade).
// Nunca intercepta chamada pro Firestore/Firebase -- só os arquivos
// deste mesmo diretório.

const CACHE = 'gerenciaai-garcom-v1';
const ARQUIVOS_SHELL = [
  './', './index.html', './styles.css', './app.js', './firebase-config.js',
  './store.js', './pairing.js', './garcom.js', './consulta.js', './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ARQUIVOS_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((chaves) => Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // nunca mexe em chamada externa (Firestore, CDN do Firebase)
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((resposta) => {
        const copia = resposta.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copia));
        return resposta;
      })
      .catch(() => caches.match(event.request).then((cache) => cache || caches.match('./index.html')))
  );
});
