// Кеш оболочки приложения, чтобы оно открывалось без интернета.
// Данные кеширует сам Firestore (IndexedDB).
const CACHE = "zhurnal-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "firebase-config.js", "manifest.webmanifest", "icons/icon.svg", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // запросы к базе и авторизации не трогаем
  if (url.hostname.endsWith("googleapis.com") && !url.hostname.startsWith("fonts.")) return;
  const isShell = url.origin === location.origin;
  const isStatic = url.hostname === "www.gstatic.com" || url.hostname.startsWith("fonts.");
  if (!isShell && !isStatic) return;
  if (isShell) {
    // свои файлы: сначала сеть (свежая версия), без сети — из кеша
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
  } else {
    // библиотеки Firebase и шрифты: сначала кеш
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })));
  }
});
