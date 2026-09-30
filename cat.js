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
    <span class="cat-bubble"></span></div><span class="cat-ball"></span>`;
  document.body.append(lane);

  const pos = lane.querySelector(".cat-pos"), flip = lane.querySelector(".cat-flip"), jumpEl = lane.querySelector(".cat-jump");
  const cat = lane.querySelector(".cat"), bubble = lane.querySelector(".cat-bubble"), ball = lane.querySelector(".cat-ball");
  const W = 44; // ширина котика
  let x = 0, facing = 1, token = 0, visible = false, busy = false;
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
  const weights = [["stroll", 5], ["sit", 3], ["wash", 2], ["nap", 1.3], ["hop", 1.5], ["zoomies", 1], ["ball", 1.6]];
  const nextAct = () => {
    const hour = new Date().getHours();
    const sleepy = hour >= 22 || hour < 7;
    let total = 0; const list = weights.map(([n, w]) => [n, n === "nap" && sleepy ? w * 5 : w]);
    list.forEach(([, w]) => (total += w));
    let r = Math.random() * total;
    for (const [n, w] of list) { if ((r -= w) <= 0) return n; }
    return "sit";
  };

  async function life(my) {
    while (my === token) {
      if (!visible || document.hidden || reduced) { setState(reduced ? "sit" : "sleep"); await wait(1500); continue; }
      if (busy) { await wait(300); continue; }
      await acts[nextAct()]();
    }
  }

  // Погладить котика
  cat.parentElement.parentElement.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    const wasSleeping = cat.classList.contains("sleep");
    setState("sit");
    say(wasSleeping ? "мяу?" : pick(["мур-р ♥", "мяу!", "♥", "мрр…"]));
    await jump(wasSleeping ? 10 : 16);
    busy = false;
  });
  lane.addEventListener("click", (e) => e.stopPropagation());

  place(minX() + 20, 0); face(1); setState("sit");
  const start = () => { token++; life(token); };
  start();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) start(); });

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
