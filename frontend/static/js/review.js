// One imported dataset (#/dataset/<id>): quality overview, background jobs (checks, push), the review panel of one
// clip (waveform + trim, cut in parts / join, text vs ASR diff, normalized text, accept / use ASR text / reject) and
// the filtered, sorted clip list. Every decision is saved at once (PATCH /api/datasets/<id>/items/<n>);
// n = position of the clip in ds.items (cutting or joining a clip moves the ones after it, so ds is loaded again).
let ds = null;               // GET /api/datasets/<id>
let dsTab = "todo", dsPage = 1, dsPer = 20;
let rvN = -1;                // clip in the review panel
let rvWave = null;           // decoded samples of that clip (Float32Array) + sample rate
let rvCut = null;            // where "Cut here" cuts (s in the clip file): set by a click on the waveform or a pause
let rvTextTimer = null, rvTextPending = false;
let rvNormTimer = null, rvNormPending = false, rvAutoTimer = null;
let jobTimer = null, jobTick = 0, lastJobRunning = false;
const rvAudio = new Audio();
let audioCtx = null;

const FLAG_SHORT = { empty_text: "No text", no_speech: "No speech", too_short: "Too short", dup_audio: "Duplicate audio",
  asr_empty: "ASR heard nothing", too_long: "Too long", digits: "Digits", latin: "Latin letters", symbols: "Symbols",
  clipping: "Clipping", quiet: "Quiet", rate: "Speaking rate", long_silence: "Long silence", dup_text: "Same text" };
const STATUS_LABEL = { todo: "To review", accepted: "Accepted", rejected: "Rejected" };
const cerClass = c => c == null ? "" : c <= ds.cer_pass ? "cer-pass" : c <= 0.5 ? "cer-review" : "cer-bad";
const fmtCer = c => c == null ? "–" : `${Math.round(c * 100)}%`;
const flagChip = f => `<span class="flag ${ds.flag_info[f]?.severity || "info"}" title="${esc(ds.flag_info[f]?.text || f)}">${esc(FLAG_SHORT[f] || f)}</span>`;
const clipTrim = it => it.trim || [0, it.duration];
const clipLen = it => { const [s, e] = clipTrim(it); return e - s; };
const rowLabel = it => it.part ? `${it.idx} · ${it.part}` : `${it.idx}`;
const otherParts = it => ds.items.filter(x => x.idx === it.idx && x !== it);

// ---------- open ----------
async function openDataset(id) {
  await flushReview();
  rvN = -1; rvWave = null;
  ds = await fetchJson(`/api/datasets/${id}`);
  dsTab = ds.status_counts.todo ? "todo" : "all"; dsPage = 1;
  ["dsQ", "dsCat", "dsFlag"].forEach(f => { $(f).value = ""; });
  $("dsSort").value = "cer";
  $("passCer").value = Math.round(ds.cer_pass * 100);
  $("dsTitle").textContent = ds.name;
  $("dsSource").innerHTML = `<a href="https://huggingface.co/datasets/${esc(ds.repo)}" target="_blank" rel="noopener">${esc(ds.repo)}</a>
    · ${esc(ds.config)} / ${esc(ds.split)} · text column <b>${esc(ds.text_column)}</b>`;
  $("dsFlag").innerHTML = `<option value="">Every problem</option>` +
    Object.keys(ds.flag_info).map(f => `<option value="${f}">${esc(FLAG_SHORT[f] || f)}</option>`).join("");
  $("dsJob").hidden = true;
  renderDataset();
  const first = dsOrder()[0];
  if (first !== undefined) showClip(first, false); else $("rv").hidden = true;
  pollJob();
  return ds;
}

async function reloadDataset() {   // after a job: keep the open clip and the text being typed
  const fresh = await fetchJson(`/api/datasets/${ds.id}`);
  if (rvN >= 0 && rvTextPending && fresh.items[rvN]) fresh.items[rvN].text = $("rvText").value;
  ds = fresh;
  renderDataset();
  if (rvN >= 0 && ds.items[rvN]) fillPanel(document.activeElement !== $("rvText"));
}

function renderDataset() { renderDsStats(); renderDsList(); }

// ---------- overview ----------
function renderDsStats() {
  const its = ds.items, by = (k, v) => its.filter(it => it[k] === v), dur = l => l.reduce((a, it) => a + (it.trim ? it.trim[1] - it.trim[0] : it.duration), 0);
  const checked = its.filter(it => it.asr_text != null).length, acc = by("status", "accepted");
  const fixed = acc.filter(it => it.text !== it.original_text).length, n = its.length || 1;
  const dot = c => `<span class="dot c-${c}"></span>`;
  $("dsStats").innerHTML = `
    <span>Clips: <b>${its.length}</b> (${fmtHms(dur(its))})</span>
    <span>Checked by ASR: <b>${checked}</b> / ${its.length}</span>
    ${["pass", "review", "bad", "unchecked"].map(c => `<span>${dot(c)}${CAT_LABEL[c]}: <b>${by("category", c).length}</b></span>`).join("")}
    <span>${dot("accepted")}Accepted: <b>${acc.length}</b> (${fmtHms(dur(acc))}${fixed ? `, ${fixed} text fixed` : ""})</span>
    <span>${dot("rejected")}Rejected: <b>${by("status", "rejected").length}</b></span>
    <span>To review: <b>${by("status", "todo").length}</b></span>`;
  $("dsCatBar").innerHTML = ["pass", "review", "bad", "unchecked"].map(c =>
    `<div class="c-${c}" style="width:${100 * by("category", c).length / n}%" title="${CAT_LABEL[c]}"></div>`).join("");
  $("btnCheck").innerHTML = icon("recognize") + (checked && checked === its.length ? " Re-run checks" : checked ? ` Check the other ${its.length - checked}` : " Run checks");
}

// ---------- list ----------
function dsOrder() {
  const q = $("dsQ").value.trim().toLowerCase(), cat = $("dsCat").value, flag = $("dsFlag").value, sort = $("dsSort").value;
  const list = ds.items.map((_, n) => n).filter(n => {
    const it = ds.items[n];
    return (dsTab === "all" || it.status === dsTab) && (!cat || it.category === cat) && (!flag || it.flags.includes(flag)) &&
           (!q || String(it.idx) === q || it.text.toLowerCase().includes(q) || (it.asr_text || "").toLowerCase().includes(q));
  });
  const rank = { bad: 0, review: 1, unchecked: 2, pass: 3 }, it = n => ds.items[n];
  const cmp = { row: (a, b) => it(a).idx - it(b).idx || (it(a).part || 0) - (it(b).part || 0), long: (a, b) => it(b).duration - it(a).duration,
                short: (a, b) => it(a).duration - it(b).duration,
                cer: (a, b) => rank[it(a).category] - rank[it(b).category] || (it(b).cer ?? -1) - (it(a).cer ?? -1) || it(a).idx - it(b).idx || (it(a).part || 0) - (it(b).part || 0) };
  return list.sort(cmp[sort]);
}

function renderDsList() {
  const list = dsOrder(), pages = Math.max(1, Math.ceil(list.length / dsPer));
  dsPage = Math.min(dsPage, pages);
  const shown = list.slice((dsPage - 1) * dsPer, dsPage * dsPer);
  $("dsBody").innerHTML = shown.map(n => {
    const it = ds.items[n];
    return `<tr data-n="${n}" class="${n === rvN ? "on" : ""}">
      <td>${rowLabel(it)}</td><td>${clipLen(it).toFixed(1)} s</td>
      <td class="t" lang="km" title="${esc(it.text)}">${esc(it.text) || "<span class='muted'>(empty)</span>"}</td>
      <td class="t" lang="km" title="${esc(it.asr_text || "")}">${esc(it.asr_text ?? "–")}</td>
      <td><span class="pill ${cerClass(it.cer)}">${fmtCer(it.cer)}</span></td>
      <td><div class="flags">${it.flags.map(flagChip).join("")}</div></td>
      <td><span class="badge ${it.status}">${STATUS_LABEL[it.status]}</span></td></tr>`;
  }).join("");
  $("dsListEmpty").hidden = list.length > 0;
  $("dsPager").innerHTML = list.length ? `<span>Current ${(dsPage - 1) * dsPer + 1}-${(dsPage - 1) * dsPer + shown.length}, Total: ${list.length}</span>
    <button data-p="${dsPage - 1}" ${dsPage === 1 ? "disabled" : ""} aria-label="Previous page">${icon("chevron-left")}</button>
    <span>Page <input id="dsPageNo" type="number" min="1" max="${pages}" value="${dsPage}" class="num"> / ${pages}</span>
    <button data-p="${dsPage + 1}" ${dsPage === pages ? "disabled" : ""} aria-label="Next page">${icon("chevron-right")}</button>
    <select id="dsPerSel" aria-label="Clips per page">${[20, 50, 100].map(k => `<option value="${k}" ${k === dsPer ? "selected" : ""}>${k} / page</option>`).join("")}</select>` : "";
  if ($("dsPerSel")) $("dsPerSel").onchange = e => { dsPer = +e.target.value; dsPage = 1; renderDsList(); };
  if ($("dsPageNo")) $("dsPageNo").onchange = e => { dsPage = Math.max(1, Math.min(pages, +e.target.value || 1)); renderDsList(); };
  document.querySelectorAll("#dsTabs button").forEach(b => {
    const k = b.dataset.f, count = k === "all" ? ds.items.length : ds.items.filter(it => it.status === k).length;
    b.innerHTML = `${{ todo: "To review", accepted: "Accepted", rejected: "Rejected", all: "All" }[k]}<span class="n">${count}</span>`;
    b.classList.toggle("on", k === dsTab);
    b.setAttribute("aria-selected", k === dsTab);
  });
}

$("dsBody").addEventListener("click", e => { const tr = e.target.closest("tr[data-n]"); if (tr) showClip(+tr.dataset.n, true); });
$("dsPager").addEventListener("click", e => { const b = e.target.closest("button[data-p]"); if (b && !b.disabled) { dsPage = +b.dataset.p; renderDsList(); } });
document.querySelectorAll("#dsTabs button").forEach(b => b.onclick = () => { dsTab = b.dataset.f; dsPage = 1; renderDsList(); });
["dsCat", "dsFlag", "dsSort"].forEach(id => $(id).onchange = () => { dsPage = 1; renderDsList(); });
$("dsQ").oninput = () => { dsPage = 1; renderDsList(); };
$("btnBackDs").onclick = () => { location.hash = "#/datasets"; };

// ---------- review panel ----------
async function showClip(n, play) {
  await flushReview();
  rvN = n; rvCut = null;
  const order = dsOrder(), k = order.indexOf(n);
  if (k >= 0) dsPage = Math.floor(k / dsPer) + 1;
  $("rv").hidden = false;
  fillPanel(true);
  renderDsList();
  rvWave = null; drawWave();
  rvAudio.pause();
  const url = `/api/datasets/${ds.id}/clips/${n}`;
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    if (rvN !== n) return;
    rvAudio.src = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    rvAudio.currentTime = clipTrim(ds.items[n])[0];
    audioCtx = audioCtx || new AudioContext();
    const decoded = await audioCtx.decodeAudioData(buf);
    if (rvN !== n) return;
    rvWave = { data: decoded.getChannelData(0), rate: decoded.sampleRate };
    drawWave();
    if (play) playClip();
  } catch (e) { notify("Cannot load the clip: " + e.message, "error"); }
}

function fillPanel(withText) {
  const it = ds.items[rvN], order = dsOrder(), k = order.indexOf(rvN);
  $("rvTitle").textContent = `Row ${it.idx}` + (it.part ? ` · part ${it.part} of ${otherParts(it).length + 1}` : "") +
    ` · ${clipLen(it).toFixed(2)} s` + (it.source_file ? ` · ${it.source_file}` : "");
  $("rvCat").className = `badge ${it.category}`; $("rvCat").textContent = CAT_LABEL[it.category];
  $("rvStatus").className = `badge ${it.status}`;
  $("rvStatus").textContent = STATUS_LABEL[it.status] + (it.status === "rejected" && it.reason ? `: ${it.reason}` : "");
  $("rvPos").textContent = k >= 0 ? `${k + 1} / ${order.length}` : "–";
  $("rvPrev").disabled = k <= 0; $("rvNext").disabled = k < 0 || k >= order.length - 1;
  if (withText) { $("rvText").value = it.text; rvTextPending = false; }
  if (withText || !rvNormPending) fillNorm();
  $("rvJoin").hidden = !otherParts(it).some(x => clipTrim(x)[0] > clipTrim(it)[0]);
  const [s, e] = clipTrim(it);
  $("rvStart").value = s.toFixed(2); $("rvEnd").value = e.toFixed(2);
  $("rvStart").max = $("rvEnd").max = it.duration;
  $("rvReason").value = it.status === "rejected" ? it.reason : "";
  $("rvFlags").innerHTML = it.flags.map(f => `<span class="flag ${ds.flag_info[f].severity}">${esc(ds.flag_info[f].text)}</span>`).join("");
  $("rvSaved").textContent = it.text !== it.original_text ? "(edited)" : "";
  renderDiff();
  updateTime();
}

function renderDiff() {
  const it = ds.items[rvN];
  if (it.asr_text == null) {
    $("rvOrig").textContent = $("rvText").value;
    $("rvAsr").innerHTML = `<span class="muted">Not checked yet — press “Run checks”.</span>`;
    $("rvCer").textContent = "–"; $("rvCer").className = "pill";
    return;
  }
  const [a, b] = diffHtml($("rvText").value, it.asr_text);
  $("rvOrig").innerHTML = a; $("rvAsr").innerHTML = b;
  $("rvCer").textContent = "CER " + fmtCer(it.cer); $("rvCer").className = `pill ${cerClass(it.cer)}`;
}

// Grapheme diff that ignores spaces and punctuation: red = in the text but not heard, green = heard but not in the text
const graphemes = (() => { const s = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("km", { granularity: "grapheme" }) : null;
  return t => s ? [...s.segment(t || "")].map(x => x.segment) : [...(t || "")]; })();
const isKeyUnit = g => /[\p{L}\p{M}\p{N}]/u.test(g);
function diffHtml(a, b) {
  const A = graphemes(a), B = graphemes(b);
  const ka = A.flatMap((g, i) => isKeyUnit(g) ? [i] : []), kb = B.flatMap((g, i) => isKeyUnit(g) ? [i] : []);
  const n = ka.length, m = kb.length, W = m + 1, dp = new Uint16Array((n + 1) * W);
  const same = (i, j) => A[ka[i]].toLowerCase() === B[kb[j]].toLowerCase();
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * W + j] = same(i, j) ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const okA = new Set(), okB = new Set();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (same(i, j)) { okA.add(ka[i++]); okB.add(kb[j++]); }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++; else j++;
  }
  const render = (G, ok, cls) => {
    let html = "", run = "", bad = false;
    const flush = () => { if (run) html += bad ? `<span class="${cls}">${esc(run)}</span>` : esc(run); run = ""; };
    G.forEach((g, i) => { const miss = isKeyUnit(g) && !ok.has(i); if (miss !== bad && isKeyUnit(g)) { flush(); bad = miss; } run += g; });
    flush();
    return html;
  };
  return [render(A, okA, "del"), render(B, okB, "ins")];
}

// ---------- waveform + playback ----------
function drawWave() {
  const cv = $("rvCanvas"), w = cv.clientWidth || 600, h = cv.clientHeight || 72, dpr = devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (rvN < 0) return;
  const it = ds.items[rvN], dur = it.duration || 1, x = t => t / dur * w, [s, e] = clipTrim(it);
  if (rvWave) {
    const d = rvWave.data, per = d.length / w;
    g.fillStyle = "#3b82f6";
    for (let px = 0; px < w; px++) {
      let lo = 0, hi = 0;
      for (let i = Math.floor(px * per), end = Math.min(d.length, Math.floor((px + 1) * per)); i < end; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      g.fillRect(px, h / 2 - hi * h / 2, 1, Math.max(1, (hi - lo) * h / 2));
    }
  } else { g.fillStyle = "#94a3b8"; g.font = "12px sans-serif"; g.fillText("Loading…", 10, h / 2 + 4); }
  g.fillStyle = "rgba(100,116,139,.35)";              // the parts that are cut off
  g.fillRect(0, 0, x(s), h); g.fillRect(x(e), 0, w - x(e), h);
  g.fillStyle = "#f59e0b";                             // where the other parts of the row are cut
  otherParts(it).forEach(o => clipTrim(o).forEach(t => { if (t > 0 && t < dur) g.fillRect(x(t) - 1, 0, 2, h); }));
  if (rvCut != null) {                                 // where "Cut here" cuts
    g.strokeStyle = "#10b981"; g.lineWidth = 2; g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(x(rvCut), 0); g.lineTo(x(rvCut), h); g.stroke(); g.setLineDash([]);
  }
  g.fillStyle = "#ef4444"; g.fillRect(x(rvAudio.currentTime || s) - 1, 0, 2, h);   // playhead
}

function updateTime() {
  if (rvN < 0) return;
  const [s, e] = clipTrim(ds.items[rvN]);
  $("rvTime").textContent = `${fmtT(Math.max(0, (rvAudio.currentTime || s) - s))} / ${fmtT(e - s)}`;
}

function playClip() {
  if (rvN < 0) return;
  const [s, e] = clipTrim(ds.items[rvN]);
  if (rvAudio.currentTime < s || rvAudio.currentTime >= e - 0.02) rvAudio.currentTime = s;
  rvAudio.play().catch(() => {});
}
const canCut = t => { const [s, e] = clipTrim(ds.items[rvN]); return t >= s + 0.1 && t <= e - 0.1; };
const toggleClip = () => {
  if (rvAudio.paused) return playClip();
  rvAudio.pause();
  if (canCut(rvAudio.currentTime)) rvCut = rvAudio.currentTime;   // paused where to cut
  drawWave();
};
rvAudio.ontimeupdate = () => {
  if (rvN >= 0 && rvAudio.currentTime >= clipTrim(ds.items[rvN])[1]) rvAudio.pause();
  updateTime();
};
rvAudio.onplay = () => {
  $("rvPlay").innerHTML = icon("pause");
  const tick = () => { drawWave(); updateTime(); if (!rvAudio.paused) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
};
rvAudio.onpause = () => { $("rvPlay").innerHTML = icon("play"); drawWave(); };
$("rvPlay").onclick = toggleClip;
$("rvCanvas").onclick = e => {
  if (rvN < 0) return;
  const r = e.target.getBoundingClientRect(), [s, en] = clipTrim(ds.items[rvN]);
  const t = Math.max(s, Math.min(en - 0.05, (e.clientX - r.left) / r.width * ds.items[rvN].duration));
  rvCut = canCut(t) ? t : null;
  rvAudio.currentTime = t;
  playClip();
};
window.addEventListener("resize", () => { if (!$("pageDataset").hidden) drawWave(); });

// ---------- decisions ----------
async function patchItem(n, changes) {
  const it = await api(`/api/datasets/${ds.id}/items/${n}`, { ...changes, reviewer: userName() }, "PATCH");
  ds.items[n] = it;
  return it;
}

async function saveText() {
  clearTimeout(rvTextTimer);
  if (!rvTextPending || rvN < 0) return;
  const n = rvN, text = $("rvText").value;
  rvTextPending = false;
  try {
    await patchItem(n, { text });
    if (n === rvN) { $("rvSaved").textContent = ds.items[n].text !== ds.items[n].original_text ? "(edited · saved)" : ""; renderDiff(); }
    setSave("All changes saved", "ok");
  } catch (e) { rvTextPending = true; notify("Text not saved: " + e.message, "error"); setSave("Not saved: " + e.message, "err"); }
}
const flushReview = async () => { await saveText(); await saveNorm(); };

// ---------- normalized text: automatic (made from the final text) until a reviewer types it ----------
function fillNorm() {
  const it = ds.items[rvN];
  rvNormPending = false; clearTimeout(rvNormTimer);
  $("rvNorm").value = it.norm ?? "";
  $("rvNormNote").textContent = it.norm != null ? "(edited)" : "(automatic)";
  $("rvNormAuto").hidden = it.norm == null;
  if (it.norm == null) autoNorm();
}

async function autoNorm() {
  clearTimeout(rvAutoTimer);
  const n = rvN, text = $("rvText").value;
  if (n < 0 || ds.items[n].norm != null || rvNormPending) return;
  let norm = "";
  if (text.trim()) { try { norm = (await api("/api/text/normalize", { text })).normalized; } catch (e) { return; } }
  if (n === rvN && ds.items[n].norm == null && !rvNormPending && $("rvText").value === text) $("rvNorm").value = norm;
}

async function saveNorm() {
  clearTimeout(rvNormTimer);
  if (!rvNormPending || rvN < 0) return;
  const n = rvN, norm = $("rvNorm").value;
  rvNormPending = false;
  try {
    await patchItem(n, { norm });
    if (n === rvN) fillNorm();
    setSave("All changes saved", "ok");
  } catch (e) { rvNormPending = true; notify("Normalized text not saved: " + e.message, "error"); setSave("Not saved: " + e.message, "err"); }
}

$("rvNorm").oninput = () => {
  rvNormPending = true;
  $("rvNormNote").textContent = "(saving…)";
  clearTimeout(rvNormTimer);
  rvNormTimer = setTimeout(saveNorm, 700);
};
$("rvNormAuto").onclick = () => { $("rvNorm").value = ""; rvNormPending = true; saveNorm(); };

$("rvText").oninput = () => {
  rvTextPending = true;
  $("rvSaved").textContent = "(saving…)";
  renderDiff();
  clearTimeout(rvAutoTimer);
  rvAutoTimer = setTimeout(autoNorm, 300);
  clearTimeout(rvTextTimer);
  rvTextTimer = setTimeout(saveText, 700);
};

// accept / reject, then go to the next clip of the list
async function decide(status, reason = "") {
  if (rvN < 0) return;
  const n = rvN, before = dsOrder(), k = before.indexOf(n);
  rvAudio.pause();
  try {
    await flushReview();
    await patchItem(n, { status, reason, ...(rvTextPending ? { text: $("rvText").value } : {}) });
  } catch (e) { return notify("Not saved: " + e.message, "error"); }
  renderDsStats();
  const after = dsOrder(), pos = after.indexOf(n);
  const next = pos >= 0 ? after[pos + 1] : after[Math.max(0, Math.min(k, after.length - 1))];
  if (next === undefined || (pos >= 0 && pos === after.length - 1)) {
    fillPanel(false); renderDsList();
    return notify("That was the last clip in this list.", "success");
  }
  showClip(next, true);
}

function step(d) {
  const order = dsOrder(), k = order.indexOf(rvN);
  const next = order[k < 0 ? 0 : k + d];
  if (next !== undefined) showClip(next, true);
}

async function setTrim(trim) {
  const n = rvN;
  try { await patchItem(n, { trim }); } catch (e) { return notify("Trim not saved: " + e.message, "error"); }
  if (n === rvN) { fillPanel(false); drawWave(); }
}

$("rvAccept").onclick = () => decide("accepted");
$("rvReject").onclick = () => decide("rejected", $("rvReason").value || "Other");
$("rvUseAsr").onclick = () => {
  const it = ds.items[rvN];
  if (it.asr_text == null) return notify("Run the checks first — there is no ASR text yet.", "info");
  $("rvText").value = it.asr_text; $("rvText").oninput();
};
$("rvReset").onclick = () => { $("rvText").value = ds.items[rvN].original_text; $("rvText").oninput(); };
$("rvPrev").onclick = () => step(-1);
$("rvNext").onclick = () => step(1);
$("rvAutoTrim").onclick = () => {
  const it = ds.items[rvN], a = it.audio || {};
  setTrim([Math.max(0, (a.speech_start ?? 0) - 0.2), Math.min(it.duration, (a.speech_end ?? it.duration) + 0.2)]);
};
$("rvNoTrim").onclick = () => setTrim(null);

// ---------- cut in parts / join / check one clip ----------
async function reloadAt(n) {   // after a cut or join: the clips after n moved
  ds = await fetchJson(`/api/datasets/${ds.id}`);
  renderDataset();
  await showClip(n, false);
}

async function recheck(ns) {   // the ASR on these clips now (one at a time); their CER and category update
  for (const n of ns) {
    try {
      const it = await api(`/api/datasets/${ds.id}/items/${n}/recognize`, {});
      ds.items[n] = { ...it, text: n === rvN && rvTextPending ? $("rvText").value : it.text };
    } catch (e) { return notify("Check failed: " + e.message, "error"); }
    if (n === rvN) fillPanel(false);
  }
  renderDataset();
}

$("rvSplit").onclick = async () => {
  if (rvN < 0) return;
  const n = rvN, at = rvCut ?? rvAudio.currentTime;   // the marker, not the playhead that moved on while playing
  if (!canCut(at))
    return notify("Click the waveform (or play and pause) where the clip should be cut, then press “Cut here”.", "info");
  rvAudio.pause();
  try {
    await flushReview();
    await api(`/api/datasets/${ds.id}/items/${n}/split`, { at, reviewer: userName() });
  } catch (err) { return notify("Not cut: " + err.message, "error"); }
  await reloadAt(n);
  notify(`Cut at ${at.toFixed(2)} s. The first part keeps the text — move the words that belong to the second part.`, "success");
  if (ds.items.some(it => it.asr_text != null)) recheck([n, n + 1]);
};

$("rvJoin").onclick = async () => {
  if (rvN < 0) return;
  const n = rvN;
  rvAudio.pause();
  try {
    await flushReview();
    await api(`/api/datasets/${ds.id}/items/${n}/join`, { reviewer: userName() });
  } catch (err) { return notify("Not joined: " + err.message, "error"); }
  await reloadAt(n);
  if (ds.items.some(it => it.asr_text != null)) recheck([n]);
};

$("rvRecheck").onclick = async () => {
  if (rvN < 0) return;
  $("rvRecheck").disabled = true;
  $("rvAsr").innerHTML = `<span class="muted">${icon("loader", "spin")} Recognizing…</span>`;
  await flushReview();
  await recheck([rvN]);
  $("rvRecheck").disabled = false;
  if (rvN >= 0) renderDiff();
};
$("rvDownload").onclick = () => {
  if (rvN < 0) return;
  const a = document.createElement("a");
  a.href = `/api/datasets/${ds.id}/items/${rvN}/audio`;
  a.click();
};
["rvStart", "rvEnd"].forEach(id => $(id).onchange = () => setTrim([+$("rvStart").value, +$("rvEnd").value]));

document.addEventListener("keydown", e => {
  if ($("pageDataset").hidden || $("rv").hidden || rvN < 0 || document.querySelector("dialog[open]")) return;
  if (e.target === $("rvText") || e.target === $("rvNorm")) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); decide("accepted"); }
    else if (e.key === "Escape") e.target.blur();
    return;
  }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const act = { " ": toggleClip, a: () => decide("accepted"), r: () => $("rvReject").click(), u: () => $("rvUseAsr").click(),
                t: () => $("rvAutoTrim").click(), s: () => $("rvSplit").click(), j: () => step(1), arrowdown: () => step(1), k: () => step(-1), arrowup: () => step(-1),
                e: () => $("rvText").focus() }[k];
  if (act) { e.preventDefault(); act(); }
});

// ---------- jobs: checks, push ----------
async function pollJob() {
  clearTimeout(jobTimer);
  if (!ds || $("pageDataset").hidden) return;
  let job = null;
  try { job = (await fetchJson(`/api/datasets/${ds.id}/job`)).job; } catch (e) {}
  showJob(job);
  const running = !!(job && job.running);
  if (running) {
    if (job.kind === "check" && ++jobTick % 6 === 0) await reloadDataset();   // CER appears while it runs
    jobTimer = setTimeout(pollJob, 1000);
  } else if (lastJobRunning && job) {
    await reloadDataset();
    if (job.error) notify(`${job.kind === "push" ? "Push" : "Job"} failed: ${job.error}`, "error");
    else notify(job.message, "success", job.kind === "push" ? 0 : 5000);
  }
  lastJobRunning = running;
  $("btnCheck").disabled = $("btnDsPush").disabled = running;
}

function showJob(job) {
  const box = $("dsJob");
  if (!job || (!job.running && !lastJobRunning && box.hidden)) { box.hidden = true; return; }
  box.hidden = false;
  box.classList.toggle("err", !!job.error);
  const url = job.result && job.result.url;
  $("dsJobText").innerHTML = (job.running ? icon("loader", "spin") + " " : job.error ? icon("alert") + " " : icon("check") + " ") +
    esc(url ? job.message.replace(url, "") : job.message) + (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : "");
  $("dsJobBar").style.width = `${job.total ? 100 * job.done / job.total : 0}%`;
  $("dsJobBar").parentElement.hidden = !job.running;
  $("btnJobStop").hidden = !job.running;
}
$("btnJobStop").onclick = () => api(`/api/datasets/${ds.id}/stop`, {}).catch(e => notify(e.message, "error"));

$("btnCheck").onclick = async () => {
  const checked = ds.items.filter(it => it.asr_text != null).length, redo = checked === ds.items.length;
  if (redo && !await askConfirm("Every clip is already checked. Recognize all of them again?", { title: "Re-run checks", ok: "Re-run" })) return;
  try { await api(`/api/datasets/${ds.id}/check`, { redo }); lastJobRunning = true; pollJob(); }
  catch (e) { notify("Cannot start the checks: " + e.message, "error"); }
};

$("btnAcceptPass").onclick = async () => {
  const max = (+$("passCer").value || 0) / 100;
  const n = ds.items.filter(it => it.status === "todo" && it.category === "pass" && it.cer != null && it.cer <= max).length;
  if (!n) return notify(ds.items.some(it => it.asr_text != null) ? "No clip to review passed the checks with that CER." : "Run the checks first.", "info");
  if (!await askConfirm(`Accept ${n} clips that passed the checks (CER ≤ ${Math.round(max * 100)}% and no problems found)?`,
                        { title: "Accept passing clips", ok: `Accept ${n}` })) return;
  try {
    const r = await api(`/api/datasets/${ds.id}/accept-passing`, { max_cer: max, reviewer: userName() });
    notify(`${r.accepted} clips accepted.`, "success");
    await reloadDataset();
  } catch (e) { notify(e.message, "error"); }
};

const outParams = () => ({ include: $("outInclude").value, trim: $("outTrim").checked });
$("btnDsExport").onclick = async () => {
  await flushReview();
  const o = outParams(), a = document.createElement("a");
  a.href = `/api/datasets/${ds.id}/export?include=${o.include}&trim=${o.trim ? 1 : 0}`;
  a.click();
  notify("Preparing the ZIP — it downloads in a moment.", "info");
};

// push dialog
const pushCount = () => {
  const inc = $("outInclude").value, its = ds.items.filter(it => inc === "all" || (inc === "accepted" ? it.status === "accepted" : it.status !== "rejected"));
  return [its.length, its.reduce((a, it) => a + (it.trim ? it.trim[1] - it.trim[0] : it.duration), 0)];
};
function updatePushInfo() {
  const [n, sec] = pushCount(), pr = document.querySelector("input[name=pushMode]:checked").value === "pr";
  $("pushPrivate").disabled = pr;
  const split = $("pushSplit").value || ds.split, file = `data/${split}${ds.batch ? "-" + ds.batch.prefix : ""}-*.parquet`;
  $("dsPushInfo").textContent = `${n} clips (${fmtHms(sec)}, ${$("outInclude").selectedOptions[0].textContent.toLowerCase()}) are uploaded as parquet ` +
    `to ${file}, with the normalized text in “${ds.text_column}_normalized”` + (pr ? " in a pull request — the owner of the repo decides whether to merge it." :
    ds.batch ? `. Only this batch's earlier files are replaced: the other batches in the repo stay, and the dataset card's batch table gets a row for ${ds.batch.name}.`
             : ". Older files of that split in the repo are replaced; the dataset card gets a cleaning report.");
  $("pushOk").disabled = !n;
}
$("btnDsPush").onclick = async () => {
  await flushReview();
  const prev = [ds.last_push, ds.sibling_push].find(p => p && !p.pr);   // the batches of a source go to one repo
  $("pushSplit").value = prev ? prev.split : ds.split;
  document.querySelector("input[name=pushMode][value=own]").checked = true;
  $("pushRepo").value = prev ? prev.repo : "";
  updatePushInfo();
  $("pushDialog").showModal();
  if (!$("pushRepo").value) {
    const r = await api("/api/hub/whoami", { token: $("pushToken").value }).catch(() => ({}));
    if (r.name && !$("pushRepo").value) $("pushRepo").value = `${r.name}/${ds.repo.split("/")[1]}_clean`;
    else if (!r.name) $("dsPushInfo").textContent += "\nNot logged in: enter a write token from huggingface.co/settings/tokens (or run `hf auth login`).";
  }
};
document.querySelectorAll("input[name=pushMode]").forEach(r => r.onchange = () => {
  if (r.value === "pr" && r.checked) $("pushRepo").value = ds.repo;
  else if (r.checked && $("pushRepo").value === ds.repo) $("pushRepo").value = "";
  updatePushInfo();
});
$("pushSplit").oninput = updatePushInfo;
$("pushCancel").onclick = () => $("pushDialog").close();
$("pushOk").onclick = async () => {
  const pr = document.querySelector("input[name=pushMode]:checked").value === "pr";
  try {
    await api(`/api/datasets/${ds.id}/push`, { repo_id: $("pushRepo").value, split: $("pushSplit").value, ...outParams(),
      private: $("pushPrivate").checked, create_pr: pr, token: $("pushToken").value });
    $("pushDialog").close();
    lastJobRunning = true;
    pollJob();
  } catch (e) { $("dsPushInfo").textContent = "⚠ " + e.message; }
};
