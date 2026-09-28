import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  collection, doc, onSnapshot, setDoc, deleteDoc, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

// Firestore хранит копию данных на телефоне и досылает изменения, когда появляется сеть.
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }) });

const APP_VERSION = "8";

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
const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => { const n = parseFloat(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
const fmt = (n) => (n == null ? "—" : (Math.round(n * 10) / 10).toString().replace(".", ","));
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("") || "?";
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const dateRu = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]}${y !== new Date().getFullYear() ? " " + y : ""}`; };
const daysAgo = (iso) => Math.round((new Date(today()) - new Date(iso)) / 864e5);
const agoRu = (iso) => { const d = daysAgo(iso); if (d <= 0) return "Сегодня"; if (d === 1) return "Вчера"; if (d < 7) return `${d} дн. назад`; if (d < 14) return "Неделю назад"; if (d < 60) return `${Math.floor(d / 7)} нед. назад`; return dateRu(iso); };
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };

const userCol = (name) => collection(db, "users", state.user.uid, name);
const userDoc = (name, id) => doc(db, "users", state.user.uid, name, id);

// ---------- расчёты прогресса ----------
const byDate = (a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0);
const sessionsOf = (cid) => state.workouts.filter((w) => w.clientId === cid).sort(byDate); // тренировки + поздние отмены
const workoutsOf = (cid) => state.workouts.filter((w) => w.clientId === cid && w.kind !== "cancel").sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
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
onAuthStateChanged(auth, (user) => {
  unsubs.forEach((u) => u()); unsubs = [];
  state.user = user; state.clients = []; state.workouts = []; state.loaded = false;
  if (!user) return render();
  let got = 0;
  const done = () => { if (++got >= 2) state.loaded = true; };
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
window.addEventListener("hashchange", () => { flushDraft(); render(); });
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

function render() {
  if (!state.user) return renderLogin();
  const { view, id } = route();
  if (view === "c" && id) return renderClient(id);
  if (view === "w" && id) return renderWorkout(id);
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

function packagesOf(c) {
  const pk = (c.packages || []).map((p) => ({ ...p, expires: addDays(p.bought, +p.days || 30), used: 0 }))
    .sort((a, b) => a.bought.localeCompare(b.bought));
  const alloc = {};
  for (const sess of sessionsOf(c.id)) {
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
  const status = p.left <= 0 ? "Все занятия использованы" : p.expired ? `Срок истёк ${dateRu(p.expires)}` : `Действует ещё ${p.daysLeft} ${plural(p.daysLeft, "день", "дня", "дней")}`;
  const history = list.slice(0, -1).reverse();
  return `<div class="panel pk pk-${p.level}">
    <div class="pk-h"><span class="lbl">Абонемент</span><button class="link meta" data-act="editPkg" data-id="${c.id}" data-pid="${p.id}">куплен ${dateRu(p.bought)} · до ${dateRu(p.expires)} ✎</button></div>
    <div class="pk-n"><b>${Math.max(p.left, 0)}</b><span>${plural(Math.max(p.left, 0), "занятие осталось", "занятия осталось", "занятий осталось")} из ${p.count}</span></div>
    <div class="seg" aria-hidden="true">${Array.from({ length: p.count }, (_, i) => `<i class="${i < p.used ? "on" : ""}"></i>`).join("")}</div>
    <div class="pk-status">${status}</div>
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
    <div class="navrow"><button type="button" class="link" data-close>Отмена</button><b>${cur ? "Абонемент" : "Новый абонемент"}</b><button class="link" type="submit">Сохранить</button></div>
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
  $("p-del")?.addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Точно удалить? Нажми ещё раз"; return; }
    savePackages(c, c.packages.filter((p) => p.id !== cur.id));
    bg.remove();
  });
}

function lateCancelSheet(c) {
  sheet(`
    <div class="navrow"><button type="button" class="link" data-close>Отмена</button><b>Поздняя отмена</b><span></span></div>
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
    <div class="navrow"><span class="meta">${dateRu(today())}</span><span style="display:flex;gap:14px;align-items:center">${syncBadge()}<button class="link" data-act="menu">Ещё</button></span></div>
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
  <button class="fab" data-act="newClient" aria-label="Новый клиент">+</button>`;

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

function renderClient(cid) {
  const c = state.clients.find((x) => x.id === cid);
  if (!c) { $app.innerHTML = `<main class="screen"><div class="navrow"><button class="link" data-go="#/">‹ Клиенты</button></div><div class="empty">${state.loaded ? "Клиент не найден." : "Загрузка…"}</div></main>`; return; }
  const ws = workoutsOf(cid), sess = sessionsOf(cid), pk = packagesOf(c);
  const names = exerciseNames(cid);
  const ex = names.includes(state.chartEx[cid]) ? state.chartEx[cid] : names[0];
  const hist = ex ? exerciseHistory(cid, ex) : [];
  const first = hist[0], lastH = hist[hist.length - 1];
  const gain = first && lastH ? lastH.w - first.w : 0;
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
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
    </div>` : `<div class="panel empty">Здесь появится прогресс «было → стало», когда запишешь первую тренировку.</div>`;

  $app.innerHTML = `<main class="screen">
    <div class="navrow"><button class="link" data-go="#/">‹ Клиенты</button><span style="display:flex;gap:14px;align-items:center">${syncBadge()}<button class="link" data-act="editClient" data-id="${cid}">Правка</button></span></div>
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
    <button class="btn block" data-act="newWorkout" data-id="${cid}">+ Новая тренировка</button>
    ${sess.length ? `<div class="list">${sess.slice().reverse().map((w) => {
      const a = pk.alloc[w.id], no = a ? ` · ${a.n}/${a.p.count}` : "";
      return w.kind === "cancel"
        ? `<div class="sess cancel"><span><b>${dateRu(w.date)}</b> · Поздняя отмена</span><span class="meta">${no.slice(3)} <button class="x" data-act="delCancel" data-wid="${w.id}" aria-label="Удалить отмену">×</button></span></div>`
        : `<button class="sess" data-go="#/w/${w.id}"><span><b>${dateRu(w.date)}</b> · ${esc(w.title || "Тренировка")}</span><span class="meta">${(w.exercises || []).length} упр${no}</span></button>`;
    }).join("")}</div>` : ""}
  </main>`;
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

function renderWorkout(wid) {
  if (!state.draft || state.draft.id !== wid) {
    const w = state.workouts.find((x) => x.id === wid);
    if (!w) { $app.innerHTML = `<main class="screen"><div class="navrow"><button class="link" data-go="#/">‹ Клиенты</button></div><div class="empty">${state.loaded ? "Тренировка не найдена." : "Загрузка…"}</div></main>`; return; }
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
        <td>${si + 1}</td><td class="prev">${p && num(p.w) != null ? `${fmt(num(p.w))}×${fmt(num(p.r))}` : "—"}</td>
        <td><input inputmode="decimal" value="${esc(s.w)}" placeholder="${p ? esc(p.w) : ""}" data-set="${ei}:${si}:w" aria-label="Вес, подход ${si + 1}"></td>
        <td><input inputmode="numeric" value="${esc(s.r)}" placeholder="${p ? esc(p.r) : ""}" data-set="${ei}:${si}:r" aria-label="Повторы, подход ${si + 1}"></td>
        <td><button class="x" data-act="delSet" data-ei="${ei}" data-si="${si}" aria-label="Удалить подход">×</button></td></tr>`; }).join("")}
      </table>
      <div class="ex-foot"><button class="link" data-act="addSet" data-ei="${ei}">+ Подход</button></div>
    </section>`;
  }).join("");

  $app.innerHTML = `<main class="screen">
    <div class="navrow"><button class="link" data-go="#/c/${w.clientId}">‹ ${esc(c ? c.name.split(" ")[0] : "Назад")}</button>${syncBadge()}<button class="link" data-go="#/c/${w.clientId}">Готово</button></div>
    <input class="input" id="wtitle" value="${esc(w.title)}" placeholder="Название, например «Ноги»" style="font:700 24px var(--display);text-transform:uppercase">
    ${pkgLine(c, w)}
    <div style="display:flex;gap:8px;align-items:center"><span class="lbl">Дата</span><input class="input" id="wdate" type="date" value="${esc(w.date)}" style="width:auto"></div>
    ${exHtml}
    <button class="btn ghost block" data-act="addEx">+ Добавить упражнение</button>
    <textarea class="input" id="wnotes" rows="2" placeholder="Заметки: самочувствие, техника…">${esc(w.notes || "")}</textarea>
    <button class="link danger" data-act="delWorkout">Удалить тренировку</button>
    <datalist id="exnames">${allNames.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
  </main>`;
}

// ---------- листы (формы) ----------
function sheet(html, onSubmit) {
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<form class="sheet">${html}</form>`;
  bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
  const form = bg.querySelector("form");
  form.onsubmit = (e) => { e.preventDefault(); if (onSubmit(new FormData(form), bg) !== false) bg.remove(); };
  form.querySelector("[data-close]")?.addEventListener("click", () => bg.remove());
  document.body.append(bg);
  form.querySelector("[data-autofocus]")?.focus();
  return bg;
}

function clientSheet(c) {
  let photo; // undefined — не менялось, "" — убрали, dataURL — новое фото
  const v = (k) => esc(c?.[k] ?? "");
  sheet(`
    <div class="navrow"><button type="button" class="link" data-close>Отмена</button><b>${c ? "Клиент" : "Новый клиент"}</b><button class="link" type="submit">Сохранить</button></div>
    <div class="photo-pick">
      <span id="f-ava">${c?.photo ? `<img class="ava" src="${esc(c.photo)}" alt="">` : `<div class="ava">${c ? esc(initials(c.name)) : "+"}</div>`}</span>
      <button type="button" class="link" id="f-photobtn">${c?.photo ? "Сменить фото" : "Добавить фото"}</button>
      <input type="file" accept="image/*" id="f-photo" class="visually-hidden" tabindex="-1">
      <button type="button" class="link danger" id="f-nophoto" ${c?.photo ? "" : "hidden"}>Убрать</button>
    </div>
    <div class="field"><label class="lbl" for="f-name">Имя и фамилия</label><input class="input" id="f-name" name="name" required value="${v("name")}" ${c ? "" : "data-autofocus"}></div>
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
  document.getElementById("delClient")?.addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Точно удалить? Нажми ещё раз"; return; }
    const batch = writeBatch(db);
    sessionsOf(c.id).forEach((w) => batch.delete(userDoc("workouts", w.id)));
    batch.delete(userDoc("clients", c.id));
    batch.commit().catch(showError);
    document.querySelector(".sheet-bg")?.remove();
    go("#/");
  });
}

function menuSheet() {
  sheet(`
    <div class="navrow"><button type="button" class="link" data-close>Закрыть</button><b>Меню</b><span></span></div>
    <div class="meta">Вошёл как ${esc(state.user.email)} · версия ${APP_VERSION}</div>
    <button type="button" class="btn block" id="exp">Экспорт в файл (бэкап)</button>
    <label class="btn ghost block" style="text-align:center">Импорт из файла<input type="file" accept="application/json" id="imp" hidden></label>
    <button type="button" class="btn ghost block" id="upd">Обновить приложение</button>
    <button type="button" class="link danger" id="logout">Выйти</button>
  `, () => {});
  document.getElementById("exp").onclick = exportData;
  document.getElementById("upd").onclick = hardUpdate;
  document.getElementById("imp").onchange = (e) => importData(e.target.files[0]);
  document.getElementById("logout").onclick = () => { document.querySelector(".sheet-bg")?.remove(); signOut(auth); };
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
    const items = [...data.clients.map((x) => ["clients", x]), ...data.workouts.map((x) => ["workouts", x])];
    for (let i = 0; i < items.length; i += 400) {
      const batch = writeBatch(db);
      items.slice(i, i + 400).forEach(([col, { id, ...rest }]) => batch.set(userDoc(col, id), rest));
      batch.commit().catch(showError);
    }
    document.querySelector(".sheet-bg")?.remove();
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
    case "newClient": return clientSheet(null);
    case "newPkg": return packageSheet(state.clients.find((c) => c.id === t.dataset.id));
    case "editPkg": return packageSheet(state.clients.find((c) => c.id === t.dataset.id), t.dataset.pid);
    case "lateCancel": return lateCancelSheet(state.clients.find((c) => c.id === t.dataset.id));
    case "delCancel":
      if (t.dataset.sure !== "1") { t.dataset.sure = "1"; t.textContent = "удалить?"; return; }
      deleteDoc(userDoc("workouts", t.dataset.wid)).catch(showError);
      state.workouts = state.workouts.filter((x) => x.id !== t.dataset.wid);
      return render();
    case "editClient": return clientSheet(state.clients.find((c) => c.id === t.dataset.id));
    case "newWorkout": {
      // одна тренировка в день: если сегодняшняя уже есть — открываем её
      const existing = workoutsOf(t.dataset.id).find((x) => x.date === today());
      if (existing) return go(`#/w/${existing.id}`);
      const id = uid();
      state.draft = { id, clientId: t.dataset.id, date: today(), title: "", notes: "", createdAt: Date.now(), exercises: [{ name: "", sets: [{ w: "", r: "" }] }] };
      flushDraft();
      return go(`#/w/${id}`);
    }
    case "addEx": w.exercises.push({ name: "", sets: [{ w: "", r: "" }] }); break;
    case "delEx": w.exercises.splice(ei, 1); break;
    case "addSet": { const s = w.exercises[ei].sets; const last = s[s.length - 1]; s.push({ w: last?.w ?? "", r: last?.r ?? "" }); break; }
    case "delSet": w.exercises[ei].sets.splice(si, 1); break;
    case "delWorkout":
      if (t.dataset.sure !== "1") { t.dataset.sure = "1"; t.textContent = "Точно удалить? Нажми ещё раз"; return; }
      deleteDoc(userDoc("workouts", w.id)).catch(showError);
      state.workouts = state.workouts.filter((x) => x.id !== w.id);
      { const cid = w.clientId; state.draft = null; return go(`#/c/${cid}`); }
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
    const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {}
  location.replace(location.pathname + "?v=" + Date.now() + location.hash);
}
