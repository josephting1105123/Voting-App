/* Quick Vote service worker: network-first for the static shell, so a deploy shows up on the next online load.
 * The cache is only the offline fallback and is refreshed on every successful fetch.
 * Socket.IO, the API and everything else go straight to the network and are never cached.
 * No version bump is needed for freshness. CACHE_VERSION only matters if you want to discard everything cached:
 * activate deletes any cache with a different name. */
'use strict';

const CACHE_VERSION = 'v1';
const CACHE = 'quick-vote-' + CACHE_VERSION;

const SHELL = [
  '/',
  '/index.html',
  '/create.html',
  '/admin.html',
  '/vote.html',
  '/style.css',
  '/js/theme.js',
  '/js/common.js',
  '/js/create.js',
  '/js/admin.js',
  '/js/vote.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];
const SHELL_PATHS = new Set(SHELL);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/api/')) return;
  if (!SHELL_PATHS.has(url.pathname)) return; // anything not in the shell (e.g. /healthz) is untouched

  event.respondWith(networkFirst(event, url));
});

async function networkFirst(event, url) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    // Store under the bare path so query strings (pins, names) never become cache keys.
    if (res.ok && res.type === 'basic' && !res.redirected) {
      event.waitUntil(cache.put(url.pathname, res.clone()).catch(() => {}));
    }
    return res;
  } catch (err) {
    // Offline or server unreachable: fall back to the last good copy. ignoreSearch so
    // /?pin=123456 and /vote.html?pin=...&name=... use the cached page; the query is read by JS.
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
