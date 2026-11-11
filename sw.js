// Service worker Runway : met en cache l'interface pour un lancement rapide.
// Les calculs d'itinéraire, l'altitude et les fonds de carte passent toujours par le réseau.
const CACHE = "runway-v3";
const SHELL = [
  "./", "index.html", "css/app.css?v=3", "manifest.webmanifest",
  "js/app.js?v=3", "js/api.js?v=3", "js/engine.js?v=3", "js/geo.js?v=3", "js/mapview.js?v=3", "js/run.js?v=3", "js/store.js?v=3",
  "icons/icon.svg", "icons/icon-192.png", "icons/apple-touch-icon.png",
  "vendor/leaflet/leaflet.css", "vendor/leaflet/leaflet.js",
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const isShell = url.origin === location.origin || url.hostname.endsWith("gstatic.com") || url.hostname === "fonts.googleapis.com";
  if (e.request.method !== "GET" || !isShell) return; // API et tuiles : réseau direct
  // Réseau d'abord (mises à jour immédiates), cache en secours hors ligne.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});
