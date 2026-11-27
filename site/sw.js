/* Service worker : garde l'app et les horaires sur le téléphone pour qu'elle s'ouvre vite, même sans réseau. */
var VERSION = "bm-v9";
var COQUILLE = [
  "./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest",
  "icones/icone-192.png", "icones/icone-512.png", "icones/favicon-32.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(COQUILLE); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== VERSION && k !== "bm-donnees"; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function reseauDabord(req, nomCache) {
  return fetch(req).then(function (r) {
    if (r.ok) { var copie = r.clone(); caches.open(nomCache).then(function (c) { c.put(req, copie); }); }
    return r;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || Response.error(); });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // Polices Google : en cache dès la première fois
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.match(req).then(function (r) {
      return r || fetch(req).then(function (res) { var copie = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copie); }); return res; });
    }));
    return;
  }
  if (url.origin !== location.origin) return; // temps réel et liens externes : directement au réseau

  if (url.pathname.indexOf("/donnees/") >= 0) {
    // Les fichiers de passages ont un nom unique : le cache suffit s'il existe.
    if (/passages-/.test(url.pathname)) {
      e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (r) { return r || reseauDabord(req, "bm-donnees"); }));
    } else {
      e.respondWith(reseauDabord(req, "bm-donnees"));
    }
    return;
  }
  // L'app elle-même : réseau d'abord pour avoir la dernière version, cache si hors ligne
  e.respondWith(reseauDabord(req, VERSION));
});
