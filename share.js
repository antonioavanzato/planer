// Картинка «Прогресс клиента» для отправки в мессенджеры и сторис (1080×1350).
// На картинке только имя клиента, без фамилии.

const GOLD = "#e0a33a", CREAM = "#f3eee2", MUTED = "rgba(243,238,226,.55)", GREEN = "#5cc07c";
const fmt = (n) => (Math.round(n * 10) / 10).toString().replace(".", ",");

function periodRu(days) {
  const pl = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  if (days < 14) { const d = Math.max(1, days); return `за ${d} ${pl(d, "день", "дня", "дней")}`; }
  if (days < 60) { const w = Math.round(days / 7); return `за ${w} ${pl(w, "неделю", "недели", "недель")}`; }
  const m = Math.round(days / 30.4); return `за ${m} ${pl(m, "месяц", "месяца", "месяцев")}`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function dumbbell(ctx, x, y, s, color) {
  ctx.fillStyle = color;
  const r = (a, b, w, h) => { roundRect(ctx, x + a * s, y + b * s, w * s, h * s, 1.2 * s); ctx.fill(); };
  r(12, 22, 6, 20); r(46, 22, 6, 20); r(6.5, 26, 4.5, 12); r(53, 26, 4.5, 12); r(18, 30, 28, 4);
}

export async function progressCard({ name, exercise, hist, workouts, records }) {
  await Promise.all([
    document.fonts.load('800 90px "Manrope"'), document.fonts.load('600 40px "Manrope"'),
    document.fonts.load('700 150px "JetBrains Mono"'),
  ]).catch(() => {});
  const W = 1080, H = 1350, P = 84;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const first = hist[0], last = hist[hist.length - 1];
  const gain = last.w - first.w;
  const days = Math.round((new Date(last.date) - new Date(first.date)) / 864e5);

  // фон
  const g = ctx.createRadialGradient(W / 2, -100, 100, W / 2, 200, 1300);
  g.addColorStop(0, "#335845"); g.addColorStop(0.5, "#18261f"); g.addColorStop(1, "#0c1410");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  // шапка
  dumbbell(ctx, P - 6, 70, 1.4, GOLD);
  ctx.fillStyle = GOLD; ctx.font = '700 30px "Manrope", sans-serif'; ctx.textBaseline = "middle";
  ctx.letterSpacing = "6px"; ctx.fillText("ПРОГРЕСС", P + 92, 115); ctx.letterSpacing = "0px";

  // имя и упражнение
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = CREAM; ctx.font = '800 96px "Manrope", sans-serif'; ctx.fillText(name, P, 290);
  ctx.fillStyle = MUTED; ctx.font = '600 44px "Manrope", sans-serif'; ctx.fillText(exercise, P, 360);

  // было → стало
  ctx.font = '700 150px "JetBrains Mono", monospace';
  const a = fmt(first.w), b = fmt(last.w);
  ctx.fillStyle = MUTED; ctx.fillText(a, P, 560);
  let x = P + ctx.measureText(a).width + 34;
  ctx.fillStyle = MUTED; ctx.font = '600 70px "Manrope", sans-serif'; ctx.fillText("→", x, 540);
  x += ctx.measureText("→").width + 34;
  ctx.fillStyle = GOLD; ctx.font = '700 150px "JetBrains Mono", monospace'; ctx.fillText(b, x, 560);
  x += ctx.measureText(b).width + 18;
  ctx.fillStyle = MUTED; ctx.font = '600 48px "Manrope", sans-serif'; ctx.fillText("кг", x, 560);

  // плашка прироста
  const badge = `${gain >= 0 ? "+" : ""}${fmt(gain)} кг ${periodRu(days)}`;
  ctx.font = '700 42px "Manrope", sans-serif';
  const bw = ctx.measureText(badge).width + 64;
  roundRect(ctx, P, 610, bw, 84, 42); ctx.fillStyle = "rgba(92,192,124,.16)"; ctx.fill();
  ctx.fillStyle = GREEN; ctx.textBaseline = "middle"; ctx.fillText(badge, P + 32, 653); ctx.textBaseline = "alphabetic";

  // график
  const cx = P, cy = 760, cw = W - P * 2, ch = 300;
  const ws = hist.map((h) => h.w);
  let lo = Math.min(...ws), hi = Math.max(...ws); if (hi === lo) { hi += 5; lo -= 5; }
  const px = (i) => cx + (hist.length === 1 ? cw / 2 : (i * cw) / (hist.length - 1));
  const py = (v) => cy + ((hi - v) * ch) / (hi - lo);
  ctx.strokeStyle = "rgba(243,238,226,.12)"; ctx.lineWidth = 2;
  [hi, lo].forEach((v) => { ctx.beginPath(); ctx.moveTo(cx, py(v)); ctx.lineTo(cx + cw, py(v)); ctx.stroke(); });
  if (hist.length > 1) {
    const area = ctx.createLinearGradient(0, cy, 0, cy + ch);
    area.addColorStop(0, "rgba(224,163,58,.35)"); area.addColorStop(1, "rgba(224,163,58,0)");
    ctx.beginPath(); ctx.moveTo(px(0), py(lo));
    hist.forEach((h, i) => ctx.lineTo(px(i), py(h.w)));
    ctx.lineTo(px(hist.length - 1), py(lo)); ctx.closePath(); ctx.fillStyle = area; ctx.fill();
    ctx.beginPath(); hist.forEach((h, i) => (i ? ctx.lineTo(px(i), py(h.w)) : ctx.moveTo(px(i), py(h.w))));
    ctx.strokeStyle = GOLD; ctx.lineWidth = 8; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(px(0), py(first.w), 12, 0, Math.PI * 2); ctx.fillStyle = "#18261f"; ctx.fill(); ctx.lineWidth = 6; ctx.strokeStyle = MUTED; ctx.stroke();
  ctx.beginPath(); ctx.arc(px(hist.length - 1), py(last.w), 16, 0, Math.PI * 2); ctx.fillStyle = GOLD; ctx.fill();

  // цифры
  const stat = (x0, val, label) => {
    ctx.fillStyle = CREAM; ctx.font = '700 64px "JetBrains Mono", monospace'; ctx.fillText(String(val), x0, 1170);
    ctx.fillStyle = MUTED; ctx.font = '600 30px "Manrope", sans-serif'; ctx.fillText(label, x0, 1215);
  };
  stat(P, workouts, "тренировок");
  stat(P + 330, records, "рекордов");

  // подпись
  ctx.fillStyle = "rgba(243,238,226,.12)"; ctx.fillRect(P, 1260, cw, 2);
  ctx.fillStyle = CREAM; ctx.font = '700 30px "Manrope", sans-serif'; ctx.fillText("Тренер Яна Самойлова", P, 1310);
  ctx.fillStyle = GOLD; ctx.textAlign = "right"; ctx.fillText("yanapro.ru", W - P, 1310); ctx.textAlign = "left";

  return new Promise((res) => cv.toBlob((bl) => res(bl), "image/png"));
}
