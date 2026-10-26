/**
 * sw.js — Service worker da aplicação de testes.
 *
 * Estratégia: cache-first sobre os recursos estáticos (app shell). Após a
 * primeira visita, a aplicação carrega integralmente a partir do cache,
 * permitindo verificar sua disponibilidade com a conexão desativada.
 */
const CACHE = 'bench-v10';
const RECURSOS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/adapters.js',
  './js/benchmark.js',
  './js/dataset.js',
  './manifest.json'
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(CACHE).then((c) => c.addAll(RECURSOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evento) => {
  if (evento.request.method !== 'GET') return;
  evento.respondWith(
    caches.match(evento.request).then((resposta) => resposta || fetch(evento.request))
  );
});
