/**
 * Журнал Зала — push-уведомления и бэкапы через Google Apps Script.
 *
 * Установка (один раз):
 * 1. script.google.com → «Новый проект», вставить этот файл вместо Code.gs.
 * 2. ⚙️ «Настройки проекта» → «Свойства скрипта» → добавить свойство
 *    SERVICE_ACCOUNT = всё содержимое JSON-ключа сервисного аккаунта Firebase.
 * 3. Выбрать функцию install и нажать «Выполнить», разрешить доступ.
 *    Она создаст запуск run каждую минуту и backup раз в неделю (пн, ~3:00).
 *
 * Экономия лимита Firebase (50 000 чтений в сутки бесплатно): каждую минуту читаем
 * только записи на ближайшие дни; полную базу — лишь раз в день для утренней сводки.
 */
const PROJECT_ID = "planer-5a6ad";
const APP_URL = "https://antonioavanzato.github.io/planer/";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const BACKUP_FOLDER = "Журнал Зала — бэкапы";
const BACKUPS_TO_KEEP = 12;

function install() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("run").timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger("backup").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  run();
}

function devicesByUser_() {
  const byUser = {};
  runQuery_({ from: [{ collectionId: "devices", allDescendants: true }] }).forEach((d) => {
    if (!d.data.token) return;
    const uid = d.name.split("/users/")[1].split("/")[0];
    (byUser[uid] = byUser[uid] || []).push(d);
  });
  return byUser;
}

function run() {
  const byUser = devicesByUser_();
  let sent = 0, devices = 0;
  Object.keys(byUser).forEach((uid) => {
    devices += byUser[uid].length;
    // записи только на ближайшие дни (с запасом на часовые пояса)
    const from = Utilities.formatDate(new Date(Date.now() - 2 * 864e5), "UTC", "yyyy-MM-dd");
    const to = Utilities.formatDate(new Date(Date.now() + 2 * 864e5), "UTC", "yyyy-MM-dd");
    const near = runQuery_({
      from: [{ collectionId: "workouts" }],
      where: { compositeFilter: { op: "AND", filters: [
        { fieldFilter: { field: { fieldPath: "date" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: from } } },
        { fieldFilter: { field: { fieldPath: "date" }, op: "LESS_THAN_OR_EQUAL", value: { stringValue: to } } },
      ] } },
    }, `users/${uid}`).map((d) => Object.assign({ id: d.id, _name: d.name }, d.data));
    const plannedNear = near.filter((w) => w.status === "planned");
    const clientCache = {};
    const clientOf = (id) => {
      if (!(id in clientCache)) { try { clientCache[id] = get_(`users/${uid}/clients/${id}`); } catch (e) { clientCache[id] = null; } }
      return clientCache[id];
    };

    byUser[uid].forEach((devDoc) => {
      const dev = Object.assign({ id: devDoc.id }, devDoc.data);
      const tz = dev.tz || Session.getScriptTimeZone();
      const now = { date: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd"), time: Utilities.formatDate(new Date(), tz, "HH:mm") };
      const push = (msg) => { const ok = send_(devDoc, dev.token, msg); if (ok) sent++; return ok; };

      // тестовое уведомление по кнопке в приложении
      if (dev.testRequestedAt && !(dev.testSentAt >= dev.testRequestedAt)) {
        push({ title: "Журнал Зала", body: "Уведомления работают 💪", tag: "test" });
        patch_(devDoc.name, { testSentAt: Date.now() });
      }

      // напоминание перед тренировкой
      if (dev.before > 0) {
        plannedNear.forEach((w) => {
          const reminded = w.reminded || [];
          if (!w.time || reminded.indexOf(dev.id) >= 0) return;
          const m = minutesUntil_(w.date, w.time, now);
          if (m > dev.before || m < -10) return;
          const c = clientOf(w.clientId); if (!c) return;
          const mins = Math.max(0, Math.round(m)), hrs = Math.round(mins / 60);
          const body = mins >= 60 ? `Через ${hrs} ${plural_(hrs, "час", "часа", "часов")}, в ${w.time}` : mins > 0 ? `Через ${mins} мин, в ${w.time}` : `Сейчас, в ${w.time}`;
          push({ title: `Тренировка: ${c.name}`, body, url: `${APP_URL}#/p/${w.id}`, tag: `w-${w.id}` });
          w.reminded = reminded.concat(dev.id);
          patch_(w._name, { reminded: w.reminded });
        });
      }

      // утренняя сводка — единственное место, где нужна вся база (раз в день)
      if (dev.morning && now.time >= dev.morning && now.time < "12:00" && dev.lastDigest !== now.date) {
        const clients = {};
        list_(`users/${uid}/clients`).forEach((d) => { clients[d.id] = Object.assign({ id: d.id }, d.data); });
        const workouts = list_(`users/${uid}/workouts`).map((d) => Object.assign({ id: d.id }, d.data));
        const planned = workouts.filter((w) => w.status === "planned" && clients[w.clientId]);
        const todays = planned.filter((w) => w.date === now.date).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
        const overdue = planned.filter((w) => w.date < now.date).length;
        const ending = Object.keys(clients).map((id) => ({ c: clients[id], p: packageLeft_(clients[id], workouts, now.date) }))
          .filter((x) => x.p && (x.p.left <= 1 || x.p.expired));
        const lines = [];
        if (todays.length) lines.push(todays.map((w) => `${w.time || ""} ${firstName_(clients[w.clientId])}`.trim()).join(", "));
        if (ending.length) lines.push("Абонемент: " + ending.map((x) => `${firstName_(x.c)} (${x.p.expired ? "истёк" : x.p.left <= 0 ? "закончился" : "ост. 1"})`).join(", "));
        if (overdue) lines.push(`Не отмечено: ${overdue}`);
        if (lines.length) {
          const title = todays.length ? `Сегодня ${todays.length} ${plural_(todays.length, "тренировка", "тренировки", "тренировок")}` : "Сегодня тренировок нет";
          push({ title, body: lines.join("\n"), url: `${APP_URL}#/s`, tag: "digest" });
        }
        patch_(devDoc.name, { lastDigest: now.date });
      }
    });
  });
  console.log(`devices: ${devices}, sent: ${sent}`);
}

/** Раз в неделю кладёт полную копию данных в папку на Google Диске и хранит последние 12. */
function backup() {
  const byUser = devicesByUser_();
  const folders = DriveApp.getFoldersByName(BACKUP_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER);
  const stamp = Utilities.formatDate(new Date(), "Europe/Moscow", "yyyy-MM-dd");
  Object.keys(byUser).forEach((uid) => {
    const strip = (d) => Object.assign({ id: d.id }, d.data);
    const data = {
      app: "zhurnal-zala", version: 1, exportedAt: new Date().toISOString(),
      clients: list_(`users/${uid}/clients`).map(strip),
      workouts: list_(`users/${uid}/workouts`).map(strip),
    };
    folder.createFile(`zhurnal-${stamp}-${uid.slice(0, 6)}.json`, JSON.stringify(data), "application/json");
    console.log(`backup ${uid}: ${data.clients.length} клиентов, ${data.workouts.length} записей`);
  });
  // удаляем старые копии
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated()).slice(BACKUPS_TO_KEEP).forEach((f) => f.setTrashed(true));
}

/** Демо: сразу шлёт уведомление на все подключённые телефоны. Текст можно поменять здесь. */
function demoPush() {
  const devices = runQuery_({ from: [{ collectionId: "devices", allDescendants: true }] }).filter((d) => d.data.token);
  let sent = 0;
  devices.forEach((d) => {
    if (send_(d, d.data.token, { title: "Тренировка: Андрей Смирнов", body: "Через 1 час, в 18:00", url: APP_URL, tag: "demo" })) sent++;
  });
  console.log(`devices: ${devices.length}, sent: ${sent}`);
}

// ---------- логика ----------
function minutesUntil_(date, time, now) { return (stamp_(date, time) - stamp_(now.date, now.time)) / 60000; }
function stamp_(d, t) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), +t.slice(0, 2), +t.slice(3, 5)); }
function addDays_(iso, n) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function plural_(n, a, b, c) { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; }
function firstName_(c) { return String((c && c.name) || "Клиент").split(" ")[0]; }

// остаток абонемента — та же логика, что в app.js
function packageLeft_(c, workouts, today) {
  const pk = (c.packages || []).map((p) => Object.assign({}, p, { expires: addDays_(p.bought, +p.days || 30), used: 0 }))
    .sort((a, b) => a.bought.localeCompare(b.bought));
  workouts.filter((w) => w.clientId === c.id && w.status !== "planned").sort((a, b) => a.date.localeCompare(b.date))
    .forEach((s) => { const p = pk.find((x) => x.bought <= s.date && s.date <= x.expires && x.used < x.count); if (p) p.used++; });
  const cur = pk[pk.length - 1];
  return cur ? { left: cur.count - cur.used, expired: today > cur.expires } : null;
}

// ---------- FCM ----------
function send_(devDoc, token, msg) {
  const res = UrlFetchApp.fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + accessToken_() },
    payload: JSON.stringify({ message: { token, data: { title: msg.title, body: msg.body, url: msg.url || APP_URL, tag: msg.tag || "" }, webpush: { headers: { Urgency: "high", TTL: "3600" } } } }),
  });
  if (res.getResponseCode() === 200) return true;
  const text = res.getContentText();
  console.warn("FCM", res.getResponseCode(), text);
  if (res.getResponseCode() === 404 && /UNREGISTERED/.test(text)) { // телефон отписался — убираем его
    UrlFetchApp.fetch(`https://firestore.googleapis.com/v1/${devDoc.name}`, { method: "delete", headers: { Authorization: "Bearer " + accessToken_() }, muteHttpExceptions: true });
  }
  return false;
}

// ---------- Firestore REST ----------
function api_(url, opts) {
  const res = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true, contentType: "application/json", headers: { Authorization: "Bearer " + accessToken_() } }, opts || {}));
  if (res.getResponseCode() >= 300) throw new Error(`Firestore ${res.getResponseCode()}: ${res.getContentText()}`);
  return JSON.parse(res.getContentText() || "{}");
}
function toDoc_(d) { return { name: d.name, id: d.name.split("/").pop(), data: decodeFields_(d.fields || {}) }; }
function runQuery_(q, parent) {
  const url = parent ? `${FS}/${parent}:runQuery` : `${FS}:runQuery`;
  return api_(url, { method: "post", payload: JSON.stringify({ structuredQuery: q }) }).filter((r) => r.document).map((r) => toDoc_(r.document));
}
function get_(path) { const d = toDoc_(api_(`${FS}/${path}`)); return Object.assign({ id: d.id }, d.data); }
function list_(path) {
  let out = [], token = "";
  do {
    const r = api_(`${FS}/${path}?pageSize=300${token ? "&pageToken=" + encodeURIComponent(token) : ""}`);
    out = out.concat((r.documents || []).map(toDoc_));
    token = r.nextPageToken || "";
  } while (token);
  return out;
}
function patch_(name, fields) {
  const mask = Object.keys(fields).map((k) => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  const enc = {}; Object.keys(fields).forEach((k) => { enc[k] = encode_(fields[k]); });
  api_(`https://firestore.googleapis.com/v1/${name}?${mask}`, { method: "patch", payload: JSON.stringify({ fields: enc }) });
}
function decode_(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode_);
  if ("mapValue" in v) return decodeFields_(v.mapValue.fields || {});
  return null;
}
function decodeFields_(f) { const o = {}; Object.keys(f).forEach((k) => { o[k] = decode_(f[k]); }); return o; }
function encode_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode_) } };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  return { stringValue: String(v) };
}

// ---------- авторизация сервисным аккаунтом (JWT → OAuth-токен), кешируется на 50 минут ----------
function accessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("fb_token");
  if (cached) return cached;
  const sa = JSON.parse(PropertiesService.getScriptProperties().getProperty("SERVICE_ACCOUNT"));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (x) => Utilities.base64EncodeWebSafe(typeof x === "string" ? x : Utilities.newBlob(x).getBytes()).replace(/=+$/, "");
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({
    iss: sa.client_email, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging",
  }));
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(`${header}.${claim}`, sa.private_key)).replace(/=+$/, "");
  const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post", payload: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${sig}` },
  });
  const token = JSON.parse(res.getContentText()).access_token;
  cache.put("fb_token", token, 3000);
  return token;
}
