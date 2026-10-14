// Waveform timeline: drawing, zoom, mouse (select, drag-to-crop, move boundaries), playback.
// ---------- timeline: zoom / scroll / draw ----------
const viewW = () => $("waveBox").clientWidth;
const x0 = () => $("hbar").scrollLeft;
const X = t => t * pps - x0();

function applyZoom(keepT, atX) {
  if (!session) return;
  const fit = viewW() / Math.max(session.duration, 0.1), v = +$("zoom").value / 100;
  pps = fit >= MAX_PPS ? fit : fit * Math.pow(MAX_PPS / fit, v);
  $("spacer").style.width = Math.ceil(session.duration * pps) + "px";
  if (keepT != null) $("hbar").scrollLeft = keepT * pps - (atX != null ? atX : viewW() / 2);
  draw();
}

let drawQueued = false;
function requestDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(() => { drawQueued = false; draw(); }); } }

function draw() {
  if (!session || !peaks) return;
  const cv = $("wave"), w = viewW(), H = RULER + WAVE_H, dpr = window.devicePixelRatio || 1;
  if (!w) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + "px";
  }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, H);
  const t0 = x0() / pps, t1 = (x0() + w) / pps, top = RULER, bot = H, mid = top + WAVE_H / 2;

  // segment regions (selected = blue, deleted = red, others alternate greens) + numbers
  g.font = "600 11px system-ui, sans-serif";
  segs.forEach((s, k) => {
    if (s.end < t0 || s.start > t1) return;
    const a = X(s.start), b = X(s.end);
    g.fillStyle = s.deleted ? "rgba(220,38,38,.10)" : s === sel ? "rgba(37,99,235,.15)" : k % 2 ? "rgba(34,197,94,.10)" : "rgba(34,197,94,.20)";
    g.fillRect(a, top, b - a, WAVE_H);
    if (b - a > 24) { g.fillStyle = s === sel ? "#1d4ed8" : s.deleted ? "#b91c1c" : "#4b5563"; g.fillText(String(k + 1), Math.max(a, 0) + 5, top + 14); }
  });

  // waveform
  const amp = (WAVE_H / 2 - 4) / peakMax * gain, nb = peaks.length / 2, ox = x0();
  g.fillStyle = "#5f8a6a";
  for (let x = 0; x < w; x++) {
    const b0 = Math.floor((ox + x) / pps * peakRate);
    if (b0 >= nb) break;
    const b1 = Math.min(nb, Math.max(b0 + 1, Math.floor((ox + x + 1) / pps * peakRate)));
    let lo = 0, hi = 0;
    for (let b = b0; b < b1; b++) { const l = peaks[2 * b], h = peaks[2 * b + 1]; if (l < lo) lo = l; if (h > hi) hi = h; }
    const y1 = Math.max(top, mid - hi * amp), y2 = Math.min(bot, mid - lo * amp);
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }

  // recognized words along the bottom
  segs.forEach(s => {
    if (!s.words || s.end < t0 || s.start > t1) return;
    s.words.forEach((wd, j) => { g.fillStyle = j % 2 ? "#93c5fd" : "#3b82f6"; g.fillRect(X(wd.start), bot - 5, Math.max(2, X(wd.end) - X(wd.start)), 4); });
  });

  // boundaries (draggable) and the selected segment's edges
  segs.forEach((s, k) => {
    if (!k || s.start < t0 - 1 || s.start > t1 + 1) return;
    const x = Math.round(X(s.start));
    g.fillStyle = "#1f2937"; g.fillRect(x - 1, top, 2, WAVE_H);
    g.fillRect(x - 4, top, 8, 4);
  });
  if (sel) [sel.start, sel.end].forEach(t => { const x = Math.round(X(t)); g.fillStyle = "#2563eb"; g.fillRect(x - 1, top, 2, WAVE_H); });

  // range being dragged for cropping
  if (dragRange) {
    const a = X(dragRange[0]), b = X(dragRange[1]);
    g.fillStyle = "rgba(245,158,11,.25)"; g.fillRect(a, top, b - a, WAVE_H);
    g.fillStyle = "#d97706"; g.fillRect(Math.round(a) - 1, top, 2, WAVE_H); g.fillRect(Math.round(b) - 1, top, 2, WAVE_H);
    g.font = "600 11px system-ui, sans-serif";
    const label = `Crop ${(dragRange[1] - dragRange[0]).toFixed(2)} s`;
    if (b - a > g.measureText(label).width + 10) g.fillText(label, a + 5, bot - 10);
  }

  // time ruler
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, RULER);
  g.fillStyle = "#e5e7eb"; g.fillRect(0, RULER - 1, w, 1);
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200].find(s => s * pps >= 90) || 3600;
  g.font = "10px system-ui, sans-serif";
  for (let n = Math.floor(t0 / step); n * step <= t1; n++) {
    const t = n * step, x = Math.round(X(t)) + 0.5;
    g.fillStyle = "#9ca3af"; g.fillRect(x, RULER - 10, 1, 9);
    for (let m = 1; m < 5; m++) g.fillRect(Math.round(X(t + m * step / 5)), RULER - 5, 1, 4);
    g.fillStyle = "#4b5563"; g.fillText(fmtT(t).slice(0, step < 1 ? -2 : -4), x + 3, 11);
  }

  // hover line
  if (hover != null) {
    const x = Math.round(X(hover));
    g.fillStyle = "rgba(15,23,42,.3)"; g.fillRect(x, top, 1, WAVE_H);
  }

  // playhead with time label
  const px = Math.round(X(pos));
  if (px >= -60 && px <= w + 2) {
    g.fillStyle = "#111827"; g.fillRect(px - 1, 0, 2, H);
    g.beginPath(); g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px, 7); g.fill();
    const label = fmtT(pos); g.font = "11px system-ui, sans-serif";
    const tw = g.measureText(label).width + 8, lx = px + 4 + tw > w ? px - tw - 4 : px + 4;
    g.fillStyle = "rgba(255,255,255,.85)"; g.fillRect(lx, mid - 9, tw, 18);
    g.fillStyle = "#111827"; g.fillText(label, lx + 4, mid + 4);
  }
}

$("hbar").onscroll = requestDraw;
$("zoom").oninput = () => applyZoom(pos, Math.min(viewW(), Math.max(0, X(pos))));
$("gain").oninput = () => { gain = +$("gain").value; $("gainOut").textContent = gain + "x"; draw(); };
window.addEventListener("resize", () => session && applyZoom(pos));

// ---------- timeline mouse ----------
const tAt = e => Math.min(session.duration, Math.max(0, (x0() + e.clientX - $("wave").getBoundingClientRect().left) / pps));

function boundaryNear(e) {   // index k of the segment whose start line is within 6 px, or -1
  const x = x0() + e.clientX - $("wave").getBoundingClientRect().left;
  let best = -1, bd = 6;
  segs.forEach((s, k) => { if (!k) return; const d = Math.abs(s.start * pps - x); if (d < bd) { bd = d; best = k; } });
  return best;
}

$("wave").addEventListener("mousedown", e => {
  if (!session || e.button !== 0) return;
  e.preventDefault();
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  const k = boundaryNear(e);
  if (k < 0) {   // click = select + seek; drag = mark a range and crop it into its own segment
    const t0 = tAt(e), cx = e.clientX;
    seek(t0); select(segAt(t0));
    const move = ev => {
      if (Math.abs(ev.clientX - cx) < 4 && !dragRange) return;
      const t = tAt(ev);
      dragRange = [Math.min(t0, t), Math.max(t0, t)];
      hover = t;
      setStatus(`Crop ${fmtT(dragRange[0])} – ${fmtT(dragRange[1])} (${(dragRange[1] - dragRange[0]).toFixed(2)} s) — release to cut`);
      requestDraw();
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const r = dragRange;
      dragRange = null;
      if (r) cropRange(r[0], r[1]); else requestDraw();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return;
  }
  const a = segs[k - 1], b = segs[k];
  const before = snap(), old = b.start;
  const gaps = gapTimes([...(a.words || []), ...(b.words || [])]);   // word gaps the line snaps to
  const move = ev => {
    let t = tAt(ev);
    if (!ev.altKey) { const tol = 8 / pps; gaps.forEach(gp => { if (Math.abs(gp - t) < tol) t = gp; }); }
    a.end = b.start = r3(Math.min(b.end - 0.1, Math.max(a.start + 0.1, t)));
    hover = b.start; requestDraw();
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (b.start === old) return;
    pushUndo(before);
    if (untouched(a) && untouched(b)) {   // words follow the boundary, so the text stays in sync
      const all = [...a.words, ...b.words];
      a.words = all.filter(w => (w.start + w.end) / 2 < b.start);
      b.words = all.filter(w => (w.start + w.end) / 2 >= b.start);
      [a, b].forEach(s => { s.text = s.wordsText = wordsToText(s.words); staleNorm(s); });
    }
    dirty();
    requestDraw();
    hooks.structure();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});
$("wave").addEventListener("mousemove", e => {
  if (!session) return;
  hover = tAt(e);
  $("wave").style.cursor = boundaryNear(e) > 0 ? "ew-resize" : "crosshair";
  requestDraw();
});
$("wave").addEventListener("mouseleave", () => { hover = null; requestDraw(); });
$("wave").addEventListener("dblclick", e => { const k = boundaryNear(e); if (k > 0) merge(k); });
$("wave").addEventListener("wheel", e => {
  if (!session || !e.ctrlKey) return;
  e.preventDefault();
  const t = tAt(e), atX = e.clientX - $("wave").getBoundingClientRect().left;
  $("zoom").value = Math.min(100, Math.max(0, +$("zoom").value + (e.deltaY < 0 ? 8 : -8)));
  applyZoom(t, atX);
}, { passive: false });

// ---------- playback ----------
const OFF = () => (session && session.offset) || 0;   // editor time 0 = this second of the audio file
function showClock() { if (session) $("clock").textContent = `${fmtT(pos)}/${fmtT(session.duration)}`; }

function seek(t) {
  pos = Math.min(session.duration, Math.max(0, t));
  if (!player.paused) { player.currentTime = pos + OFF(); playEnd = null; }
  showClock(); requestDraw();
}

function follow() {   // keep the playhead on screen while playing
  const x = X(pos), w = viewW();
  if (x < 0 || x > w - 30) $("hbar").scrollLeft = pos * pps - w * 0.1;
}

async function playFrom(t, end = null) {
  if (!session) return;
  pos = t; playEnd = end;
  player.playbackRate = +$("speed").value;
  try { player.currentTime = t + OFF(); await player.play(); }
  catch (e) { return setStatus("Cannot play: " + e.message); }
  $("btnPlay").innerHTML = icon("pause");
  if (!ticking) { ticking = true; requestAnimationFrame(tick); }
}

function tick() {
  if (!player.paused) {
    pos = player.currentTime - OFF();
    if (playEnd != null && pos >= playEnd) { player.pause(); pos = playEnd; playEnd = null; }
    else if (pos >= session.duration) { player.pause(); pos = session.duration; }   // end of the crop
    else follow();
  }
  showClock(); draw();
  if (player.paused) { ticking = false; $("btnPlay").innerHTML = icon("play"); return; }
  requestAnimationFrame(tick);
}

function togglePlay() {
  if (!session) return;
  if (!player.paused) return player.pause();
  playFrom(pos >= session.duration - 0.02 ? 0 : pos);
}

$("btnPlay").onclick = togglePlay;
$("speed").onchange = () => { player.playbackRate = +$("speed").value; };
