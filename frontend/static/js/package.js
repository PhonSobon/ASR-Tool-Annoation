// Package view (task page): one crop in the cut editor (cut it into dialogue segments), the Dialogue Segments
// table (role, annotation text, normalized text, recognize), Role Information and Overall Audio Information.
// In the editor, times are relative to the crop (0 = crop start); they are stored in seg.parts in audio-file time.
const CHALLENGES = ["Emotional speech", "Fast speech", "Whispering", "Shouting", "Accented speech", "Low volume",
                    "Reverb / echo", "Overlapping speech", "Laughter", "Singing"];
const DEFAULT_INFO = { language: "Khmer", overlap: "Solo monologue", codeSwitch: "No", challenges: [] };
const REQUIRED_INFO = { language: "Primary Language", accent: "Accent / Dialect", domain: "Industry Domain",
                        style: "Speech Style", overlap: "Speaker Overlap Type", codeSwitch: "Code Switching Present" };
let segRunning = false;

const pkg = () => crops[cur];

// ---------- open / leave ----------
async function openPackage(i) {
  if (i < 0 || i >= crops.length) return;
  if (recRunning) return notify("Wait until “Recognize all” finishes (or press Stop), then open a package.", "warn");
  if (segRunning) return notify("Wait until recognition of this package finishes.", "warn");
  await saveNow();                                  // the package that was open before
  cur = i;
  const c = pkg(), a = c.audio, off = c.seg.start;
  $("pkgListView").hidden = true;
  $("pkgWorkView").hidden = false;
  setCrumbs([["Workbench"], ["My Tasks", "#/tasks"], [curTask.name], [c.pkg]]);
  $("pkgEditorSlot").appendChild($("editorArea"));
  window.scrollTo(0, 0);

  if (!cropPeaks.has(a.id)) {
    try {
      const p = await fetchJson(`/api/audios/${a.id}/peaks`), bin = atob(p.peaks), arr = new Int8Array(bin.length);
      for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
      cropPeaks.set(a.id, { peaks: arr, rate: p.rate });
    } catch (e) { cur = -1; showList(); return notify("Cannot open the package: " + e.message, "error"); }
  }
  if (cur !== i) return;
  const pk = cropPeaks.get(a.id);
  peaks = pk.peaks.subarray(2 * Math.floor(off * pk.rate), 2 * Math.ceil(c.seg.end * pk.rate));   // this crop only
  peakRate = pk.rate;
  peakMax = 1;
  for (let k = 0; k < peaks.length; k++) peakMax = Math.max(peakMax, Math.abs(peaks[k]));

  session = { id: a.id, name: c.pkg, duration: c.seg.end - off, offset: off, onSave: segments => savePackage(c, segments) };
  const rel = t => r3(t - off);
  setSegments(c.seg.parts.map(p => ({ ...p, start: rel(p.start), end: rel(p.end),
    words: p.words && p.words.map(w => ({ ...w, start: rel(w.start), end: rel(w.end) })) })));
  pos = 0; playEnd = null; hover = null; dragRange = null;
  undoStack.length = redoStack.length = 0;
  savePending = false;
  const src = `/api/audios/${a.id}/audio`;
  player.pause();
  if (!player.src.endsWith(src)) player.src = src;
  $("edName").textContent = c.pkg;
  $("edDur").innerHTML = icon("clock") + fmtDur(session.duration);
  $("edInfo").textContent = `${a.name} · ${fmtT(c.seg.start)} – ${fmtT(c.seg.end)} in the original audio`;
  $("editorArea").hidden = false;
  $("zoom").value = 0;
  setStatus("Listen, then cut the package where the speaker changes (S at the playhead, or drag across the waveform). Fill in the table and the forms below.");
  hooks.structure = () => { renderTable(); paintPackage(); };
  hooks.select = s => { paintSelection(); fillRoleInfo(); if (s) { const tr = $("seg-" + s.id); tr && tr.scrollIntoView({ block: "nearest" }); } };

  prefillInfo(c);
  renderTable(); updateUndo(); showClock(); paintPackage(); fillRoleInfo(); fillAudioInfo();
  requestAnimationFrame(() => applyZoom(0));
}

// Autosave of the editor: its segments become the package's parts (audio-file time)
async function savePackage(c, segments) {
  const off = c.seg.start, abs = t => r3(t + off);
  c.seg.parts = segments.map(s => ({ ...s, start: abs(s.start), end: abs(s.end),
    words: s.words && s.words.map(w => ({ ...w, start: abs(w.start), end: abs(w.end) })) }));
  syncCrop(c.seg);
  markCropDirty(c);
  await saveCropAudio(c.audio);
  if (pkg() === c) paintPackage();
}

function stepPackage(d) {
  const list = workList(), next = list[list.indexOf(cur) + d];
  if (next != null) openPackage(next);
  else if (d > 0) { showList(); setTaskStatus(`That was the last package in ${cropTab === "todo" ? "Todo" : "Processed"}.`); }
}
$("pkgPrev").onclick = () => stepPackage(-1);
$("pkgNext").onclick = () => stepPackage(1);
$("pkgDoneNext").onclick = () => stepPackage(1);
$("btnBackList").onclick = () => showList();
$("btnSpec").onclick = () => $("specDialog").showModal();
document.addEventListener("keydown", e => {
  if ($("pageTask").hidden || cur < 0 || !(e.ctrlKey || e.metaKey)) return;
  if (e.key === "ArrowDown") { e.preventDefault(); stepPackage(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); stepPackage(-1); }
});

function paintPackage() {
  const c = pkg();
  if (!c) return;
  const st = cropState(c), list = workList(), at = list.indexOf(cur);
  $("pkgId").textContent = c.pkg;
  $("pkgState").className = "badge " + st;
  $("pkgState").textContent = STATUS[st];
  $("pkgTaskId").textContent = curTask.id;
  $("pkgWhere").textContent = `${curTask.name} · ${c.audio.name} · Crop ${c.no} · ${fmtT(c.seg.start)} – ${fmtT(c.seg.end)}`;
  $("pkgPos").textContent = `${at + 1} / ${list.length}`;
  $("pkgPrev").disabled = at <= 0;
  $("pkgNext").disabled = at >= list.length - 1;
  $("btnSkipPkg").innerHTML = c.seg.deleted ? icon("restore") + "Restore package" : icon("trash") + "Skip package";
  $("btnSkipPkg").title = c.seg.deleted ? "Put this package back into the export" : "Leave the whole package out of the export (noise, music, no speech…)";
  $("btnRecSegs").disabled = segRunning || c.seg.deleted;
  showMissing();
}

$("btnSkipPkg").onclick = () => {
  const c = pkg();
  c.seg.deleted = !c.seg.deleted;
  markCropDirty(c);
  paintPackage();
};

// ---------- Dialogue Segments table ----------
function grow(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; }

function renderTable() {
  const body = $("segBody");
  body.innerHTML = "";
  segs.forEach(s => body.appendChild(rowFor(s)));
  body.querySelectorAll("textarea").forEach(grow);
}

function rowFor(s) {
  const tr = document.createElement("tr");
  tr.id = "seg-" + s.id;
  tr.innerHTML = `
    <td class="c"><b class="no"></b><span class="badge"></span></td>
    <td class="num tStart"></td><td class="num tEnd"></td><td class="num tDur"></td>
    <td><input class="role" list="roles" aria-label="Role"></td>
    <td><textarea class="ann" rows="1" placeholder="Annotation text…"></textarea><div class="errmsg"></div></td>
    <td><textarea class="norm" rows="1" placeholder="Normalized text…"></textarea>
      <button class="link reauto" title="Make it again from the annotation text">${icon("restore")} Auto-normalize</button></td>
    <td><div class="acts">
      <button class="icon bPlay" title="Play this segment" aria-label="Play this segment">${icon("play")}</button>
      <button class="icon bRec" title="Recognize this segment" aria-label="Recognize this segment">${icon("recognize")}</button>
      <button class="icon bDel"></button></div></td>`;
  const q = c => tr.querySelector(c);
  q(".role").value = s.role;
  q(".role").oninput = e => { s.role = e.target.value; dirty(); if (s === sel) fillRoleInfo(); };
  q(".ann").oninput = e => { s.text = e.target.value; dirty(); grow(e.target); if (!s.normEdited) scheduleNorm(s); paintRow(s); };
  q(".norm").oninput = e => { s.norm = e.target.value; s.normEdited = !!s.norm.trim(); dirty(); grow(e.target); q(".reauto").hidden = !s.normEdited; };
  q(".reauto").onclick = () => { s.normEdited = false; q(".reauto").hidden = true; scheduleNorm(s, 0); };
  q(".bPlay").onclick = () => { select(s); playFrom(s.start, s.end); };
  q(".bRec").onclick = () => recognizeSeg(s, true);
  q(".bDel").onclick = () => toggleDelete(s);
  tr.addEventListener("focusin", () => { if (sel !== s) select(s, { seek: true }); });
  tr.addEventListener("mousedown", e => { if (!e.target.closest("button, input, textarea")) select(s, { seek: true }); });
  paintRow(s, tr);
  return tr;
}

function segState(s) { return s.deleted ? "skipped" : s.state === "running" ? "running" : (s.text || "").trim() ? "done" : s.state === "error" ? "error" : "pending"; }

function paintRow(s, tr = $("seg-" + s.id)) {
  if (!tr) return;
  const q = c => tr.querySelector(c), st = segState(s);
  tr.className = st + (s === sel ? " selected" : "");
  q(".no").textContent = segs.indexOf(s) + 1;
  q(".badge").className = "badge " + st;
  q(".badge").textContent = STATUS[st] || st;
  q(".tStart").textContent = fmtT(s.start);
  q(".tEnd").textContent = fmtT(s.end);
  q(".tDur").textContent = (s.end - s.start).toFixed(3);
  if (q(".role").value !== s.role && document.activeElement !== q(".role")) q(".role").value = s.role;
  [[".ann", s.text], [".norm", s.norm]].forEach(([c, v]) => {
    const ta = q(c);
    if (ta.value !== (v || "") && document.activeElement !== ta) { ta.value = v || ""; grow(ta); }
  });
  q(".errmsg").textContent = s.error || "";
  q(".reauto").hidden = !s.normEdited;
  q(".bDel").innerHTML = icon(s.deleted ? "restore" : "trash");
  q(".bDel").setAttribute("aria-label", s.deleted ? "Restore this segment" : "Leave this segment out");
  q(".bDel").title = s.deleted ? "Restore this segment" : "Leave this segment out of the export (can be restored)";
  q(".bRec").disabled = s.deleted || s.state === "running";
}

function paintSelection() { segs.forEach(s => { const tr = $("seg-" + s.id); if (tr) tr.classList.toggle("selected", s === sel); }); }

$("fontSize").onchange = () => {
  document.documentElement.style.setProperty("--tfs", $("fontSize").value);
  try { localStorage.setItem("fontSize", $("fontSize").value); } catch (e) {}
  document.querySelectorAll("#segBody textarea").forEach(grow);
};
try { const fs = localStorage.getItem("fontSize"); if (fs) { $("fontSize").value = fs; $("fontSize").onchange(); } } catch (e) {}

// Normalized text = annotation text, word-segmented, Khmer digits -> 0-9 (made on the server), until edited by hand
function scheduleNorm(s, delay = 500) {
  clearTimeout(s._t);
  s._t = setTimeout(async () => {
    if (s.normEdited) return;
    const text = s.text || "";
    let norm = "";
    if (text.trim()) { try { norm = (await api("/api/text/normalize", { text })).normalized; } catch (e) { return; } }
    if (s.text !== text || s.normEdited) return;
    s.norm = norm; paintRow(s); dirty();
  }, delay);
}

// ---------- recognition of this package's segments ----------
async function recognizeSeg(s, manual) {
  if (s.deleted || s.state === "running") return "skip";
  if (manual && handTyped(s) && !await askConfirm(`Segment ${segs.indexOf(s) + 1}: replace your edited text with a new recognition?`,
                                                    { title: "Recognize again", ok: "Replace text" })) return "skip";
  const ses = session, off = OFF();
  s.state = "running"; s.error = "";
  segRunning = true; paintRow(s); paintPackage();
  let result = "done";
  try {
    const j = await api(`/api/audios/${ses.id}/transcribe`, { start: s.start + off, end: s.end + off });
    if (session !== ses || !segs.includes(s)) return "skip";      // left the package meanwhile
    s.text = s.wordsText = j.text; s.state = "done";
    s.words = (j.words || []).map(w => ({ ...w, start: r3(w.start - off), end: r3(w.end - off) }));
    if (!s.normEdited) scheduleNorm(s, 0);
  } catch (e) {
    s.state = "error"; s.error = e.message;
    result = e.fatal ? "fatal" : "error";
  } finally {
    segRunning = false;
  }
  dirty(); paintRow(s); paintPackage(); requestDraw();
  return result;
}

$("btnRecSegs").onclick = async () => {
  const todo = segs.filter(s => !s.deleted && !(s.text || "").trim());
  if (!todo.length) return setStatus("Every segment already has text. Use the Recognize button on a row to recognize it again.");
  const ses = session;
  for (const [k, s] of todo.entries()) {
    if (session !== ses) return;                                   // left the package
    setStatus(`Recognizing segment ${segs.indexOf(s) + 1} (${k + 1} / ${todo.length})…`);
    const r = await recognizeSeg(s, false);
    if (r === "fatal") return notify("Recognition stopped: " + s.error + "\nCheck the model files in models/Omnilingual-ASR-Khm.", "error");
  }
  setStatus("Done. Check every segment's text, then fill in the forms below.");
  notify(`${todo.length} segment(s) recognized. Check the text, then fill in the forms.`, "success");
};

// ---------- Role Information (per role, for the selected segment's role) ----------
const radio = name => (document.querySelector(`input[name="${name}"]:checked`) || {}).value || "";
function setRadio(name, v) { document.querySelectorAll(`input[name="${name}"]`).forEach(r => { r.checked = r.value === v; }); }

function fillRoleInfo() {
  const c = pkg();
  if (!c || !sel) return;
  const role = (sel.role || "").trim(), sp = (c.seg.speakers || {})[role] || {};
  if (document.activeElement !== $("riRole")) $("riRole").value = sel.role || "";
  $("roleFor").textContent = `for segment ${segs.indexOf(sel) + 1}` + (role ? ` — everyone with the role “${role}” in this package` : "");
  $("riAge").value = sp.age || "";
  setRadio("riGender", sp.gender || "");
  setRadio("riNative", sp.native || "");
}

function saveRoleInfo() {
  const c = pkg(), role = (sel && sel.role || "").trim();
  if (!c || !role) return setStatus("Give the segment a role first.");
  c.seg.speakers = { ...(c.seg.speakers || {}), [role]: { age: $("riAge").value, gender: radio("riGender"), native: radio("riNative") } };
  markCropDirty(c);
  showMissing();
}
$("riRole").oninput = e => { if (!sel) return; sel.role = e.target.value; paintRow(sel); dirty(); fillRoleInfo(); };
$("riAge").onchange = saveRoleInfo;
document.querySelectorAll('input[name="riGender"], input[name="riNative"]').forEach(r => { r.onchange = saveRoleInfo; });

// ---------- Overall Audio Information (per package) ----------
$("riChallenges").innerHTML = CHALLENGES.map(ch => `<button type="button" class="chip" data-ch="${esc(ch)}">${esc(ch)}</button>`).join("");

// New packages start from the previous package of the same audio (or the task), so you only confirm
function prefillInfo(c) {
  let changed = false;
  if (!c.seg.info) {
    const same = crops.filter(x => x !== c && x.seg.info);
    const near = same.filter(x => x.audio === c.audio && x.no < c.no).pop() || same.find(x => x.audio === c.audio) || same[0];
    c.seg.info = JSON.parse(JSON.stringify(near ? near.seg.info : DEFAULT_INFO));
    changed = true;
  }
  const speakers = c.seg.speakers || {};
  for (const p of liveParts(c.seg)) {                    // a role already described in another package
    const role = (p.role || "").trim(), from = crops.find(x => x !== c && (x.seg.speakers || {})[role]);
    if (role && !speakers[role] && from) { speakers[role] = { ...from.seg.speakers[role] }; changed = true; }
  }
  c.seg.speakers = speakers;
  if (changed) markCropDirty(c, false);
}

function fillAudioInfo() {
  const info = pkg().seg.info || {};
  document.querySelectorAll("[data-info]").forEach(el => { el.value = info[el.dataset.info] || ""; });
  document.querySelectorAll("#riChallenges .chip").forEach(b => b.classList.toggle("on", (info.challenges || []).includes(b.dataset.ch)));
}

document.querySelectorAll("[data-info]").forEach(el => {
  el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
    const c = pkg();
    c.seg.info = { ...(c.seg.info || {}), [el.dataset.info]: el.value };
    markCropDirty(c);
    showMissing();
  });
});
$("riChallenges").onclick = e => {
  const b = e.target.closest(".chip");
  if (!b) return;
  const c = pkg(), list = new Set((c.seg.info || {}).challenges || []);
  list.has(b.dataset.ch) ? list.delete(b.dataset.ch) : list.add(b.dataset.ch);
  c.seg.info = { ...(c.seg.info || {}), challenges: [...list] };
  b.classList.toggle("on");
  markCropDirty(c);
};

// ---------- what is still missing (required fields) ----------
function showMissing() {
  const c = pkg();
  if (!c) return;
  const miss = [], live = segs.filter(s => !s.deleted);
  if (c.seg.deleted) { $("pkgMissing").innerHTML = icon("info") + "This package is skipped — it is left out of the export."; return; }
  live.forEach(s => {
    const n = segs.indexOf(s) + 1;
    if (!(s.role || "").trim()) miss.push(`role of segment ${n}`);
    if (!(s.text || "").trim()) miss.push(`text of segment ${n}`);
  });
  for (const role of new Set(live.map(s => (s.role || "").trim()).filter(Boolean))) {
    const sp = (c.seg.speakers || {})[role] || {};
    const gaps = [["age", "age group"], ["gender", "gender"], ["native", "native speaker"]].filter(([k]) => !sp[k]).map(([, l]) => l);
    if (gaps.length) miss.push(`${role}: ${gaps.join(", ")}`);
  }
  const info = c.seg.info || {};
  Object.entries(REQUIRED_INFO).forEach(([k, label]) => { if (!(info[k] || "").trim()) miss.push(label); });
  $("pkgMissing").innerHTML = miss.length
    ? icon("alert") + esc(`Missing: ${miss.slice(0, 6).join(" · ")}${miss.length > 6 ? ` · +${miss.length - 6} more` : ""}`)
    : icon("check-circle") + "All required fields are filled.";
  $("pkgMissing").classList.toggle("errmsg", miss.length > 0);
}
