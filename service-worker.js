/**
 * notelylog — service worker
 * ---------------------------
 * Exists so Chrome/Edge/Android consider the site "installable" (they
 * require a registered service worker with a fetch handler before they'll
 * ever fire the install prompt), and as a side effect gives the app a
 * basic offline fallback.
 *
 * Now that almost everything lives inside index.html itself, the app
 * shell is just that one file — no more separate style.css/app.js/
 * firebase-config.js/manifest.json/icon files to track here.
 *
 * IMPORTANT: this only ever intercepts same-origin GET requests for the
 * app's own page. Firebase Auth, Firestore, the pdf.js/Firebase/JSZip
 * CDNs, Google Fonts — all of that always goes straight to the network,
 * untouched, so sign-in and sync are never affected by this file.
 *
 * CACHE_NAME is versioned on purpose: bump the suffix on any deploy where
 * you want returning visitors to pick up the new index.html promptly.
 * skipWaiting()+clients.claim() below mean a new version takes over
 * immediately (after one reload) rather than a stale version sticking
 * around silently.
 */
const CACHE_NAME = "notelylog-shell-v2";
const APP_SHELL = [
  "./",
  "./index.html"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => console.error("Service worker: shell cache failed", err))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // every external request passes through untouched

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("./index.html")))
  );
});
