/**
 * Журнал Зала — push-уведомления через Google Apps Script.
 *
 * Установка (один раз):
 * 1. script.google.com → «Новый проект», вставить этот файл вместо Code.gs.
 * 2. ⚙️ «Настройки проекта» → «Свойства скрипта» → добавить свойство
 *    SERVICE_ACCOUNT = всё содержимое JSON-ключа сервисного аккаунта Firebase.
 * 3. Выбрать функцию install и нажать «Выполнить», разрешить доступ.
 *    Она создаст запуск функции run каждые 5 минут.
 */
const PROJECT_ID = "planer-5a6ad";
const APP_URL = "https://antonioavanzato.github.io/planer/";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function install() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("run").timeBased().everyMinutes(5).create();
  run();
}

function run() {
  const devices = runQuery_({ from: [{ collectionId: "devices", allDescendants: true }] });
  const byUser = {};
  devices.forEach((d) => {
    if (!d.data.token) return;
    const uid = d.name.split("/users/")[1].split("/")[0];
    (byUser[uid] = byUser[uid] || []).push(d);
  });
  let sent = 0;
  Object.keys(byUser).forEach((uid) => {
    const clients = {};
    list_(`users/${uid}/clients`).forEach((d) => { clients[d.id] = Object.assign({ id: d.id }, d.data); });
    const workouts = list_(`users/${uid}/workouts`).map((d) => Object.assign({ id: d.id, _name: d.name }, d.data));
    const planned = workouts.filter((w) => w.status === "planned" && clients[w.clientId]);

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
        planned.forEach((w) => {
          const reminded = w.reminded || [];
          if (!w.time || reminded.indexOf(dev.id) >= 0) return;
          const m = minutesUntil_(w.date, w.time, now);
          if (m > dev.before || m < -10) return;
          const mins = Math.max(0, Math.round(m)), hrs = Math.round(mins / 60);
          const body = mins >= 60 ? `Через ${hrs} ${plural_(hrs, "час", "часа", "часов")}, в ${w.time}` : mins > 0 ? `Через ${mins} мин, в ${w.time}` : `Сейчас, в ${w.time}`;
          push({ title: `Тренировка: ${clients[w.clientId].name}`, body, url: `${APP_URL}#/p/${w.id}`, tag: `w-${w.id}` });
          patch_(w._name, { reminded: reminded.concat(dev.id) });
        });
      }

      // утренняя сводка
      if (dev.morning && now.time >= dev.morning && now.time < "12:00" && dev.lastDigest !== now.date) {
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
function runQuery_(q) { return api_(`${FS}:runQuery`, { method: "post", payload: JSON.stringify({ structuredQuery: q }) }).filter((r) => r.document).map((r) => toDoc_(r.document)); }
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
