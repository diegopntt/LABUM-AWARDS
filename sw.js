// LABUM Awards — service worker simples: deixa o site instalável e abre a última versão
// mesmo sem internet. Sempre tenta a rede primeiro, então atualizações na Vercel chegam na hora.
const CACHE = "labum-v1";
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(["/"])).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return; // votos e painel: sempre direto no servidor
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put("/", copy)); return r; }).catch(() => caches.match("/")));
  }
});
