// Рассылка push-уведомлений. Запускается GitHub Actions каждые 15 минут (.github/workflows/notify.yml).
// Нужен секрет FIREBASE_SERVICE_ACCOUNT — JSON ключа сервисного аккаунта Firebase.
import admin from "firebase-admin";

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const fcm = admin.messaging();
const APP_URL = process.env.APP_URL || "./";

// --- время в часовом поясе телефона ---
function localNow(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
const stamp = (date, time) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), +time.slice(0, 2), +time.slice(3, 5));
const minutesUntil = (date, time, now) => (stamp(date, time) - stamp(now.date, now.time)) / 60000;
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
const firstName = (c) => (c?.name || "Клиент").split(" ")[0];

// --- остаток абонемента (та же логика, что в app.js) ---
function packageLeft(c, workouts, today) {
  const pk = (c.packages || []).map((p) => ({ ...p, expires: addDays(p.bought, +p.days || 30), used: 0 })).sort((a, b) => a.bought.localeCompare(b.bought));
  const sessions = workouts.filter((w) => w.clientId === c.id && w.status !== "planned").sort((a, b) => a.date.localeCompare(b.date));
  for (const s of sessions) { const p = pk.find((x) => x.bought <= s.date && s.date <= x.expires && x.used < x.count); if (p) p.used++; }
  const cur = pk[pk.length - 1];
  if (!cur) return null;
  return { left: cur.count - cur.used, expired: today > cur.expires };
}

async function send(device, { title, body, url = APP_URL, tag }) {
  try {
    await fcm.send({ token: device.token, data: { title, body, url, tag: tag || "" }, webpush: { headers: { Urgency: "high", TTL: "3600" } } });
    return true;
  } catch (e) {
    console.error("send failed", device.ref.path, e.code || e.message);
    if (["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(e.code)) await device.ref.delete();
    return false;
  }
}

const devicesSnap = await db.collectionGroup("devices").get();
const byUser = {};
for (const d of devicesSnap.docs) {
  const data = d.data();
  if (!data.token) continue;
  (byUser[d.ref.parent.parent.id] ||= []).push({ ...data, id: d.id, ref: d.ref });
}

let sent = 0;
for (const [uid, devices] of Object.entries(byUser)) {
  const userRef = db.collection("users").doc(uid);
  const [clientsSnap, workoutsSnap] = await Promise.all([userRef.collection("clients").get(), userRef.collection("workouts").get()]);
  const clients = Object.fromEntries(clientsSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
  const workouts = workoutsSnap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
  const planned = workouts.filter((w) => w.status === "planned" && clients[w.clientId]);

  for (const dev of devices) {
    const now = localNow(dev.tz);

    // тестовое уведомление по кнопке в приложении
    if (dev.testRequestedAt && !(dev.testSentAt >= dev.testRequestedAt)) {
      if (await send(dev, { title: "Журнал Зала", body: "Уведомления работают 💪", tag: "test" })) sent++;
      await dev.ref.update({ testSentAt: Date.now() });
    }

    // напоминание перед тренировкой
    if (dev.before > 0) {
      for (const w of planned) {
        if (!w.time || (w.reminded || []).includes(dev.id)) continue;
        const m = minutesUntil(w.date, w.time, now);
        if (m > dev.before || m < -10) continue;
        const c = clients[w.clientId];
        const inMin = Math.max(0, Math.round(m));
        const body = inMin >= 60 ? `Через ${Math.round(inMin / 60)} ${plural(Math.round(inMin / 60), "час", "часа", "часов")} в ${w.time}` : inMin > 0 ? `Через ${inMin} мин, в ${w.time}` : `Сейчас, ${w.time}`;
        if (await send(dev, { title: `Тренировка: ${c.name}`, body, url: `${APP_URL}#/p/${w.id}`, tag: `w-${w.id}` })) sent++;
        await w.ref.update({ reminded: admin.firestore.FieldValue.arrayUnion(dev.id) });
      }
    }

    // утренняя сводка
    if (dev.morning && now.time >= dev.morning && now.time < "12:00" && dev.lastDigest !== now.date) {
      const todays = planned.filter((w) => w.date === now.date).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
      const overdue = planned.filter((w) => w.date < now.date).length;
      const ending = Object.values(clients).map((c) => ({ c, p: packageLeft(c, workouts, now.date) }))
        .filter(({ p }) => p && (p.left <= 1 || p.expired));
      const lines = [];
      if (todays.length) lines.push(todays.map((w) => `${w.time || ""} ${firstName(clients[w.clientId])}`.trim()).join(", "));
      if (ending.length) lines.push(`Абонемент: ${ending.map(({ c, p }) => `${firstName(c)} (${p.expired ? "истёк" : p.left <= 0 ? "закончился" : "ост. 1"})`).join(", ")}`);
      if (overdue) lines.push(`Не отмечено: ${overdue}`);
      if (lines.length) {
        const title = todays.length ? `Сегодня ${todays.length} ${plural(todays.length, "тренировка", "тренировки", "тренировок")}` : "Сегодня тренировок нет";
        if (await send(dev, { title, body: lines.join("\n"), url: `${APP_URL}#/s`, tag: "digest" })) sent++;
      }
      await dev.ref.update({ lastDigest: now.date });
    }
  }
}
console.log(`devices: ${devicesSnap.size}, sent: ${sent}`);
