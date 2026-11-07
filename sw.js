// Tryb offline: aplikacja startuje bez internetu, powtórki działają. Przy każdej zmianie plików podbij numer.
const VERSION = 'emma-f67e73a7b0';
const FONT_CACHE = 'emma-fonts';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'js/app.js',
  'js/curriculum.js',
  'js/emma.js',
  'js/gemini.js',
  'js/icons.js',
  'js/lesson.js',
  'js/screen-lesson.js',
  'js/screen-other.js',
  'js/screen-setup.js',
  'js/speech.js',
  'js/store.js',
  'js/sync.js',
  'js/util.js',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' omija pamięć przeglądarki, inaczej nowa wersja mogłaby zapisać stare pliki.
  const fresh = FILES.map((file) => new Request(file, { cache: 'reload' }));
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      }),
    );
    return;
  }

  // Zapytania do Google i GitHuba idą prosto do sieci, klucz nigdy nie trafia do pamięci podręcznej.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)),
  );
});
