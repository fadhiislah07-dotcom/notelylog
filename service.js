/**
 * notelylog — service worker
 * ---------------------------
 * This exists mainly so Chrome/Edge/Android consider the site "installable"
 * (they require a registered service worker with a fetch handler before
 * they'll ever fire the install prompt). As a side effect it also gives
 * the app a basic offline fallback for its own shell.
 *
 * IMPORTANT: it only ever intercepts same-origin GET requests for the
 * app's own files. Firebase Auth, Firestore, the pdf.js/Firebase/JSZip
 * CDNs, Google Fonts — all of that always goes straight to the network,
 * untouched, so sign-in and sync are never affected by this file.
 */
const CACHE_NAME = "notelylog-shell-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}) // never block install over a caching hiccup
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
  if (url.origin !== self.location.origin) return; // let every external request pass through untouched

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
