// Offline support for the app shell and libraries.
const VERSION = 'projsim-v2';
const ASSETS = [
  './',
  "./css/app.css",
  "./css/tokens.css",
  "./fonts/ibm-plex-mono-latin-400-normal.woff2",
  "./fonts/ibm-plex-mono-latin-500-normal.woff2",
  "./fonts/ibm-plex-mono-latin-ext-400-normal.woff2",
  "./fonts/ibm-plex-mono-latin-ext-500-normal.woff2",
  "./fonts/ibm-plex-sans-latin-400-normal.woff2",
  "./fonts/ibm-plex-sans-latin-500-normal.woff2",
  "./fonts/ibm-plex-sans-latin-600-normal.woff2",
  "./fonts/ibm-plex-sans-latin-ext-400-normal.woff2",
  "./fonts/ibm-plex-sans-latin-ext-500-normal.woff2",
  "./fonts/ibm-plex-sans-latin-ext-600-normal.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon.svg",
  "./icons/maskable-512.png",
  "./icons/maskable.svg",
  "./index.html",
  "./js/calib/colorfit.js",
  "./js/calib/detect.js",
  "./js/calib/editor.js",
  "./js/calib/pattern.js",
  "./js/calib/ui.js",
  "./js/i18n.js",
  "./js/loaders/common.js",
  "./js/loaders/image.js",
  "./js/loaders/pdf.js",
  "./js/loaders/pptx.js",
  "./js/loaders/sample.js",
  "./js/main.js",
  "./js/sim/analysis.js",
  "./js/sim/homography.js",
  "./js/sim/photometry.js",
  "./js/sim/readability.js",
  "./js/sim/renderer.js",
  "./js/sim/room.js",
  "./js/sim/scene.js",
  "./js/sim/shaders.js",
  "./js/state.js",
  "./js/store.js",
  "./js/theme.js",
  "./js/ui/controls.js",
  "./js/ui/findings.js",
  "./js/ui/fullscreen.js",
  "./js/ui/motion.js",
  "./js/ui/overlay.js",
  "./js/ui/profiles.js",
  "./js/ui/slides.js",
  "./locales/en.js",
  "./locales/tr.js",
  "./manifest.webmanifest",
  "./vendor/jszip/jszip.min.js",
  "./vendor/pdfjs/pdf.min.mjs",
  "./vendor/pdfjs/pdf.worker.min.mjs",
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate: answer from the cache, refresh it in the background so the
// next visit picks up a new deploy.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    if (res) return res;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
    return Response.error();
  }));
});
