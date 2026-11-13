/* Haze Tracker SG - service worker: offline app shell + background alert checks. */
importScripts('core.js');

var CACHE = 'haze-tracker-v1';
var SHELL = [
  './', 'index.html', 'styles.css', 'core.js', 'app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// App shell: serve from cache, refresh it in the background. NEA API calls are never cached here.
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached || (req.mode === 'navigate' ? caches.match('index.html') : undefined); });
      return cached || network;
    })
  );
});

// Chrome on Android (installed app) can wake us periodically to check the threshold.
self.addEventListener('periodicsync', function (e) {
  if (e.tag !== 'haze-check') return;
  e.waitUntil(
    self.Haze.runCheck(function (title, options) { return self.registration.showNotification(title, options); })
      .catch(function () { /* offline or API error: try again next time */ })
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
      for (var i = 0; i < wins.length; i++) if ('focus' in wins[i]) return wins[i].focus();
      return self.clients.openWindow('./');
    })
  );
});
