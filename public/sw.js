const CACHE_NAME = 'bingo-ajp-v1';
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
  './sounds/alarm.mp3'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});