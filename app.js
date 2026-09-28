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

const DEFAULT_EXERCISES = [
  "Присед со штангой", "Жим лёжа", "Становая тяга", "Жим стоя", "Тяга штанги в наклоне",
  "Подтягивания", "Жим ногами", "Румынская тяга", "Выпады", "Тяга верхнего блока",
  "Жим гантелей на наклонной", "Сгибания на бицепс", "Французский жим", "Разводка гантелей",
];

const state = {
  user: null, clients: [], workouts: [],
  pending: false, loaded: false,
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
const workoutsOf = (cid) => state.workouts.filter((w) => w.clientId === cid).sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
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
    state.pending = snap.metadata.hasPendingWrites;
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
function lastWorkout(cid) { const ws = workoutsOf(cid); return ws[ws.length - 1]; }

function renderClients() {
  const q = state.query.toLowerCase();
  let list = state.clients.map((c) => ({ c, last: lastWorkout(c.id), n: workoutsOf(c.id).length }));
  if (q) list = list.filter(({ c }) => c.name.toLowerCase().includes(q));
  if (state.filter === "today") list = list.filter(({ last }) => last && daysAgo(last.date) === 0);
  if (state.filter === "stale") list = list.filter(({ last }) => !last || daysAgo(last.date) >= 14);
  list.sort((a, b) => (b.last?.date || "").localeCompare(a.last?.date || "") || a.c.name.localeCompare(b.c.name));
  const todayN = state.clients.filter((c) => { const l = lastWorkout(c.id); return l && daysAgo(l.date) === 0; }).length;

  const rows = list.map(({ c, last, n }) => {
    const g = clientGain(c.id);
    return `<button class="row" data-go="#/c/${c.id}">
      <div class="ava">${esc(initials(c.name))}</div>
      <div><div class="nm">${esc(c.name)}</div><div class="sub">${last ? `${agoRu(last.date)} · ${esc(last.title || "Тренировка")}` : "Ещё не тренировался"} · ${n} ${plural(n, "тренировка", "тренировки", "тренировок")}</div></div>
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
  const ws = workoutsOf(cid);
  const names = exerciseNames(cid);
  const ex = names.includes(state.chartEx[cid]) ? state.chartEx[cid] : names[0];
  const hist = ex ? exerciseHistory(cid, ex) : [];
  const first = hist[0], lastH = hist[hist.length - 1];
  const gain = first && lastH ? lastH.w - first.w : 0;
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const weekTon = ws.filter((w) => w.date > weekAgo).reduce((t, w) => t + tonnage(w), 0);
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
    <div class="hero"><div class="ava">${esc(initials(c.name))}</div><div><h2>${esc(c.name)}</h2>
      <div class="meta">${c.startDate ? `С ${dateRu(c.startDate)} · ` : ""}${ws.length} ${plural(ws.length, "тренировка", "тренировки", "тренировок")}${c.goal ? ` · цель: ${esc(c.goal)}` : ""}</div></div></div>
    ${progress}
    <div class="stats">
      <div class="stat"><div class="lbl">Вес тела</div><div class="v">${c.bodyStart || c.bodyNow ? `${fmt(num(c.bodyStart))}→${fmt(num(c.bodyNow))}` : "—"}</div></div>
      <div class="stat"><div class="lbl">Тоннаж/нед</div><div class="v">${weekTon >= 1000 ? fmt(weekTon / 1000) + "т" : fmt(weekTon) + "кг"}</div></div>
      <div class="stat"><div class="lbl">Рекорды</div><div class="v">${records}</div></div>
    </div>
    ${c.notes ? `<div class="panel meta" style="white-space:pre-wrap">${esc(c.notes)}</div>` : ""}
    <button class="btn block" data-act="newWorkout" data-id="${cid}">+ Новая тренировка</button>
    ${ws.length ? `<div class="list">${ws.slice().reverse().map((w) => `<button class="sess" data-go="#/w/${w.id}">
      <span><b>${dateRu(w.date)}</b> · ${esc(w.title || "Тренировка")}</span>
      <span class="meta">${(w.exercises || []).length} упр · ${fmt(tonnage(w))} кг</span></button>`).join("")}</div>` : ""}
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
  form.querySelector("input")?.focus();
  return bg;
}

function clientSheet(c) {
  const v = (k) => esc(c?.[k] ?? "");
  sheet(`
    <div class="navrow"><button type="button" class="link" data-close>Отмена</button><b>${c ? "Клиент" : "Новый клиент"}</b><button class="link" type="submit">Сохранить</button></div>
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
    if (!data.name) return false;
    const id = c?.id || uid();
    setDoc(userDoc("clients", id), { ...data, ...(c ? {} : { createdAt: Date.now() }), updatedAt: Date.now() }, { merge: true }).catch(showError);
    if (!c) go(`#/c/${id}`);
  });
  document.getElementById("delClient")?.addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Точно удалить? Нажми ещё раз"; return; }
    const batch = writeBatch(db);
    workoutsOf(c.id).forEach((w) => batch.delete(userDoc("workouts", w.id)));
    batch.delete(userDoc("clients", c.id));
    batch.commit().catch(showError);
    document.querySelector(".sheet-bg")?.remove();
    go("#/");
  });
}

function menuSheet() {
  sheet(`
    <div class="navrow"><button type="button" class="link" data-close>Закрыть</button><b>Меню</b><span></span></div>
    <div class="meta">Вошёл как ${esc(state.user.email)}</div>
    <button type="button" class="btn block" id="exp">Экспорт в файл (бэкап)</button>
    <label class="btn ghost block" style="text-align:center">Импорт из файла<input type="file" accept="application/json" id="imp" hidden></label>
    <button type="button" class="link danger" id="logout">Выйти</button>
  `, () => {});
  document.getElementById("exp").onclick = exportData;
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
    case "editClient": return clientSheet(state.clients.find((c) => c.id === t.dataset.id));
    case "newWorkout": {
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

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
