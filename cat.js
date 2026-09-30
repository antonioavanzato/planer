// Котик-тамагочи: живёт в верхней строке главных экранов и занимается своими делами.
// Двигается только через transform, поэтому не мешает прокрутке. Засыпает, когда приложение свёрнуто.

const CAT_SVG = `
<svg viewBox="0 0 44 32" aria-hidden="true">
  <g class="tail"><path d="M8 20 C2 18 1 10 5 6" fill="none" stroke="var(--cat)" stroke-width="3.2" stroke-linecap="round"/></g>
  <g class="legs">
    <rect class="leg l1" x="10" y="22" width="3.4" height="8" rx="1.7"/>
    <rect class="leg l2" x="14.5" y="22" width="3.4" height="8" rx="1.7"/>
    <rect class="leg l3" x="23" y="22" width="3.4" height="8" rx="1.7"/>
    <rect class="leg l4" x="27.5" y="22" width="3.4" height="8" rx="1.7"/>
  </g>
  <ellipse class="body" cx="20" cy="20" rx="12.5" ry="7.5"/>
  <path class="stripe" d="M15 13.5 q1 4 0 8 M19.5 12.8 q1 4.5 0 9 M24 13.5 q1 4 0 8" fill="none" stroke-width="1.4" stroke-linecap="round"/>
  <g class="head">
    <path class="ear" d="M28 9 L29.5 1.5 L33.5 7 Z"/>
    <path class="ear" d="M36 7 L40 1.5 L40.5 9.5 Z"/>
    <circle class="skull" cx="34" cy="12.5" r="7.5"/>
    <g class="eyes-open"><ellipse cx="32.2" cy="11.8" rx="1.1" ry="1.5"/><ellipse cx="37.4" cy="11.8" rx="1.1" ry="1.5"/></g>
    <g class="eyes-shut" fill="none" stroke-width="1.2" stroke-linecap="round"><path d="M31 12 q1.2 1 2.4 0"/><path d="M36.2 12 q1.2 1 2.4 0"/></g>
    <ellipse class="mouth" cx="34.8" cy="17.2" rx="1.5" ry="1.9"/>
    <path class="nose" d="M34.2 14.6 l1.2 0 l-0.6 0.8 z"/>
    <path class="whisk" d="M30 15.5 l-4 -0.6 M30 16.5 l-4 0.6 M39.5 15.5 l3.5 -0.6 M39.5 16.5 l3.5 0.6" fill="none" stroke-width="0.6" stroke-linecap="round"/>
  </g>
</svg>`;

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function initCat() {
  const lane = document.createElement("div");
  lane.className = "cat-lane";
  lane.innerHTML = `<div class="cat-pos"><div class="cat-flip"><div class="cat-jump"><div class="cat" role="img" aria-label="Котик">${CAT_SVG}</div></div></div>
    <span class="cat-bubble"></span><span class="cat-hearts"></span></div><span class="cat-ball"></span>
    <span class="cat-fly"><i></i><i></i></span>
    <span class="cat-mouse"><svg viewBox="0 0 20 12" aria-hidden="true"><path d="M1 9 C-1 4 3 1 6 3" fill="none" stroke="#8a8f8a" stroke-width="1.2" stroke-linecap="round"/><ellipse cx="10" cy="8" rx="6" ry="3.8" fill="#9aa09a"/><circle cx="15.5" cy="6.5" r="2.8" fill="#9aa09a"/><circle cx="15" cy="4" r="1.6" fill="#c9a3a3"/><circle cx="16.8" cy="6.2" r=".6" fill="#222"/></svg></span>`;
  document.body.append(lane);

  const pos = lane.querySelector(".cat-pos"), flip = lane.querySelector(".cat-flip"), jumpEl = lane.querySelector(".cat-jump");
  const cat = lane.querySelector(".cat"), bubble = lane.querySelector(".cat-bubble"), ball = lane.querySelector(".cat-ball");
  const fly = lane.querySelector(".cat-fly"), mouse = lane.querySelector(".cat-mouse"), hearts = lane.querySelector(".cat-hearts");
  const W = 44; // ширина котика
  let x = 0, facing = 1, visible = false, busy = false;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const width = () => lane.clientWidth;
  const minX = () => 16;                                   // не заходим на скруглённые углы «пола»
  const maxX = () => Math.max(minX() + 20, width() - 16 - W);
  let floorEl = null;

  const setState = (s) => { cat.className = "cat " + s; };
  const face = (dir) => { facing = dir; flip.style.transform = `scaleX(${dir})`; };
  const place = (nx, ms) => {
    pos.style.transition = ms ? `transform ${ms}ms linear` : "none";
    x = nx; pos.style.transform = `translate3d(${x}px,0,0)`;
  };
  const say = (text, ms = 1600) => {
    bubble.textContent = text; bubble.classList.add("on");
    setTimeout(() => bubble.classList.remove("on"), ms);
  };

  async function walkTo(nx, speed = 42) {
    const dist = Math.abs(nx - x);
    if (dist < 4) return;
    face(nx > x ? 1 : -1);
    setState(speed > 60 ? "run" : "walk");
    const ms = (dist / speed) * 1000;
    place(nx, ms);
    await wait(ms);
  }
  const move = (el, tx, ty, ms, ease = "ease-in-out") => {
    el.style.transition = ms ? `transform ${ms}ms ${ease}` : "none";
    el.style.transform = `translate3d(${tx}px,${ty}px,0)`;
  };
  const toEdge = async (speed = 50) => {
    const left = x - minX() < maxX() - x;
    await walkTo(left ? minX() : maxX(), speed);
    face(left ? -1 : 1);
  };
  function burstHearts(n = 4) {
    for (let i = 0; i < n; i++) {
      const h = document.createElement("i");
      h.textContent = "♥";
      h.style.setProperty("--dx", `${rnd(-18, 18)}px`);
      h.style.animationDelay = `${i * 120}ms`;
      hearts.append(h);
      setTimeout(() => h.remove(), 1600 + i * 120);
    }
  }
  async function jump(h = 18) {
    jumpEl.style.setProperty("--h", `-${h}px`);
    jumpEl.classList.remove("hop"); void jumpEl.offsetWidth; jumpEl.classList.add("hop");
    await wait(600);
    jumpEl.classList.remove("hop");
  }

  const acts = {
    async stroll() { await walkTo(rnd(minX(), maxX())); setState("sit"); await wait(rnd(1500, 3500)); },
    async sit() { setState("sit"); await wait(rnd(3000, 6000)); },
    async wash() { setState("wash"); await wait(rnd(2500, 4000)); setState("sit"); },
    async nap() { setState("sleep"); say("z z z", 3000); await wait(rnd(9000, 16000)); setState("sit"); await wait(800); },
    async hop() { setState("sit"); await jump(pick([14, 20, 26])); await wait(700); },
    async zoomies() { await walkTo(pick([minX(), maxX()]), 120); await jump(12); await walkTo(rnd(minX(), maxX()), 120); setState("sit"); },
    async ball() {
      const bx = rnd(minX() + 10, maxX() + W - 10);
      ball.style.transition = "none"; ball.style.transform = `translate3d(${bx}px,0,0) rotate(0deg)`; ball.classList.add("on");
      await wait(200);
      await walkTo(bx - (bx > x ? W - 6 : -6), 70);
      setState("pounce"); await jump(10);
      const kick = Math.max(minX(), Math.min(maxX() + W - 10, bx + facing * rnd(40, 90)));
      ball.style.transition = "transform .9s cubic-bezier(.2,.8,.3,1)";
      ball.style.transform = `translate3d(${kick}px,0,0) rotate(${facing * 540}deg)`;
      await wait(500);
      await walkTo(kick - (facing > 0 ? W - 6 : -6), 90);
      setState("pounce"); await wait(500);
      ball.classList.remove("on");
      setState("sit"); await wait(1200);
    },
  };
  Object.assign(acts, {
    async stretch() { setState("stretch"); await wait(1900); setState("sit"); await wait(600); },
    async yawn() { setState("yawn"); await wait(1400); setState("sit"); await wait(500); },
    async loaf() { setState("loaf"); await wait(rnd(5000, 9000)); setState("sit"); await wait(400); },
    async knead() { setState("knead"); say("мрр… мрр…", 2400); await wait(rnd(2600, 3800)); setState("sit"); },
    async meow() { setState("meow"); say(pick(["мяу", "мяу-мяу", "мрр?", "мяяяу!"])); await wait(900); setState("sit"); await wait(800); },
    async sneeze() { setState("yawn"); await wait(500); setState("sit"); say("апчхи!", 1200); await jump(6); await wait(700); },
    async hunt() {
      setState("crouch"); await wait(rnd(1400, 2400));
      const tx = Math.max(minX(), Math.min(maxX(), x + facing * rnd(40, 80)));
      setState("pounce"); place(tx, 380); await jump(14); setState("sit"); await wait(900);
    },
    async chaseTail() {
      setState("run");
      for (let i = 0; i < 7; i++) { face(-facing); await wait(170); }
      setState("sit"); say("?!", 900); await wait(1200);
    },
    async peek() { await toEdge(); setState("peek"); await wait(rnd(2000, 3200)); setState("sit"); await wait(400); },
    async scratch() { await toEdge(); setState("scratch"); say("шкряб-шкряб", 1800); await wait(2000); setState("sit"); await wait(400); },
    async butterfly() {
      const w = width();
      let fx = pick([0, w - 14]), fy = -44;
      move(fly, fx, fy, 0); fly.classList.add("on");
      setState("lookup");
      for (let i = 0; i < 4; i++) {
        fx = Math.max(6, Math.min(w - 20, x + rnd(-30, 50))); fy = rnd(-50, -26);
        move(fly, fx, fy, 1100);
        face(fx > x + 22 ? 1 : -1);
        await wait(1100);
      }
      await walkTo(Math.max(minX(), Math.min(maxX(), fx - 16)), 70);
      setState("lookup"); await jump(26);
      move(fly, fx + rnd(-60, 60), -120, 1400, "ease-out"); fly.classList.remove("on");
      setState("sit"); say(pick(["эх…", "почти!", "мяу…"]), 1200); await wait(1500);
    },
    async mouseChase() {
      const w = width(), fromLeft = Math.random() < 0.5;
      const start = fromLeft ? -20 : w, end = fromLeft ? w : -20;
      mouse.style.setProperty("--dir", fromLeft ? 1 : -1);
      move(mouse, start, 0, 0); mouse.classList.add("on");
      await wait(50);
      move(mouse, end, 0, 2600, "linear");
      setState("crouch"); face(fromLeft ? 1 : -1); await wait(600);
      await walkTo(fromLeft ? maxX() : minX(), 115);
      await wait(700); mouse.classList.remove("on");
      setState("sit"); say(pick(["убежала!", "в следующий раз!", "мяу!"]), 1400); await wait(1500);
    },
  });
  const weights = [["stroll", 5], ["sit", 2.5], ["wash", 1.6], ["nap", 1.2], ["hop", 1.2], ["zoomies", 0.8], ["ball", 1.3],
    ["stretch", 1.2], ["yawn", 1], ["loaf", 1.2], ["knead", 0.8], ["meow", 1], ["sneeze", 0.4], ["hunt", 1],
    ["chaseTail", 0.6], ["peek", 0.8], ["scratch", 0.7], ["butterfly", 0.9], ["mouseChase", 0.8]];
  const nextAct = () => {
    const hour = new Date().getHours();
    const sleepy = hour >= 22 || hour < 7;
    let total = 0; const list = weights.map(([n, w]) => [n, sleepy && ["nap", "loaf", "yawn"].includes(n) ? w * 4 : w]);
    list.forEach(([, w]) => (total += w));
    let r = Math.random() * total;
    for (const [n, w] of list) { if ((r -= w) <= 0) return n; }
    return "sit";
  };

  // Одна «очередь дел»: следующее действие начинается только когда закончилось текущее.
  const queue = [];
  async function life() {
    for (;;) {
      if (!visible || document.hidden || reduced) { setState(reduced ? "sit" : "sleep"); await wait(1500); continue; }
      if (busy) { await wait(300); continue; }
      const job = queue.shift();
      if (job) { try { await acts[job.name](); } finally { job.done(); } }
      else await acts[nextAct()]();
    }
  }

  // Погладить котика
  // Котик не перехватывает нажатия: касание проходит к приложению, а мы лишь замечаем, что палец попал в котика.
  let pets = [];
  document.addEventListener("pointerdown", (e) => {
    if (!visible) return;
    const r = cat.getBoundingClientRect();
    if (e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4) pet();
  }, { passive: true, capture: true });
  async function pet() {
    const now = Date.now();
    pets = pets.filter((t) => now - t < 2500); pets.push(now);
    if (pets.length >= 3) { pets = []; burstHearts(5); say("мур-мур-мур ♥", 1800); }
    if (busy) return;
    busy = true;
    const wasSleeping = cat.classList.contains("sleep");
    setState("sit");
    say(wasSleeping ? "мяу?" : pick(["мур-р ♥", "мяу!", "♥", "мрр…"]));
    await jump(wasSleeping ? 10 : 16);
    busy = false;
  }

  place(minX() + 20, 0); face(1); setState("sit");
  life();

  // «Пол» — верхняя кромка карточки: ставим дорожку так, чтобы лапы стояли ровно на её краю.
  function fit() {
    if (!floorEl || !floorEl.isConnected) return false;
    const r = floorEl.getBoundingClientRect();
    if (!r.width) return false;
    lane.style.left = `${r.left + scrollX}px`;
    lane.style.width = `${r.width}px`;
    lane.style.top = `${r.top + scrollY - lane.offsetHeight + 1}px`;
    return true;
  }
  addEventListener("resize", () => { fit(); place(Math.min(Math.max(x, minX()), maxX()), 0); });
  document.fonts?.ready?.then(() => fit());

  return {
    // для проверки: выполнить конкретное действие
    act(name) { return new Promise((done) => { queue.length = 0; queue.push({ name, done }); }); },
    setFloor(el) {
      floorEl = el || null;
      const ok = fit();
      this.setVisible(ok);
      if (ok) place(Math.min(Math.max(x, minX()), maxX()), 0);
    },
    setVisible(v) {
      if (v === visible) return;
      visible = v;
      lane.classList.toggle("on", v);
      if (v) { place(Math.min(Math.max(x, minX()), maxX()), 0); }
    },
  };
}
