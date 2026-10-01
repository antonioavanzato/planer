import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, doc, onSnapshot, setDoc, getDoc, deleteDoc, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getMessaging, getToken, deleteToken, isSupported as messagingSupported } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js";
import { firebaseConfig, vapidKey } from "./firebase-config.js";
import { initCat } from "./cat.js";
import { progressCard } from "./share.js";

// Firestore хранит копию данных на телефоне и досылает изменения, когда появляется сеть.
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }) });

const APP_VERSION = "31";

const DEFAULT_EXERCISES = [
  "Присед со штангой", "Жим лёжа", "Становая тяга", "Жим стоя", "Тяга штанги в наклоне",
  "Подтягивания", "Жим ногами", "Румынская тяга", "Выпады", "Тяга верхнего блока",
  "Жим гантелей на наклонной", "Сгибания на бицепс", "Французский жим", "Разводка гантелей",
];

const state = {
  user: null, clients: [], workouts: [],
  pending: false, pendingBy: {}, loaded: false,
  filter: "all", query: "", chartEx: {},
  draft: null, // тренировка, которая сейчас редактируется
};
let unsubs = [];
const $app = document.getElementById("app");

// ---------- утилиты ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
// дата по местному времени телефона (toISOString дал бы UTC: в Казани с 0:00 до 3:00 было бы «вчера»)
const localISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => localISO();
const num = (v) => { const n = parseFloat(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
const fmt = (n) => (n == null ? "—" : (Math.round(n * 10) / 10).toString().replace(".", ","));
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("") || "?";
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const dateRu = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? " " + y : ""}`; };
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const dayLabel = (iso) => { const d = -Math.round((new Date(today()) - new Date(iso)) / 864e5); return d === 0 ? "Сегодня" : d === 1 ? "Завтра" : d === -1 ? "Вчера" : `${WEEKDAYS[new Date(iso + "T00:00:00Z").getUTCDay()]}, ${dateRu(iso)}`; };
const daysAgo = (iso) => Math.round((new Date(today()) - new Date(iso)) / 864e5);
const agoRu = (iso) => { const d = daysAgo(iso); if (d <= 0) return "Сегодня"; if (d === 1) return "Вчера"; if (d < 7) return `${d} дн. назад`; if (d < 14) return "Неделю назад"; if (d < 60) return `${Math.floor(d / 7)} нед. назад`; return dateRu(iso); };
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };

const userCol = (name) => collection(db, "users", state.user.uid, name);
const userDoc = (name, id) => doc(db, "users", state.user.uid, name, id);

// ---------- расчёты прогресса ----------
const byDate = (a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0);
const isPlanned = (w) => w.status === "planned";
const byWhen = (a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || "") || (a.createdAt || 0) - (b.createdAt || 0);
const allOf = (cid) => state.workouts.filter((w) => w.clientId === cid);
const plannedOf = (cid) => allOf(cid).filter(isPlanned).sort(byWhen);
const plannedAll = () => state.workouts.filter((w) => isPlanned(w) && state.clients.some((c) => c.id === w.clientId)).sort(byWhen);
const sessionsOf = (cid) => allOf(cid).filter((w) => !isPlanned(w)).sort(byDate); // проведённые тренировки + поздние отмены
const workoutsOf = (cid) => allOf(cid).filter((w) => !isPlanned(w) && w.kind !== "cancel").sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
const bestSet = (ex) => (ex?.sets || []).reduce((best, s) => { const w = num(s.w), r = num(s.r); if (w == null) return best; return !best || w > best.w || (w === best.w && (r || 0) > (best.r || 0)) ? { w, r } : best; }, null);

function exerciseHistory(cid, name) {
  const out = [];
  for (const w of workoutsOf(cid)) {
    const ex = (w.exercises || []).find((e) => e.name === name);
    const b = bestSet(ex);
    if (b) out.push({ date: w.date, ...b });
  }
  return out;
}
function exerciseNames(cid) {
  const count = {};
  for (const w of workoutsOf(cid)) for (const e of w.exercises || []) if (bestSet(e)) count[e.name] = (count[e.name] || 0) + 1;
  return Object.keys(count).sort((a, b) => count[b] - count[a]);
}
function clientGain(cid) {
  // прирост по самому частому упражнению клиента
  const name = exerciseNames(cid)[0];
  if (!name) return null;
  const h = exerciseHistory(cid, name);
  return h.length ? h[h.length - 1].w - h[0].w : null;
}
function isRecord(cid, workout, ex) {
  const b = bestSet(ex); if (!b) return false;
  const before = workoutsOf(cid).filter((w) => w.id !== workout.id && (w.date < workout.date || (w.date === workout.date && (w.createdAt || 0) < (workout.createdAt || 0))));
  const prevMax = Math.max(-Infinity, ...before.map((w) => bestSet((w.exercises || []).find((e) => e.name === ex.name))?.w ?? -Infinity));
  return prevMax > -Infinity && b.w > prevMax;
}
function previousExercise(cid, workout, name) {
  const before = workoutsOf(cid).filter((w) => w.id !== workout.id && w.date <= workout.date).reverse();
  for (const w of before) { const e = (w.exercises || []).find((x) => x.name === name); if (bestSet(e)) return e; }
  return null;
}
const tonnage = (w) => (w.exercises || []).reduce((t, e) => t + (e.sets || []).reduce((s, x) => s + (num(x.w) || 0) * (num(x.r) || 0), 0), 0);

// ---------- авторизация и подписки ----------
// Заставка держится минимум 1,5 с, максимум 6 с; касание — сразу убрать.
let splashDone = false;
function hideSplash(force = false) {
  const el = document.getElementById("splash");
  if (!el || splashDone) return;
  const wait = force ? 0 : Math.max(0, 1500 - (Date.now() - (window.__splashStart || 0)));
  splashDone = true;
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 650); }, wait);
}
setTimeout(() => hideSplash(true), 6000);

onAuthStateChanged(auth, (user) => {
  unsubs.forEach((u) => u()); unsubs = [];
  state.user = user; state.clients = []; state.workouts = []; state.loaded = false;
  if (!user) { hideSplash(); return render(); }
  let got = 0;
  const done = () => { if (++got >= 2) { state.loaded = true; hideSplash(); } };
  const watch = (name, key) => onSnapshot(userCol(name), { includeMetadataChanges: true }, (snap) => {
    state[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // «Отправка…» пока хоть в одной коллекции есть неотправленные изменения
    state.pendingBy[key] = snap.metadata.hasPendingWrites;
    state.pending = Object.values(state.pendingBy).some(Boolean);
    done(); scheduleRender();
  }, (err) => { console.error(err); showError(err); });
  unsubs.push(watch("clients", "clients"), watch("workouts", "workouts"));
  render();
});

function showError(err) {
  const msg = err.code === "permission-denied" ? "Нет доступа к базе. Проверь правила Firestore." : err.message;
  const bar = document.createElement("div");
  bar.className = "err"; bar.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;background:var(--card);padding:12px;border-radius:12px;border:1px solid var(--line);z-index:20";
  bar.textContent = msg; document.body.append(bar); setTimeout(() => bar.remove(), 6000);
}

// ---------- маршрутизация ----------
window.addEventListener("hashchange", () => { flushDraft(); dockState.hidden = false; dockState.lastY = 0; render(); });
window.addEventListener("online", () => scheduleRender());
window.addEventListener("offline", () => scheduleRender());
const route = () => { const [, view, id] = (location.hash || "#/").split("/"); return { view: view || "", id }; };
const go = (h) => { location.hash = h; };

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return; renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    // не перерисовываем экран тренировки, пока по нему печатают
    if (route().view === "w" && state.draft) { updateSync(); return; }
    render();
  });
}

function syncBadge() {
  if (!navigator.onLine) return `<span class="sync offline" id="sync"><i></i>Офлайн</span>`;
  if (state.pending) return `<span class="sync pending" id="sync"><i></i>Отправка…</span>`;
  return `<span class="sync" id="sync"><i></i>В облаке</span>`;
}
function updateSync() { const el = document.getElementById("sync"); if (el) el.outerHTML = syncBadge(); }

const kitty = (() => { try { return initCat(); } catch (e) { console.error(e); return { setVisible() {}, setFloor() {} }; } })();
window.__kitty = kitty;

function render() {
  renderScreen();
  // котик ходит по верхней кромке карточки «Сегодня» на главном экране
  const { view: v0 } = route();
  kitty.setFloor(state.user && v0 === "" ? document.querySelector(".status") : null);
}
// «Заявки» — отдельное приложение yana-admin (свой код, своя база в Яндекс Облаке, свой вход).
// Показываем его как есть в окне; создаём один раз и держим, чтобы не перезагружалось при переключении вкладок.
const ADMIN_URL = new URL("../yana-admin/", location.href).href;
let adminFrame = null;
function showAdmin(on) {
  if (on && !adminFrame) {
    adminFrame = document.createElement("iframe");
    adminFrame.className = "admin-frame";
    adminFrame.title = "Заявки";
    adminFrame.src = ADMIN_URL;
    adminFrame.addEventListener("load", themeAdmin);
    document.body.append(adminFrame);
  }
  adminFrame?.classList.toggle("on", on);
  document.body.classList.toggle("admin-open", on);
}
// Перекрашиваем «Заявки» в цвета журнала. Меняем только вид этого окна (те же переменные CSS),
// сам код и данные «Заявок» не трогаем; отдельное приложение «Заявки» остаётся в своём оформлении.
const ADMIN_THEME = `
:root{
  --primary:#c2861c; --primary-mid:#a8721a; --primary-pale:#f5e7cc; --accent:#c2861c;
  --surface:#f7f8f5; --surface-deep:#e8ebe6; --card:#ffffff; --white:#ffffff;
  --ink:#1b1f1c; --ink-60:rgba(27,31,28,.6); --ink-30:rgba(27,31,28,.32); --ink-07:rgba(27,31,28,.09);
  --done:#2f8a4e; --done-bg:#dcefe1; --new:#c2861c; --new-bg:#f5e7cc; --danger:#b23b30; --danger-bg:#f8e3e0;
}
@media (prefers-color-scheme:dark){:root{
  color-scheme:dark;
  --primary:#e0a33a; --primary-mid:#c98f2a; --primary-pale:#3a2e17; --accent:#e0a33a;
  --surface:#161a17; --surface-deep:#232924; --card:#1f2420; --white:#1f2420;
  --ink:#eef0ec; --ink-60:rgba(238,240,236,.62); --ink-30:rgba(238,240,236,.34); --ink-07:rgba(238,240,236,.1);
  --done:#5cc07c; --done-bg:#1c3324; --new:#e0a33a; --new-bg:#3a2e17; --danger:#e56b5f; --danger-bg:#3a1f1c;
}}
body,input,textarea,select,button{font-family:"Manrope",system-ui,-apple-system,sans-serif!important}
.login-title,.topbar-name,.bcard-name,.bcard-time,[class*="title"],h1,h2,h3{font-family:"Manrope",system-ui,sans-serif!important}
.icon-btn.bell-on{background:var(--primary-pale)!important}
/* своё нижнее меню «Заявок» становится переключателем в шапке — внизу остаётся одна пилюля Журнала */
.topbar .bottom-nav,.topbar .bottom-nav.nav-hidden{position:static!important;transform:none!important;opacity:1!important;pointer-events:auto!important;
  width:auto!important;max-width:none!important;height:38px!important;margin:.85rem 0 0!important;padding:3px!important;gap:3px;
  background:var(--surface-deep)!important;border:0!important;border-radius:12px!important;box-shadow:none!important;
  -webkit-backdrop-filter:none!important;backdrop-filter:none!important;z-index:auto!important}
.topbar .nav-item{flex-direction:row!important;gap:6px!important;border-radius:9px!important;color:var(--ink-60)!important}
.topbar .nav-item svg{width:15px!important;height:15px!important;transform:none!important}
.topbar .nav-item span{font-size:.8rem!important;text-transform:none!important;letter-spacing:0!important}
.topbar .nav-item.active{background:var(--card)!important;color:var(--primary)!important;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.scroll-area{padding-bottom:1.5rem!important}
.modal-sheet:not(.open){box-shadow:none!important}
`;
function themeAdmin() {
  try {
    const d = adminFrame.contentDocument; if (!d || d.getElementById("journal-theme")) return;
    const font = d.createElement("link");
    font.rel = "stylesheet";
    font.href = "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap";
    const st = d.createElement("style"); st.id = "journal-theme"; st.textContent = ADMIN_THEME;
    d.head.append(font, st);
    const nav = d.getElementById("bottomNav"), top = d.querySelector(".topbar");
    if (nav && top) top.append(nav);
  } catch (e) { console.warn("theme", e); }
}

function renderAdmin() {
  $app.innerHTML = dock("admin", null, "");
}

function renderScreen() {
  showAdmin(!!state.user && route().view === "z");
  if (!state.user) return renderLogin();
  const { view, id } = route();
  if (view === "z") return renderAdmin();
  if (view === "c" && id) return renderClient(id);
  if (view === "w" && id) return renderWorkout(id);
  if (view === "p" && id) return renderPlanned(id);
  if (view === "s") return renderSchedule();
  renderClients();
}

// ---------- экран входа ----------
function renderLogin() {
  $app.innerHTML = `
  <form class="login" id="loginForm">
    <div class="lbl" style="color:var(--accent)">Дневник тренера</div>
    <h1>Журнал Зала</h1>
    <div class="field"><label class="lbl" for="email">Почта</label><input class="input" id="email" type="email" autocomplete="username" required></div>
    <div class="field"><label class="lbl" for="pass">Пароль</label><input class="input" id="pass" type="password" autocomplete="current-password" required></div>
    <div class="err" id="loginErr"></div>
    <button class="btn block" type="submit">Войти</button>
  </form>`;
  document.getElementById("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("loginErr"); errEl.textContent = "";
    try { await signInWithEmailAndPassword(auth, email.value.trim(), pass.value); }
    catch (err) {
      errEl.textContent = ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-email"].includes(err.code)
        ? "Неверная почта или пароль." : err.code === "auth/network-request-failed" ? "Нет интернета. Первый вход нужен онлайн." : err.message;
    }
  };
}

// ---------- список клиентов ----------
const avatar = (c) => c.photo
  ? `<img class="ava" src="${esc(c.photo)}" alt="">`
  : `<div class="ava">${esc(initials(c.name))}</div>`;

// сжимаем фото до квадратной аватарки ~320px, чтобы хранить прямо в карточке клиента
async function photoToDataUrl(file, size = 320) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight, side = Math.min(w, h);
    const cv = document.createElement("canvas"); cv.width = cv.height = size;
    cv.getContext("2d").drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
    return cv.toDataURL("image/jpeg", 0.8);
  } finally { URL.revokeObjectURL(url); }
}

function lastWorkout(cid) { const ws = workoutsOf(cid); return ws[ws.length - 1]; }

// ---------- абонементы ----------
// Пакет: { id, bought, count, days }. Занятия списываются сами: каждая тренировка или поздняя отмена
// попадает в самый ранний действующий пакет, где ещё есть место.
const PACKAGE_DAYS = { 5: 30, 10: 45 };
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function packagesOf(c, withPlanned = false) {
  const pk = (c.packages || []).map((p) => ({ ...p, expires: addDays(p.bought, +p.days || 30), used: 0 }))
    .sort((a, b) => a.bought.localeCompare(b.bought));
  const alloc = {};
  const sessions = withPlanned ? [...sessionsOf(c.id), ...plannedOf(c.id)] : sessionsOf(c.id);
  for (const sess of sessions) {
    const p = pk.find((x) => x.bought <= sess.date && sess.date <= x.expires && x.used < x.count);
    if (p) alloc[sess.id] = { p, n: ++p.used };
  }
  for (const p of pk) {
    p.left = p.count - p.used;
    p.expired = today() > p.expires;
    p.daysLeft = daysAgo(p.expires) * -1;
    p.level = p.left <= 0 || p.expired ? "bad" : p.left <= 2 || p.daysLeft <= 3 ? "warn" : "ok";
  }
  return { list: pk, current: pk[pk.length - 1] || null, alloc };
}

function packageTag(c) {
  const { current: p } = packagesOf(c);
  if (!p || p.level === "ok") return "";
  const text = p.left <= 0 ? "абонемент закончился" : p.expired ? "абонемент истёк" : `ост. ${p.left}`;
  return ` · <span class="pk-tag pk-${p.level}">${text}</span>`;
}

function packagePanel(c) {
  const { list, current: p } = packagesOf(c);
  const actions = `<div class="pk-actions"><button class="link" data-act="newPkg" data-id="${c.id}">+ Новый абонемент</button>
    ${p ? `<button class="link" data-act="lateCancel" data-id="${c.id}">Поздняя отмена</button>` : ""}</div>`;
  if (!p) return `<div class="panel"><div class="lbl">Абонемент</div><div class="meta" style="margin:6px 0 4px">Абонемента нет.</div>${actions}</div>`;
  const planned = plannedOf(c.id).filter((w) => w.date >= today()).length;
  const short = planned - Math.max(p.left, 0);
  const status = p.left <= 0 ? "Все занятия использованы" : p.expired ? `Срок истёк ${dateRu(p.expires)}` : `Действует ещё ${p.daysLeft} ${plural(p.daysLeft, "день", "дня", "дней")}`;
  const history = list.slice(0, -1).reverse();
  return `<div class="panel pk pk-${p.level}">
    <div class="pk-h"><span class="lbl">Абонемент</span><button class="link quiet small" data-act="editPkg" data-id="${c.id}" data-pid="${p.id}">${dateRu(p.bought)} – ${dateRu(p.expires)}${PEN}</button></div>
    <div class="pk-n"><b>${Math.max(p.left, 0)}</b><span>${plural(Math.max(p.left, 0), "занятие осталось", "занятия осталось", "занятий осталось")} из ${p.count}</span></div>
    <div class="seg" aria-hidden="true">${Array.from({ length: p.count }, (_, i) => `<i class="${i < p.used ? "on" : ""}"></i>`).join("")}</div>
    <div class="pk-status">${status}${planned ? ` · запланировано ${planned}` : ""}</div>
    ${short > 0 && !p.expired ? `<div class="pk-warn-line">Запланировано больше, чем осталось в абонементе: не хватает ${short}. Пора продлить.</div>` : ""}
    ${actions}
    ${history.length ? `<details class="pk-hist"><summary>История абонементов · ${history.length}</summary>
      ${history.map((h) => `<button class="sess" data-act="editPkg" data-id="${c.id}" data-pid="${h.id}"><span>${dateRu(h.bought)} – ${dateRu(h.expires)}</span><span class="meta">${h.used} из ${h.count}${h.used < h.count && h.expired ? " · сгорело " + (h.count - h.used) : ""}</span></button>`).join("")}
    </details>` : ""}
  </div>`;
}

function savePackages(c, packages) {
  setDoc(userDoc("clients", c.id), { packages, updatedAt: Date.now() }, { merge: true }).catch(showError);
}

function packageSheet(c, pid) {
  const cur = (c.packages || []).find((p) => p.id === pid);
  const bg = sheet(`
    <div class="navrow"><button type="button" class="link quiet" data-close>Отмена</button><b>${cur ? "Абонемент" : "Новый абонемент"}</b><button class="link primary" type="submit">Сохранить</button></div>
    <div class="field"><label class="lbl" for="p-date">Дата покупки</label><input class="input" id="p-date" name="bought" type="date" required value="${cur?.bought || today()}"></div>
    <div class="field"><span class="lbl">Пакет</span><div class="chips">
      <button type="button" class="chip" data-preset="5">5 занятий · 30 дней</button>
      <button type="button" class="chip" data-preset="10">10 занятий · 45 дней</button>
    </div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="field"><label class="lbl" for="p-count">Занятий</label><input class="input" id="p-count" name="count" inputmode="numeric" required value="${cur?.count || 10}"></div>
      <div class="field"><label class="lbl" for="p-days">Срок, дней</label><input class="input" id="p-days" name="days" inputmode="numeric" required value="${cur?.days || 45}"></div>
    </div>
    <div class="meta" id="p-until"></div>
    ${cur ? `<button type="button" class="link danger" id="p-del">Удалить абонемент</button>` : ""}
  `, (fd) => {
    const count = parseInt(fd.get("count"), 10), days = parseInt(fd.get("days"), 10);
    if (!(count > 0) || !(days > 0)) return false;
    const item = { id: cur?.id || uid(), bought: fd.get("bought") || today(), count, days };
    savePackages(c, cur ? c.packages.map((p) => (p.id === cur.id ? item : p)) : [...(c.packages || []), item]);
  });
  const $ = (id) => bg.querySelector("#" + id);
  const sync = () => {
    const n = $("p-count").value, d = $("p-days").value;
    bg.querySelectorAll("[data-preset]").forEach((b) => b.classList.toggle("on", +b.dataset.preset === +n && PACKAGE_DAYS[n] === +d));
    $("p-until").textContent = +d > 0 ? `Действует до ${dateRu(addDays($("p-date").value || today(), +d))}` : "";
  };
  bg.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => { $("p-count").value = b.dataset.preset; $("p-days").value = PACKAGE_DAYS[b.dataset.preset]; sync(); }));
  ["p-count", "p-days", "p-date"].forEach((id) => $(id).addEventListener("input", sync));
  sync();
  $("p-del")?.addEventListener("click", () => {
    const before = c.packages.slice();
    savePackages(c, before.filter((p) => p.id !== cur.id));
    bg.remove();
    undoToast("Абонемент удалён", () => savePackages(c, before));
  });
}

function lateCancelSheet(c) {
  sheet(`
    <div class="navrow"><button type="button" class="link quiet" data-close>Отмена</button><b>Поздняя отмена</b><span></span></div>
    <div class="meta">Клиент отменил или перенёс тренировку менее чем за 6 часов. Занятие спишется с абонемента.</div>
    <div class="field"><label class="lbl" for="lc-date">Дата тренировки</label><input class="input" id="lc-date" name="date" type="date" required value="${today()}"></div>
    <button class="btn block" type="submit">Списать занятие</button>
  `, (fd) => {
    const id = uid();
    const item = { clientId: c.id, kind: "cancel", date: fd.get("date") || today(), title: "Поздняя отмена", createdAt: Date.now(), exercises: [] };
    setDoc(userDoc("workouts", id), item).catch(showError);
    state.workouts.push({ id, ...item }); render();
  });
}

const CHEV_L = `<svg class="ico-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>`;
const CHEV_R = `<svg class="ico-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>`;
const PEN = `<svg class="ico-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>`;

const TAB_ICONS = {
  clients: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.5 3.5 5.2"/></svg>`,
  schedule: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  admin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
  more: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>`,
};
// Док внизу: пилюля с вкладками + отдельная круглая кнопка «+» на одном уровне.
function dock(active, fabAct, fabLabel) {
  const all = plannedAll();
  const overdue = all.filter((w) => w.date < today()).length;
  const badge = overdue + all.filter((w) => w.date === today()).length;
  return `<div class="dock ${dockState.hidden ? "is-hidden" : ""}" id="dock"><nav class="tabbar" aria-label="Разделы">
    <button class="tab ${active === "clients" ? "on" : ""}" data-go="#/">${TAB_ICONS.clients}<span>Клиенты</span></button>
    <button class="tab ${active === "schedule" ? "on" : ""}" data-go="#/s">${TAB_ICONS.schedule}<span>Расписание</span>${badge ? `<i class="badge ${overdue ? "bad" : ""}" aria-label="Записей: ${badge}">${badge > 99 ? "99+" : badge}</i>` : ""}</button>
    <button class="tab ${active === "admin" ? "on" : ""}" data-go="#/z">${TAB_ICONS.admin}<span>Заявки</span></button>
    <button class="tab" data-act="menu">${TAB_ICONS.more}<span>Ещё</span></button>
  </nav>${fabAct ? `<button class="fab" data-act="${fabAct}" aria-label="${fabLabel}">+</button>` : ""}</div>`;
}

// Прячем пилюлю при прокрутке вниз и показываем при прокрутке вверх.
// Меняется только класс (transform/opacity в CSS), поэтому прокрутка не тормозит.
const dockState = { hidden: false, lastY: 0, ticking: false, route: "" };
function setDockHidden(v) {
  if (dockState.hidden === v) return;
  dockState.hidden = v;
  document.getElementById("dock")?.classList.toggle("is-hidden", v);
}
window.addEventListener("scroll", () => {
  if (dockState.ticking) return;
  dockState.ticking = true;
  requestAnimationFrame(() => {
    dockState.ticking = false;
    const y = Math.max(0, window.scrollY);
    const max = document.documentElement.scrollHeight - innerHeight;
    const dy = y - dockState.lastY;
    if (y < 60) setDockHidden(false);                 // у самого верха — всегда видно
    else if (y > max - 4 && max > 0) { /* пружина iOS у низа — не дёргаем */ }
    else if (dy > 8) setDockHidden(true);             // вниз
    else if (dy < -8) setDockHidden(false);           // вверх
    else return;                                      // мелкое дрожание пальца — не считаем
    dockState.lastY = y;
  });
}, { passive: true });

function renderClients() {
  const q = state.query.toLowerCase();
  let list = state.clients.map((c) => ({ c, last: lastWorkout(c.id), n: workoutsOf(c.id).length }));
  if (q) list = list.filter(({ c }) => c.name.toLowerCase().includes(q));
  if (state.filter === "today") list = list.filter(({ last }) => last && daysAgo(last.date) === 0);
  if (state.filter === "pkg") list = list.filter(({ c }) => ["warn", "bad"].includes(packagesOf(c).current?.level));
  if (state.filter === "stale") list = list.filter(({ last }) => !last || daysAgo(last.date) >= 14);
  list.sort((a, b) => (b.last?.date || "").localeCompare(a.last?.date || "") || a.c.name.localeCompare(b.c.name));
  const todayN = state.clients.filter((c) => { const l = lastWorkout(c.id); return l && daysAgo(l.date) === 0; }).length;

  const rows = list.map(({ c, last, n }) => {
    const g = clientGain(c.id);
    return `<button class="row" data-go="#/c/${c.id}">
      ${avatar(c)}
      <div><div class="nm">${esc(c.name)}</div><div class="sub">${last ? `${agoRu(last.date)} · ${esc(last.title || "Тренировка")}` : "Ещё не тренировался"} · ${n} ${plural(n, "тренировка", "тренировки", "тренировок")}${packageTag(c)}</div></div>
      ${g != null ? `<span class="delta ${g <= 0 ? "zero" : ""}">${g > 0 ? "+" : ""}${fmt(g)} кг</span>` : ""}
    </button>`;
  }).join("");

  $app.innerHTML = `<main class="screen">
    <div class="navrow"><span class="meta">${dateRu(today())}</span>${syncBadge()}</div>
    ${todayBlock()}
    <h1>Клиенты</h1>
    <input class="input" id="search" type="search" placeholder="Поиск по имени" value="${esc(state.query)}">
    <div class="chips">
      <button class="chip ${state.filter === "all" ? "on" : ""}" data-filter="all">Все · ${state.clients.length}</button>
      <button class="chip ${state.filter === "today" ? "on" : ""}" data-filter="today">Сегодня · ${todayN}</button>
      <button class="chip ${state.filter === "pkg" ? "on" : ""}" data-filter="pkg">Абонемент · ${state.clients.filter((c) => ["warn", "bad"].includes(packagesOf(c).current?.level)).length}</button>
      <button class="chip ${state.filter === "stale" ? "on" : ""}" data-filter="stale">Давно не было</button>
    </div>
    ${rows ? `<div class="list">${rows}</div>` : `<div class="list"><div class="empty">${state.clients.length ? "Никого не найдено." : state.loaded ? "Пока нет клиентов.<br>Нажми «+», чтобы добавить первого." : "Загрузка…"}</div></div>`}
  </main>
  ${dock("clients", "newClient", "Новый клиент")}`;

  kitty.setFloor(document.querySelector(".status"));
  const s = document.getElementById("search");
  s.oninput = () => { state.query = s.value; const pos = s.selectionStart; renderClients(); const n = document.getElementById("search"); n.focus(); n.setSelectionRange(pos, pos); };
}

// ---------- карточка клиента ----------
function chartSvg(hist) {
  if (hist.length < 2) return `<div class="meta" style="margin-top:8px">График появится после второй тренировки с этим упражнением.</div>`;
  const W = 300, H = 120, L = 30, R = 8, T = 10, B = 20;
  const ws = hist.map((h) => h.w);
  let lo = Math.min(...ws), hi = Math.max(...ws); if (hi === lo) { hi += 5; lo -= 5; }
  const x = (i) => L + (i * (W - L - R)) / (hist.length - 1);
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const pts = hist.map((h, i) => `${x(i).toFixed(1)},${y(h.w).toFixed(1)}`).join(" ");
  const last = hist.length - 1;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Рабочий вес: от ${fmt(hist[0].w)} до ${fmt(hist[last].w)} кг">
    <g stroke="var(--line)"><line x1="${L}" y1="${y(hi)}" x2="${W - R}" y2="${y(hi)}"/><line x1="${L}" y1="${y(lo)}" x2="${W - R}" y2="${y(lo)}"/></g>
    <g fill="var(--muted)" font-family="JetBrains Mono,monospace" font-size="9">
      <text x="0" y="${y(hi) + 3}">${fmt(hi)}</text><text x="0" y="${y(lo) + 3}">${fmt(lo)}</text>
      <text x="${L}" y="${H - 4}">${dateRu(hist[0].date)}</text><text x="${W - R}" y="${H - 4}" text-anchor="end">${dateRu(hist[last].date)}</text>
    </g>
    <path d="M${x(0)},${y(lo)} L${pts.replace(/ /g, " L")} L${x(last)},${y(lo)} Z" fill="var(--accent)" opacity=".15"/>
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(0)}" cy="${y(hist[0].w)}" r="3.5" fill="var(--card)" stroke="var(--muted)" stroke-width="2"/>
    <circle cx="${x(last)}" cy="${y(hist[last].w)}" r="4.5" fill="var(--accent)"/>
  </svg>`;
}

const SHARE_ICON = `<svg class="ico-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>`;

// «Поделиться прогрессом»: готовим картинку заранее, чтобы кнопка «Отправить» сработала сразу по касанию
async function shareSheet(cid) {
  const c = state.clients.find((x) => x.id === cid); if (!c) return;
  const names = exerciseNames(cid);
  const ex = names.includes(state.chartEx[cid]) ? state.chartEx[cid] : names[0];
  const hist = ex ? exerciseHistory(cid, ex) : [];
  if (hist.length < 2) return;
  const firstName = c.name.trim().split(/\s+/)[0];
  const ws = workoutsOf(cid);
  const records = ws.reduce((n, w) => n + (w.exercises || []).filter((e) => e.name === ex && isRecord(cid, w, e)).length, 0);
  const bg = sheet(`
    <div class="navrow center"><b>Прогресс · ${esc(firstName)}</b></div>
    <div class="share-prev"><div class="n-loading"><span></span><span></span><span></span></div></div>
    <button type="button" class="btn block" id="sh-send" disabled>${SHARE_ICON}Отправить</button>
    <div class="meta" id="sh-hint">На картинке только имя, без фамилии. Если меню не открылось, нажми и подержи картинку, чтобы сохранить её в «Фото».</div>
  `, () => false);
  const blob = await progressCard({ name: firstName, exercise: ex, hist, workouts: ws.length, records });
  if (!bg.isConnected || !blob) return;
  const url = URL.createObjectURL(blob);
  bg.querySelector(".share-prev").innerHTML = `<img src="${url}" alt="Прогресс ${esc(firstName)}: ${esc(ex)}">`;
  const file = new File([blob], `progress-${localISO()}.png`, { type: "image/png" });
  const send = bg.querySelector("#sh-send");
  send.disabled = false;
  send.onclick = async () => {
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
      else { const a = document.createElement("a"); a.href = url; a.download = file.name; a.click(); }
    } catch (e) { if (e.name !== "AbortError") showError(e); }
  };
}

function renderClient(cid) {
  const c = state.clients.find((x) => x.id === cid);
  if (!c) { $app.innerHTML = `<main class="screen"><div class="navrow"><button class="link back" data-go="#/">${CHEV_L}Клиенты</button></div><div class="empty">${state.loaded ? "Клиент не найден." : "Загрузка…"}</div></main>`; return; }
  const ws = workoutsOf(cid), sess = sessionsOf(cid), pk = packagesOf(c);
  const names = exerciseNames(cid);
  const ex = names.includes(state.chartEx[cid]) ? state.chartEx[cid] : names[0];
  const hist = ex ? exerciseHistory(cid, ex) : [];
  const first = hist[0], lastH = hist[hist.length - 1];
  const gain = first && lastH ? lastH.w - first.w : 0;
  const monthAgo = localISO(new Date(Date.now() - 30 * 864e5));
  const monthVisits = new Set(ws.filter((w) => w.date > monthAgo).map((w) => w.date)).size;
  const records = ws.reduce((n, w) => n + (w.exercises || []).filter((e) => isRecord(cid, w, e)).length, 0);

  const progress = ex ? `
    <div class="chips">${names.map((n) => `<button class="chip ${n === ex ? "on" : ""}" data-chart="${esc(n)}">${esc(n)}</button>`).join("")}</div>
    <div class="panel">
      <div class="ftl">
        <div><div class="lbl">Начало · ${dateRu(first.date)}</div><div class="big">${fmt(first.w)}<small> кг×${fmt(first.r)}</small></div></div>
        <div class="arrow">${gain >= 0 ? "+" : ""}${fmt(gain)} кг →</div>
        <div style="text-align:right"><div class="lbl">Сейчас · ${dateRu(lastH.date)}</div><div class="big now">${fmt(lastH.w)}<small> кг×${fmt(lastH.r)}</small></div></div>
      </div>
      ${chartSvg(hist)}
      ${hist.length >= 2 ? `<div class="share-row"><button class="link" data-act="shareProgress" data-id="${cid}">${SHARE_ICON}Поделиться прогрессом</button></div>` : ""}
    </div>` : `<div class="panel empty">Здесь появится прогресс «было → стало», когда запишешь первую тренировку.</div>`;

  $app.innerHTML = `<main class="screen">
    <div class="navrow"><button class="link back" data-go="#/">${CHEV_L}Клиенты</button><span style="display:flex;gap:14px;align-items:center">${syncBadge()}<button class="link" data-act="editClient" data-id="${cid}">${PEN}Правка</button></span></div>
    <div class="hero">${avatar(c)}<div><h2>${esc(c.name)}</h2>
      <div class="meta">${c.startDate ? `С ${dateRu(c.startDate)} · ` : ""}${ws.length} ${plural(ws.length, "тренировка", "тренировки", "тренировок")}${c.goal ? ` · цель: ${esc(c.goal)}` : ""}</div></div></div>
    ${packagePanel(c)}
    ${progress}
    <div class="stats">
      <div class="stat"><div class="lbl">Вес тела</div><div class="v">${c.bodyStart || c.bodyNow ? `${fmt(num(c.bodyStart))}→${fmt(num(c.bodyNow))}` : "—"}</div></div>
      <div class="stat"><div class="lbl">Визитов/мес</div><div class="v">${monthVisits}</div></div>
      <div class="stat"><div class="lbl">Рекорды</div><div class="v">${records}</div></div>
    </div>
    ${c.notes ? `<div class="panel meta" style="white-space:pre-wrap">${esc(c.notes)}</div>` : ""}
    <div class="btn-row"><button class="btn" data-act="newWorkout" data-id="${cid}">+ Тренировка</button><button class="btn outline" data-act="planSheet" data-id="${cid}">Запланировать</button></div>
    ${clientPlanned(c)}
    ${sess.length ? `<div class="list">${sess.slice().reverse().map((w) => {
      const a = pk.alloc[w.id], no = a ? ` · ${a.n}/${a.p.count}` : "";
      return w.kind === "cancel"
        ? `<div class="sess cancel"><span><b>${dateRu(w.date)}</b> · Поздняя отмена</span><span class="meta">${no.slice(3)} <button class="x" data-act="delCancel" data-wid="${w.id}" aria-label="Удалить отмену">×</button></span></div>`
        : `<button class="sess" data-go="#/w/${w.id}"><span><b>${dateRu(w.date)}</b> · ${esc(w.title || "Тренировка")}</span><span class="meta">${(w.exercises || []).length} упр${no}</span></button>`;
    }).join("")}</div>` : ""}
  </main>`;
}

// ---------- расписание ----------
function savePlanned(w) {
  const { id, ...data } = w;
  if (data.status == null) delete data.status;
  setDoc(userDoc("workouts", id), { ...data, updatedAt: Date.now() }).catch(showError);
  const i = state.workouts.findIndex((x) => x.id === id);
  if (i >= 0) state.workouts[i] = { id, ...data }; else state.workouts.push({ id, ...data });
}

function forecastFor(w) {
  const c = state.clients.find((x) => x.id === w.clientId);
  if (!c?.packages?.length) return "";
  const a = packagesOf(c, true).alloc[w.id];
  return a ? `<span class="pk-tag pk-ok">${a.n}/${a.p.count}</span>` : `<span class="pk-tag pk-bad">вне абонемента</span>`;
}

function planRow(w, withName = true) {
  const c = state.clients.find((x) => x.id === w.clientId);
  const overdue = w.date < today() || (w.date === today() && w.time && atOf(w) < Date.now() - 60 * 60000);
  return `<button class="plan-row ${overdue ? "overdue" : ""}" data-go="#/p/${w.id}">
    <span class="plan-time">${esc(w.time || "—")}</span>
    ${withName && c ? avatar(c) : ""}
    <span class="plan-main"><b>${withName && c ? esc(c.name) : dayLabel(w.date)}</b>
      <span class="sub">${overdue ? (w.date === today() ? "прошло · не отмечено" : withName ? `${dayLabel(w.date)} · не отмечено` : "не отмечено") : ""}</span></span>
    ${forecastFor(w)}
  </button>`;
}

const atOf = (w) => new Date(`${w.date}T${w.time || "00:00"}:00`).getTime();
function untilText(at) {
  const m = Math.round((at - Date.now()) / 60000);
  if (m <= -60) return "уже прошла";
  if (m <= 0) return "идёт сейчас";
  if (m < 60) return `через ${m} мин`;
  const h = Math.floor(m / 60), r = m % 60;
  return `через ${h} ч${r ? ` ${r} мин` : ""}`;
}
// обновляем «через N мин» раз в полминуты, не перерисовывая экран
setInterval(() => document.querySelectorAll("[data-at]").forEach((el) => { el.textContent = untilText(+el.dataset.at); }), 30000);

function todayBlock() {
  const all = plannedAll();
  const overdue = all.filter((w) => w.date < today());
  const todays = all.filter((w) => w.date === today());
  const doneToday = state.workouts.filter((w) => w.date === today() && !isPlanned(w) && w.kind !== "cancel" && state.clients.some((c) => c.id === w.clientId));
  const total = todays.length + doneToday.length;
  const next = todays.find((w) => atOf(w) > Date.now() - 60 * 60000) || null;
  const rest = todays.filter((w) => w !== next);
  const ending = state.clients.filter((c) => ["warn", "bad"].includes(packagesOf(c).current?.level));
  const upcoming = all.find((w) => w.date > today());
  const uc = upcoming && state.clients.find((x) => x.id === upcoming.clientId);
  const nc = next && state.clients.find((x) => x.id === next.clientId);
  const hr = new Date().getHours();
  const greet = hr < 12 ? "Доброе утро" : hr < 18 ? "Добрый день" : "Добрый вечер";

  const chips = [
    overdue.length ? `<button class="st-chip bad" data-go="#/s">Не отмечено · ${overdue.length}</button>` : "",
    ending.length ? `<button class="st-chip warn" data-filter="pkg">Абонемент заканчивается · ${ending.length}</button>` : "",
  ].join("");

  return `<section class="status">
    <div class="st-top">
      <div><span class="lbl">${greet}</span><div class="st-title">${total ? `${total} ${plural(total, "тренировка", "тренировки", "тренировок")} сегодня` : "Сегодня свободно"}</div></div>
      ${total ? `<div class="st-ring" style="--p:${doneToday.length / total}"><span>${doneToday.length}/${total}</span></div>` : ""}
    </div>
    ${next && nc ? `<div class="st-next">
      <button class="st-next-main" data-go="#/p/${next.id}">
        ${avatar(nc)}
        <span class="st-next-txt"><small>Следующая · ${esc(next.time || "")}</small><b>${esc(nc.name)}</b><em data-at="${atOf(next)}">${untilText(atOf(next))}</em></span>
      </button>
      <button class="link primary" data-act="startPlanned" data-wid="${next.id}">Начать</button>
    </div>` : !total && upcoming && uc ? `<div class="meta">Ближайшая: ${dayLabel(upcoming.date).toLowerCase()} в ${esc(upcoming.time || "")} · ${esc(uc.name)}</div>`
      : !total ? `<div class="meta">В расписании пока пусто.</div>` : `<div class="meta">На сегодня всё запланированное проведено 💪</div>`}
    ${rest.length ? `<div class="plan-list">${rest.map((w) => planRow(w)).join("")}</div>` : ""}
    ${chips ? `<div class="st-chips">${chips}</div>` : ""}
  </section>`;
}

function clientPlanned(c) {
  const list = plannedOf(c.id);
  if (!list.length) return "";
  return `<div class="panel"><div class="lbl" style="margin-bottom:4px">Запланировано · ${list.length}</div>
    <div class="plan-list">${list.map((w) => planRow(w, false)).join("")}</div></div>`;
}

function renderSchedule() {
  const all = plannedAll();
  const groups = {};
  for (const w of all) (groups[w.date < today() ? "overdue" : w.date] ||= []).push(w);
  const keys = Object.keys(groups).sort((a, b) => (a === "overdue" ? -1 : b === "overdue" ? 1 : a.localeCompare(b)));
  $app.innerHTML = `<main class="screen">
    <div class="navrow"><span class="meta">${dateRu(today())}</span>${syncBadge()}</div>
    <h1>Расписание</h1>
    ${keys.length ? keys.map((k) => `<section class="day">
      <div class="day-h ${k === "overdue" ? "overdue" : ""}">${k === "overdue" ? "Не отмечено" : dayLabel(k)}<span>${groups[k].length}</span></div>
      <div class="list plan-list">${groups[k].map((w) => planRow(w)).join("")}</div></section>`).join("")
      : `<div class="list"><div class="empty">Расписание пустое.<br>Нажми «+», чтобы запланировать тренировку.</div></div>`}
  </main>
  ${dock("schedule", "planSheet", "Запланировать")}`;
}

function renderPlanned(id) {
  const w = state.workouts.find((x) => x.id === id);
  if (!w || !isPlanned(w)) {
    if (w) return go(`#/w/${w.id}`);
    $app.innerHTML = `<main class="screen"><div class="navrow"><button class="link back" data-go="#/s">${CHEV_L}Расписание</button></div><div class="empty">${state.loaded ? "Запись не найдена." : "Загрузка…"}</div></main>`; return;
  }
  const c = state.clients.find((x) => x.id === w.clientId);
  const a = c?.packages?.length ? packagesOf(c, true).alloc[w.id] : null;
  const overdue = w.date < today();
  $app.innerHTML = `<main class="screen">
    <div class="navrow"><button class="link back" data-go="#/s">${CHEV_L}Расписание</button>${syncBadge()}<button class="link" data-go="#/c/${w.clientId}">Клиент</button></div>
    <div class="hero">${c ? avatar(c) : ""}<div><h2>${esc(c?.name || "")}</h2><div class="meta">Запланированная тренировка</div></div></div>
    <div class="panel plan-card">
      <div class="lbl">${overdue ? "Прошло, не отмечено" : "Когда"}</div>
      <div class="plan-when">${dayLabel(w.date)}<b>${esc(w.time || "")}</b></div>
      ${c?.packages?.length ? `<div class="pk-line pk-${a ? "ok" : "bad"}">${a ? `Спишется ${a.n}-е занятие из ${a.p.count}` : "На эту дату нет действующего абонемента"}</div>` : ""}
    </div>
    <button class="btn block" data-act="startPlanned" data-wid="${w.id}">${overdue ? "Провели — заполнить тренировку" : "Начать тренировку"}</button>
    <div class="btn-row"><button class="btn outline" data-act="movePlanned" data-wid="${w.id}">Перенести</button><button class="btn outline" data-act="cancelPlannedLate" data-wid="${w.id}">Поздняя отмена</button></div>
    <div class="meta">«Поздняя отмена» спишет занятие с абонемента. Если отмена заранее, просто убери запись:</div>
    <button class="link danger" data-act="dropPlanned" data-wid="${w.id}">Убрать из расписания без списания</button>
  </main>`;
}

function startPlanned(id) {
  const w = state.workouts.find((x) => x.id === id); if (!w) return;
  const done = workoutsOf(w.clientId).find((x) => x.date === w.date);
  if (done) { // в этот день тренировка уже записана — запись из расписания больше не нужна
    deleteDoc(userDoc("workouts", id)).catch(showError);
    state.workouts = state.workouts.filter((x) => x.id !== id);
    return go(`#/w/${done.id}`);
  }
  const upd = { ...w, status: null, title: w.title || "", notes: w.notes || "", exercises: w.exercises?.length ? w.exercises : [{ name: "", sets: [{ w: "", r: "" }] }] };
  savePlanned(upd); state.draft = null;
  go(`#/w/${id}`);
}

function planSheet(cid, existing) {
  const lastTime = existing?.time || plannedAll().filter((w) => w.clientId === cid).pop()?.time || "18:00";
  const clientsSorted = state.clients.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (!clientsSorted.length) return showError({ message: "Сначала добавь клиента." });
  const bg = sheet(`
    <div class="navrow"><button type="button" class="link quiet" data-close>Отмена</button><b>${existing ? "Перенести" : "Запланировать"}</b><button class="link primary" type="submit">Сохранить</button></div>
    ${existing || cid ? "" : `<div class="field"><label class="lbl" for="pl-client">Клиент</label><select class="input" id="pl-client" name="client">${clientsSorted.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>`}
    <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:8px">
      <div class="field"><label class="lbl" for="pl-date">Дата</label><input class="input" id="pl-date" name="date" type="date" required min="${existing ? "" : today()}" value="${existing?.date || addDays(today(), 1)}"></div>
      <div class="field"><label class="lbl" for="pl-time">Время</label><input class="input" id="pl-time" name="time" type="time" required value="${esc(lastTime)}" step="900"></div>
    </div>
    ${existing ? "" : `<div class="field"><span class="lbl">Повторять</span><div class="chips" id="pl-rep">
      <button type="button" class="chip on" data-rep="1">Один раз</button>
      <button type="button" class="chip" data-rep="4">Каждую неделю · 4</button>
      <button type="button" class="chip" data-rep="8">Каждую неделю · 8</button>
    </div></div>`}
    <div class="meta" id="pl-info"></div>
  `, (fd) => {
    const client = existing?.clientId || cid || fd.get("client");
    const date = fd.get("date"), time = fd.get("time");
    if (!client || !date) return false;
    if (existing) { const { reminded, ...rest } = existing; savePlanned({ ...rest, date, time }); render(); return; }
    const reps = +(bg.querySelector("#pl-rep .on")?.dataset.rep || 1);
    const taken = new Set(allOf(client).map((w) => w.date));
    let added = 0;
    for (let i = 0; i < reps; i++) {
      const d = addDays(date, i * 7);
      if (taken.has(d)) continue; // одна тренировка в день
      savePlanned({ id: uid(), clientId: client, status: "planned", date: d, time, createdAt: Date.now() + i, exercises: [] });
      added++;
    }
    if (added < reps) showError({ message: `Пропущено ${reps - added}: в эти дни у клиента уже есть запись.` });
    render();
  });
  const info = bg.querySelector("#pl-info");
  const upd = () => {
    const client = existing?.clientId || cid || bg.querySelector("#pl-client")?.value;
    const c = state.clients.find((x) => x.id === client);
    const reps = +(bg.querySelector("#pl-rep .on")?.dataset.rep || 1);
    const { current: p } = c ? packagesOf(c) : {};
    const planned = c ? plannedOf(c.id).filter((w) => w.date >= today() && w.id !== existing?.id).length : 0;
    const clash = c && allOf(c.id).some((w) => w.date === bg.querySelector("#pl-date").value && w.id !== existing?.id);
    const lines = [];
    if (clash) lines.push("⚠️ В этот день у клиента уже есть запись.");
    if (p && !p.expired && p.left > 0) {
      const after = p.left - planned - (existing ? 1 : reps);
      lines.push(after >= 0 ? `В абонементе после этого останется ${after} ${plural(after, "свободное занятие", "свободных занятия", "свободных занятий")}.` : `⚠️ Не хватит абонемента: не хватает ${-after}.`);
    } else if (c) lines.push("⚠️ У клиента нет действующего абонемента.");
    info.textContent = lines.join(" ");
  };
  bg.querySelectorAll("[data-rep]").forEach((b) => b.addEventListener("click", () => { bg.querySelectorAll("[data-rep]").forEach((x) => x.classList.toggle("on", x === b)); upd(); }));
  bg.querySelector("#pl-client")?.addEventListener("change", upd);
  bg.querySelector("#pl-date").addEventListener("input", upd);
  upd();
}

// ---------- тренировка ----------
let saveTimer = null;
function saveDraftSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(flushDraft, 600); }
function flushDraft() {
  clearTimeout(saveTimer);
  if (!state.draft) return;
  const d = state.draft;
  const { id, ...data } = d;
  setDoc(userDoc("workouts", id), { ...data, updatedAt: Date.now() }).catch(showError); // офлайн — встанет в очередь
  const i = state.workouts.findIndex((w) => w.id === id);
  if (i >= 0) state.workouts[i] = structuredClone(d); else state.workouts.push(structuredClone(d));
  if (route().view !== "w") state.draft = null;
}

function pkgLine(c, w) {
  if (!c?.packages?.length) return "";
  const a = packagesOf(c).alloc[w.id];
  return a ? `<div class="pk-line pk-${a.n >= a.p.count ? "warn" : "ok"}">Абонемент: ${a.n}-е занятие из ${a.p.count}${a.n >= a.p.count ? " · последнее" : ""}</div>`
    : `<div class="pk-line pk-bad">Вне абонемента: нет действующего пакета на эту дату</div>`;
}

// «Повторить прошлую»: показываем, пока в тренировке ничего не записано
function repeatPanel(w) {
  const blank = !(w.exercises || []).some((e) => e.name || (e.sets || []).some((x) => x.w || x.r));
  if (!blank) return "";
  const seen = new Set(), picks = [];
  for (const x of workoutsOf(w.clientId).reverse()) {
    if (x.id === w.id || x.date > w.date || !(x.exercises || []).some((e) => e.name)) continue;
    const key = (x.title || "").trim().toLowerCase() || x.id;
    if (seen.has(key)) continue;
    seen.add(key); picks.push(x);
    if (picks.length === 3) break;
  }
  if (!picks.length) return "";
  return `<div class="panel repeat"><div class="lbl">Повторить прошлую тренировку</div>
    <div class="repeat-list">${picks.map((x) => { const n = x.exercises.filter((e) => e.name).length; return `<button class="repeat-btn" data-act="repeatFrom" data-src="${x.id}"><b>${esc(x.title || "Тренировка")}</b><span>${dateRu(x.date)} · ${n} упр</span></button>`; }).join("")}</div>
    <div class="meta">Подставятся те же упражнения и подходы. Серые цифры — прошлый результат: нажми на них, чтобы взять как есть.</div></div>`;
}

function renderWorkout(wid) {
  if (!state.draft || state.draft.id !== wid) {
    const w = state.workouts.find((x) => x.id === wid);
    if (!w) { $app.innerHTML = `<main class="screen"><div class="navrow"><button class="link back" data-go="#/">${CHEV_L}Клиенты</button></div><div class="empty">${state.loaded ? "Тренировка не найдена." : "Загрузка…"}</div></main>`; return; }
    state.draft = structuredClone(w);
  }
  const w = state.draft;
  const c = state.clients.find((x) => x.id === w.clientId);
  const allNames = [...new Set([...state.workouts.flatMap((x) => (x.exercises || []).map((e) => e.name)), ...DEFAULT_EXERCISES])].filter(Boolean);

  const exHtml = (w.exercises || []).map((ex, ei) => {
    const prev = ex.name ? previousExercise(w.clientId, w, ex.name) : null;
    return `<section class="ex">
      <div class="ex-h"><input list="exnames" value="${esc(ex.name)}" placeholder="Упражнение" data-exname="${ei}" aria-label="Название упражнения">
        ${isRecord(w.clientId, w, ex) ? `<span class="pr">РЕКОРД</span>` : ""}
        <button class="x" data-act="delEx" data-ei="${ei}" aria-label="Удалить упражнение">×</button></div>
      <table class="sets"><tr><th>Подх.</th><th>Прошлый</th><th>Кг</th><th>Повт.</th><th></th></tr>
      ${ex.sets.map((s, si) => { const p = prev?.sets?.[si]; return `<tr>
        <td>${si + 1}</td><td class="prev">${p && num(p.w) != null ? `<button class="prev-btn" data-act="usePrev" data-ei="${ei}" data-si="${si}" aria-label="Взять прошлый результат">${fmt(num(p.w))}×${fmt(num(p.r))}</button>` : "—"}</td>
        <td><div class="stepper"><button class="st" data-act="step" data-ei="${ei}" data-si="${si}" data-d="-2.5" aria-label="Минус 2,5 кг">−</button><input inputmode="decimal" value="${esc(s.w)}" placeholder="${p ? esc(p.w) : ""}" data-set="${ei}:${si}:w" aria-label="Вес, подход ${si + 1}"><button class="st" data-act="step" data-ei="${ei}" data-si="${si}" data-d="2.5" aria-label="Плюс 2,5 кг">+</button></div></td>
        <td><input inputmode="numeric" value="${esc(s.r)}" placeholder="${p ? esc(p.r) : ""}" data-set="${ei}:${si}:r" aria-label="Повторы, подход ${si + 1}"></td>
        <td><button class="x" data-act="delSet" data-ei="${ei}" data-si="${si}" aria-label="Удалить подход">×</button></td></tr>`; }).join("")}
      </table>
      <div class="ex-foot"><button class="link" data-act="addSet" data-ei="${ei}">+ Подход</button></div>
    </section>`;
  }).join("");

  $app.innerHTML = `<main class="screen">
    <div class="navrow"><button class="link back" data-go="#/c/${w.clientId}">${CHEV_L}${esc(c ? c.name.split(" ")[0] : "Назад")}</button>${syncBadge()}<button class="link primary" data-go="#/c/${w.clientId}">Готово</button></div>
    <input class="input" id="wtitle" value="${esc(w.title)}" placeholder="Название, например «Ноги»" style="font:700 24px var(--display);text-transform:uppercase">
    ${pkgLine(c, w)}
    <div style="display:flex;gap:8px;align-items:center"><span class="lbl">Дата</span><input class="input" id="wdate" type="date" value="${esc(w.date)}" style="width:auto"></div>
    ${repeatPanel(w)}
    ${exHtml}
    <button class="btn ghost block" data-act="addEx">+ Добавить упражнение</button>
    <textarea class="input" id="wnotes" rows="2" placeholder="Заметки: самочувствие, техника…">${esc(w.notes || "")}</textarea>
    <button class="link danger" data-act="delWorkout">Удалить тренировку</button>
    <datalist id="exnames">${allNames.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
  </main>`;
}

// ---------- крестик «стереть всё» в текстовых полях ----------
const CLEARABLE = 'input.input:not([type=date]):not([type=time]):not([type=file]):not([type=hidden]), textarea.input, input[data-exname]';
function addClearButtons(root = document) {
  root.querySelectorAll(CLEARABLE).forEach((el) => {
    if (el.parentElement?.classList.contains("clr-wrap")) return;
    const wrap = document.createElement("span");
    wrap.className = "clr-wrap" + (el.tagName === "TEXTAREA" ? " is-area" : "") + (el.dataset.exname != null ? " is-inline" : "");
    const focused = document.activeElement === el;
    let ss = null, se = null;
    try { ss = el.selectionStart; se = el.selectionEnd; } catch {}
    el.replaceWith(wrap); wrap.append(el);
    if (focused) { el.focus({ preventScroll: true }); try { if (ss != null) el.setSelectionRange(ss, se); } catch {} }
    const b = document.createElement("button");
    b.type = "button"; b.className = "clr"; b.tabIndex = -1; b.setAttribute("aria-label", "Стереть");
    b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>`;
    wrap.append(b);
    wrap.classList.toggle("has", !!el.value);
  });
}
document.addEventListener("input", (e) => { const w = e.target.parentElement; if (w?.classList.contains("clr-wrap")) w.classList.toggle("has", !!e.target.value); }, true);
document.addEventListener("pointerdown", (e) => { if (e.target.closest(".clr")) e.preventDefault(); }, true); // не терять фокус
document.addEventListener("click", (e) => {
  const b = e.target.closest(".clr"); if (!b) return;
  e.stopPropagation();
  const el = b.parentElement.querySelector("input, textarea");
  el.value = "";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  const again = el.id ? document.getElementById(el.id) : el; // экран мог перерисоваться
  (again || el).focus();
}, true);
new MutationObserver(() => addClearButtons()).observe(document.body, { childList: true, subtree: true });

// ---------- «Удалено · Отменить» ----------
let toastTimer = null;
function undoToast(text, onUndo) {
  document.getElementById("toast")?.remove(); clearTimeout(toastTimer);
  const el = document.createElement("div");
  el.id = "toast"; el.className = "toast"; el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(text)}</span><button type="button" class="link">Отменить</button>`;
  el.querySelector("button").onclick = () => { clearTimeout(toastTimer); el.remove(); onUndo(); };
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 6000);
}
function removeWorkoutDoc(id) {
  const w = state.workouts.find((x) => x.id === id);
  deleteDoc(userDoc("workouts", id)).catch(showError);
  state.workouts = state.workouts.filter((x) => x.id !== id);
  return w;
}
function restoreWorkoutDoc(w) {
  if (!w) return;
  const { id, ...data } = w;
  setDoc(userDoc("workouts", id), data).catch(showError);
  if (!state.workouts.some((x) => x.id === id)) state.workouts.push(w);
}

// ---------- листы (формы) ----------
function sheet(html, onSubmit) {
  document.querySelectorAll(".sheet-bg").forEach((x) => x.remove());
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<form class="sheet"><button type="button" class="grab" aria-label="Закрыть"><i></i></button>${html}</form>`;
  bg.close = () => closeSheet(bg);
  bg.onclick = (e) => { if (e.target === bg) closeSheet(bg); };
  const form = bg.querySelector("form");
  form.onsubmit = (e) => { e.preventDefault(); if (onSubmit(new FormData(form), bg) !== false) closeSheet(bg); };
  form.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeSheet(bg)));
  document.body.append(bg);
  sheetGestures(bg, form);
  return bg;
}

function closeSheet(bg) {
  if (!bg || bg.dataset.closing) return;
  bg.dataset.closing = "1";
  const el = bg.querySelector(".sheet");
  el.style.transition = "transform .28s cubic-bezier(.4,0,1,1)";
  el.style.transform = "translate3d(0,105%,0)";
  bg.classList.add("closing");
  setTimeout(() => bg.remove(), 280);
}

// Смахнуть окно вниз: тянем за ручку/шапку или за любое место, когда содержимое прокручено к началу.
function sheetGestures(bg, el) {
  el.querySelector(".grab").addEventListener("click", () => closeSheet(bg));
  let y0 = null, dy = 0, t0 = 0, drag = false;
  el.addEventListener("touchstart", (e) => {
    const onHandle = e.target.closest(".grab, .navrow");
    if (!onHandle && (el.scrollTop > 0 || e.target.closest("input, textarea, select, .chips"))) { y0 = null; return; }
    y0 = e.touches[0].clientY; t0 = Date.now(); dy = 0; drag = false;
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0 && !drag) return;
    if (!drag && dy < 6) return;
    drag = true;
    e.preventDefault();
    el.style.transition = "none";
    el.style.transform = `translate3d(0,${Math.max(0, dy)}px,0)`;
    bg.style.setProperty("--dim", String(Math.max(0, 1 - dy / 500)));
  }, { passive: false });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    if (!drag) return;
    const v = dy / Math.max(1, Date.now() - t0);
    if (dy > 110 || v > 0.55) closeSheet(bg);
    else { el.style.transition = "transform .3s cubic-bezier(.22,1,.36,1)"; el.style.transform = ""; bg.style.removeProperty("--dim"); }
  };
  el.addEventListener("touchend", end);
  el.addEventListener("touchcancel", end);
}

function clientSheet(c) {
  let photo; // undefined — не менялось, "" — убрали, dataURL — новое фото
  const v = (k) => esc(c?.[k] ?? "");
  sheet(`
    <div class="navrow"><button type="button" class="link quiet" data-close>Отмена</button><b>${c ? "Клиент" : "Новый клиент"}</b><button class="link primary" type="submit">Сохранить</button></div>
    <div class="photo-pick">
      <span id="f-ava">${c?.photo ? `<img class="ava" src="${esc(c.photo)}" alt="">` : `<div class="ava">${c ? esc(initials(c.name)) : "+"}</div>`}</span>
      <button type="button" class="link" id="f-photobtn">${c?.photo ? "Сменить фото" : "Добавить фото"}</button>
      <input type="file" accept="image/*" id="f-photo" class="visually-hidden" tabindex="-1">
      <button type="button" class="link danger" id="f-nophoto" ${c?.photo ? "" : "hidden"}>Убрать</button>
    </div>
    <div class="field"><label class="lbl" for="f-name">Имя и фамилия</label><input class="input" id="f-name" name="name" required value="${v("name")}"></div>
    <div class="field"><label class="lbl" for="f-goal">Цель</label><input class="input" id="f-goal" name="goal" placeholder="сила, масса, похудение…" value="${v("goal")}"></div>
    <div class="field"><label class="lbl" for="f-start">Ходит с</label><input class="input" id="f-start" name="startDate" type="date" value="${c?.startDate || today()}"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="field"><label class="lbl" for="f-b1">Вес тела в начале, кг</label><input class="input" id="f-b1" name="bodyStart" inputmode="decimal" value="${v("bodyStart")}"></div>
      <div class="field"><label class="lbl" for="f-b2">Вес тела сейчас, кг</label><input class="input" id="f-b2" name="bodyNow" inputmode="decimal" value="${v("bodyNow")}"></div>
    </div>
    <div class="field"><label class="lbl" for="f-notes">Заметки</label><textarea class="input" id="f-notes" name="notes" rows="2" placeholder="травмы, телефон…">${v("notes")}</textarea></div>
    ${c ? `<button type="button" class="link danger" id="delClient">Удалить клиента и все его тренировки</button>` : ""}
  `, (fd) => {
    const data = Object.fromEntries(fd); data.name = data.name.trim();
    if (photo !== undefined) data.photo = photo;
    if (!data.name) return false;
    const id = c?.id || uid();
    setDoc(userDoc("clients", id), { ...data, ...(c ? {} : { createdAt: Date.now() }), updatedAt: Date.now() }, { merge: true }).catch(showError);
    if (!c) go(`#/c/${id}`);
  });
  const pick = document.getElementById("f-photo"), ava = document.getElementById("f-ava"), noPhoto = document.getElementById("f-nophoto");
  document.getElementById("f-photobtn").onclick = () => pick.click();
  pick.onchange = async () => {
    const f = pick.files[0]; if (!f) return;
    try { photo = await photoToDataUrl(f); ava.innerHTML = `<img class="ava" src="${photo}" alt="">`; noPhoto.hidden = false; }
    catch { showError({ message: "Не получилось открыть фото. Попробуй другое." }); }
  };
  noPhoto.onclick = () => { photo = ""; ava.innerHTML = `<div class="ava">${c ? esc(initials(c.name)) : "+"}</div>`; noPhoto.hidden = true; };
  document.getElementById("delClient")?.addEventListener("click", () => {
    const client = structuredClone(c), sessions = structuredClone(allOf(c.id));
    const batch = writeBatch(db);
    sessions.forEach((w) => batch.delete(userDoc("workouts", w.id)));
    batch.delete(userDoc("clients", c.id));
    batch.commit().catch(showError);
    document.querySelector(".sheet-bg")?.close?.();
    go("#/");
    undoToast(`Клиент удалён: ${client.name}`, () => {
      const b = writeBatch(db);
      const { id, ...cdata } = client;
      b.set(userDoc("clients", id), cdata);
      sessions.forEach(({ id: wid, ...wdata }) => b.set(userDoc("workouts", wid), wdata));
      b.commit().catch(showError);
    });
  });
}

const MENU_ICONS = {
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`,
  down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>`,
  up: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V5M7 10l5-5 5 5M5 20h14"/></svg>`,
  sync: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/></svg>`,
  out: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/></svg>`,
};
const menuRow = (id, icon, label, sub = "", tag = "button") => `<${tag} ${tag === "button" ? 'type="button"' : ""} class="menu-row" id="${id}">
  <span class="menu-ico">${MENU_ICONS[icon]}</span><span class="menu-txt"><b>${label}</b>${sub ? `<small>${sub}</small>` : ""}</span>${CHEV_R}</${tag}>`;

function menuSheet() {
  const email = state.user.email || "";
  sheet(`
    <div class="navrow center"><b>Меню</b></div>
    <div class="menu-me"><span class="ava">Я</span><span class="menu-txt"><b>${esc(email)}</b><small>Журнал Зала · версия ${APP_VERSION}</small></span></div>
    <div class="menu-group">
      ${menuRow("notif", "bell", "Уведомления", "Сводка на день и напоминания")}
      ${menuRow("exp", "down", "Экспорт в файл", "Бэкап всех клиентов и тренировок")}
      <label class="menu-row" for="imp"><span class="menu-ico">${MENU_ICONS.up}</span><span class="menu-txt"><b>Импорт из файла</b><small>Восстановить из бэкапа</small></span>${CHEV_R}</label>
      ${menuRow("upd", "sync", "Обновить приложение", "Если что-то выглядит по-старому")}
    </div>
    <input type="file" accept="application/json" id="imp" class="visually-hidden" tabindex="-1">
    <div class="menu-group"><button type="button" class="menu-row danger" id="logout"><span class="menu-ico">${MENU_ICONS.out}</span><span class="menu-txt"><b>Выйти</b></span></button></div>
  `, () => false);
  document.getElementById("exp").onclick = exportData;
  document.getElementById("upd").onclick = hardUpdate;
  document.getElementById("notif").onclick = () => { document.querySelector(".sheet-bg")?.remove(); notifySheet(); };
  document.getElementById("imp").onchange = (e) => importData(e.target.files[0]);
  document.getElementById("logout").onclick = () => { document.querySelector(".sheet-bg")?.close?.(); signOut(auth); };
}

// ---------- push-уведомления ----------
// Телефон регистрируется в users/{uid}/devices/{deviceId}; рассылку делает gas/Code.gs (Google Apps Script) каждую минуту.
const DEVICE_KEY = "zhurnal-device-id";
function deviceId() {
  try { let id = localStorage.getItem(DEVICE_KEY); if (!id) { id = uid(); localStorage.setItem(DEVICE_KEY, id); } return id; }
  catch { return "default"; }
}

const BELL_ICON = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;

function notifySheet() {
  // Окно открывается сразу, а состояние подгружается уже внутри — без задержки на касание.
  const bg = sheet(`
    <div class="navrow center"><b>Уведомления</b></div>
    <div id="n-body"><div class="n-loading"><span></span><span></span><span></span></div></div>
  `, (fd, el) => { enableNotifications(el); return false; });
  fillNotify(bg);
}

const segCtl = (group, items, current) => `<div class="segctl" data-group="${group}">${items.map(([v, label]) =>
  `<button type="button" class="${String(v) === String(current) ? "on" : ""}" data-v="${v}">${label}</button>`).join("")}</div>`;

async function fillNotify(bg) {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ref = userDoc("devices", deviceId());
  const [supported, snap] = await Promise.all([
    ("Notification" in window && "serviceWorker" in navigator) ? messagingSupported().catch(() => false) : false,
    getDoc(ref).catch(() => null),
  ]);
  const body = bg.querySelector("#n-body"); if (!body) return;
  const cur = snap?.data?.() || null;
  const on = !!cur?.token && window.Notification?.permission === "granted";
  const morning = cur?.morning ?? "08:00", before = cur?.before ?? 60;
  const reason = !standalone ? "Открой приложение с иконки на экране «Домой»: в Safari уведомления не работают."
    : !supported ? "Этот телефон не поддерживает уведомления. Нужен iOS 16.4 или новее."
    : !vapidKey ? "Уведомления ещё не настроены." : "";
  body.innerHTML = `
    <div class="n-status ${on ? "on" : ""}">
      <span class="n-ico">${MENU_ICONS.bell}</span>
      <span class="menu-txt"><b>${reason ? "Недоступны" : on ? "Включены на этом телефоне" : "Выключены"}</b><small>${reason || (on ? "Приходят с задержкой до минуты" : "Включи, чтобы не пропустить тренировку")}</small></span>
    </div>
    ${reason ? "" : `
    <div class="n-sec"><div class="n-h"><b>Сводка на день</b><small>Утром: кто придёт и у кого кончается абонемент</small></div>
      ${segCtl("morning", [["", "Выкл"], ["07:00", "7:00"], ["08:00", "8:00"], ["09:00", "9:00"]], morning)}</div>
    <div class="n-sec"><div class="n-h"><b>Напоминание перед тренировкой</b><small>За сколько до начала прислать</small></div>
      ${segCtl("before", [[0, "Выкл"], [30, "30 мин"], [60, "1 час"], [120, "2 часа"]], before)}</div>
    <div class="err" id="n-err"></div>
    <button type="submit" class="btn block n-main">${on ? "Сохранить" : `${BELL_ICON}Включить уведомления`}</button>
    ${on ? `<div class="menu-group">
      <button type="button" class="menu-row" id="n-test"><span class="menu-ico">${MENU_ICONS.bell}</span><span class="menu-txt"><b>Прислать тестовое</b><small>Придёт в течение минуты</small></span></button>
      <button type="button" class="menu-row danger" id="n-off"><span class="menu-ico">${MENU_ICONS.out}</span><span class="menu-txt"><b>Выключить на этом телефоне</b></span></button>
    </div>` : ""}`}`;
  body.querySelectorAll(".segctl button").forEach((b) => b.addEventListener("click", () => {
    b.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  }));
  body.querySelector("#n-off")?.addEventListener("click", async () => {
    try { await deleteToken(getMessaging(fb)); } catch {}
    deleteDoc(ref).catch(showError); bg.close(); showError({ message: "Уведомления выключены." });
  });
  body.querySelector("#n-test")?.addEventListener("click", () => {
    setDoc(ref, { testRequestedAt: Date.now() }, { merge: true }).catch(showError);
    showError({ message: "Тестовое уведомление придёт в течение минуты." });
  });
}

async function enableNotifications(bg) {
  const err = bg.querySelector("#n-err"); err.textContent = "";
  const pick = (g, d) => bg.querySelector(`[data-group=${g}] .on`)?.dataset.v ?? d;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { err.textContent = "Уведомления запрещены. Разреши их: Настройки iPhone → Уведомления → Журнал."; return; }
    const reg = await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(fb), { vapidKey, serviceWorkerRegistration: reg });
    await setDoc(userDoc("devices", deviceId()), {
      token, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      morning: pick("morning", "08:00"), before: +pick("before", 60),
      ua: navigator.userAgent.slice(0, 200), updatedAt: Date.now(),
    }, { merge: true });
    bg.close(); showError({ message: "Готово! Уведомления включены." });
  } catch (e) { console.error(e); err.textContent = "Не получилось включить: " + (e.message || e); }
}

async function exportData() {
  const data = { app: "zhurnal-zala", version: 1, exportedAt: new Date().toISOString(), clients: state.clients, workouts: state.workouts };
  const file = new File([JSON.stringify(data, null, 1)], `zhurnal-${today()}.json`, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: "Бэкап журнала" }); return; } catch (e) { if (e.name === "AbortError") return; } }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importData(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.clients) || !Array.isArray(data.workouts)) throw new Error("Это не файл бэкапа журнала.");
    const okId = (x) => x && typeof x === "object" && typeof x.id === "string" && /^[\w-]{1,64}$/.test(x.id);
    const items = [...data.clients.filter(okId).map((x) => ["clients", x]), ...data.workouts.filter(okId).map((x) => ["workouts", x])];
    for (let i = 0; i < items.length; i += 400) {
      const batch = writeBatch(db);
      items.slice(i, i + 400).forEach(([col, { id, ...rest }]) => batch.set(userDoc(col, id), rest));
      batch.commit().catch(showError);
    }
    document.querySelector(".sheet-bg")?.close?.();
    showError({ message: `Импортировано: ${data.clients.length} клиентов, ${data.workouts.length} тренировок.` });
  } catch (e) { showError(e); }
}

// ---------- обработчики ----------
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-go],[data-act],[data-filter],[data-chart]");
  if (!t) return;
  if (t.dataset.go) return go(t.dataset.go);
  if (t.dataset.filter) { state.filter = t.dataset.filter; return renderClients(); }
  if (t.dataset.chart) { state.chartEx[route().id] = t.dataset.chart; return renderClient(route().id); }
  const w = state.draft, ei = +t.dataset.ei, si = +t.dataset.si;
  switch (t.dataset.act) {
    case "menu": return menuSheet();
    case "shareProgress": return shareSheet(t.dataset.id);
    case "newClient": return clientSheet(null);
    case "newPkg": return packageSheet(state.clients.find((c) => c.id === t.dataset.id));
    case "editPkg": return packageSheet(state.clients.find((c) => c.id === t.dataset.id), t.dataset.pid);
    case "lateCancel": return lateCancelSheet(state.clients.find((c) => c.id === t.dataset.id));
    case "delCancel": {
      const gone = removeWorkoutDoc(t.dataset.wid);
      undoToast("Поздняя отмена удалена", () => { restoreWorkoutDoc(gone); render(); });
      return render();
    }
    case "editClient": return clientSheet(state.clients.find((c) => c.id === t.dataset.id));
    case "planSheet": return planSheet(t.dataset.id || null);
    case "startPlanned": return startPlanned(t.dataset.wid);
    case "movePlanned": return planSheet(null, state.workouts.find((x) => x.id === t.dataset.wid));
    case "cancelPlannedLate": {
      const pw = state.workouts.find((x) => x.id === t.dataset.wid); if (!pw) return;
      const upd = { ...pw, status: null, kind: "cancel", title: "Поздняя отмена" };
      savePlanned(upd); return go(`#/c/${pw.clientId}`);
    }
    case "dropPlanned": {
      const pw = removeWorkoutDoc(t.dataset.wid);
      undoToast("Убрано из расписания", () => { restoreWorkoutDoc(pw); render(); });
      return pw ? go(`#/c/${pw.clientId}`) : go("#/");
    }
    case "newWorkout": {
      // одна тренировка в день: если сегодняшняя уже есть — открываем её
      const existing = workoutsOf(t.dataset.id).find((x) => x.date === today());
      if (existing) return go(`#/w/${existing.id}`);
      const plannedToday = plannedOf(t.dataset.id).find((x) => x.date === today());
      if (plannedToday) return startPlanned(plannedToday.id);
      const id = uid();
      state.draft = { id, clientId: t.dataset.id, date: today(), title: "", notes: "", createdAt: Date.now(), exercises: [{ name: "", sets: [{ w: "", r: "" }] }] };
      flushDraft();
      return go(`#/w/${id}`);
    }
    case "addEx": w.exercises.push({ name: "", sets: [{ w: "", r: "" }] }); break;
    case "delEx": {
      const [gone] = w.exercises.splice(ei, 1);
      undoToast(`Упражнение удалено${gone?.name ? ": " + gone.name : ""}`, () => {
        if (state.draft?.id !== w.id) return;
        w.exercises.splice(ei, 0, gone); saveDraftSoon(); renderWorkout(w.id);
      });
      break;
    }
    case "addSet": { const s = w.exercises[ei].sets; const last = s[s.length - 1]; s.push({ w: last?.w ?? "", r: last?.r ?? "" }); break; }
    case "delSet": {
      const [gone] = w.exercises[ei].sets.splice(si, 1);
      undoToast(`Подход ${si + 1} удалён`, () => {
        if (state.draft?.id !== w.id || !w.exercises[ei]) return;
        w.exercises[ei].sets.splice(si, 0, gone); saveDraftSoon(); renderWorkout(w.id);
      });
      break;
    }
    case "delWorkout": {
      clearTimeout(saveTimer);
      const snapshot = structuredClone(w);
      removeWorkoutDoc(w.id);
      state.draft = null;
      undoToast("Тренировка удалена", () => { restoreWorkoutDoc(snapshot); render(); });
      return go(`#/c/${snapshot.clientId}`);
    }
    case "usePrev": { // касание серой подсказки «прошлый раз» переносит её в подход
      const ex = w.exercises[ei], p = previousExercise(w.clientId, w, ex.name)?.sets?.[si];
      if (!p) return;
      ex.sets[si] = { w: p.w ?? "", r: p.r ?? "" };
      break;
    }
    case "step": { // ±2,5 кг; пустое поле считается от прошлого раза
      const ex = w.exercises[ei], set = ex.sets[si];
      const base = num(set.w) ?? num(previousExercise(w.clientId, w, ex.name)?.sets?.[si]?.w) ?? 0;
      const v = Math.max(0, Math.round((base + +t.dataset.d) * 100) / 100);
      set.w = String(v).replace(".", ",");
      break;
    }
    case "repeatFrom": {
      const src = state.workouts.find((x) => x.id === t.dataset.src); if (!src) return;
      w.exercises = (src.exercises || []).filter((e) => e.name).map((e) => ({ name: e.name, sets: (e.sets?.length ? e.sets : [{}]).map(() => ({ w: "", r: "" })) }));
      if (!w.title) w.title = src.title || "";
      break;
    }
    default: return;
  }
  saveDraftSoon(); renderWorkout(w.id);
  if (t.dataset.act === "addEx") document.querySelector(`[data-exname="${w.exercises.length - 1}"]`)?.focus();
});

document.addEventListener("input", (e) => {
  const w = state.draft; if (!w || route().view !== "w") return;
  const t = e.target;
  if (t.dataset.set) { const [ei, si, k] = t.dataset.set.split(":"); w.exercises[ei].sets[si][k] = t.value; }
  else if (t.dataset.exname) w.exercises[t.dataset.exname].name = t.value;
  else if (t.id === "wtitle") w.title = t.value;
  else if (t.id === "wdate") w.date = t.value || today();
  else if (t.id === "wnotes") w.notes = t.value;
  else return;
  saveDraftSoon();
});
// после выбора упражнения обновляем подсказки «прошлый раз»
document.addEventListener("change", (e) => {
  if (e.target.dataset.exname != null && state.draft) { flushDraft(); renderWorkout(state.draft.id); }
});
document.addEventListener("visibilitychange", () => { if (document.hidden) flushDraft(); });

// обновления: новая версия ставится сама, а страница перезагружается, как только та заработала
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
    const check = () => reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true; flushDraft(); location.reload();
  });
}

async function hardUpdate() {
  flushDraft();
  try {
    // только своё: на этом же адресе живут «Заявки» и сайт, их обработчики и кеши не трогаем
    const mine = new URL("./", location.href).href;
    const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
    await Promise.all(regs.filter((r) => r.scope === mine).map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("zhurnal-")).map((k) => caches.delete(k)));
  } catch {}
  location.replace(location.pathname + "?v=" + Date.now() + location.hash);
}
