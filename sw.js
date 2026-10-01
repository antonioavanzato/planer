// Кеш оболочки приложения, чтобы оно открывалось без интернета.
// Данные кеширует сам Firestore (IndexedDB).
const CACHE = "zhurnal-v32";
const SHELL = ["./", "index.html", "style.css", "app.js", "cat.js", "share.js", "firebase-config.js", "manifest.webmanifest", "icons/icon.svg", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // раздел «Заявки» живёт сам по себе (свой service worker), Журнал его не кеширует
  if (url.pathname.includes("/zayavki/")) return;
  // запросы к базе и авторизации не трогаем
  if (url.hostname.endsWith("googleapis.com") && !url.hostname.startsWith("fonts.")) return;
  const isShell = url.origin === location.origin;
  const isStatic = url.hostname === "www.gstatic.com" || url.hostname.startsWith("fonts.");
  if (!isShell && !isStatic) return;
  if (isShell) {
    // свои файлы: сначала сеть (свежая версия), без сети — из кеша
    e.respondWith(fetch(e.request, { cache: "no-cache" }).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
  } else {
    // библиотеки Firebase и шрифты: сначала кеш
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })));
  }
});

// Push-уведомления (отправляет gas/Code.gs через Firebase Cloud Messaging)
self.addEventListener("push", (e) => {
  let j = {};
  try { j = e.data ? e.data.json() : {}; } catch { j = { notification: { title: "Журнал Зала", body: e.data?.text() } }; }
  const n = j.notification || {}, d = j.data || {};
  e.waitUntil(self.registration.showNotification(n.title || d.title || "Журнал Зала", {
    body: n.body || d.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: d.tag || undefined,
    data: { url: d.url || "./" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const win = list.find((w) => w.url.startsWith(self.registration.scope));
    if (win) { win.navigate(url).catch(() => {}); return win.focus(); }
    return self.clients.openWindow(url);
  }));
});
