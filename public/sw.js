const CACHE_NAME = 'bingo-ajp-v3';
const ASSETS = [
  './',
  './index.html',
  './admin.html',
  './style.css',
  './script.js',
  './admin.js',
  './icons/ajp.png',
  './sounds/pop.mp3',
  './sounds/win.mp3',
  './sounds/fail.mp3',
  './sounds/request.mp3',
  './sounds/suspense.mp3',
  './sounds/alarm.mp3',
  './sounds/fireworks.mp3',
  './manifest.json',
  './manifest-admin.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (event) => {
  // Estrategia Cache First para assets estáticos, Network First para lo demás
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // Si está en caché, lo devolvemos (rápido)
      if (cachedResponse) {
        return cachedResponse;
      }
      // Si no, vamos a la red
      return fetch(event.request);
    })
  );
});