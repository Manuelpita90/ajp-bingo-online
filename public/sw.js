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
  './sounds/special-alert.mp3',
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
  // Estrategia Network First para garantizar siempre el código más reciente,
  // recayendo (fallback) a Cache si falla la conexión a internet.
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Aprovechar para actualizar la caché de fondo y siempre tener la última versión
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          // Ignorar solicitudes con schemes no soportados (ej. chrome-extension)
          if (event.request.url.startsWith('http')) {
            cache.put(event.request, responseClone);
          }
        });
        return networkResponse;
      })
      .catch(() => {
        // En caso de estar sin internet (offline), devolver la memoria (caché)
        return caches.match(event.request).then((response) => {
          return response || new Response('Contenido no disponible sin conexión', { status: 503, statusText: 'Service Unavailable' });
        });
      })
  );
});