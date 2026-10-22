// Task page, list view = "Task Batch List": one package per crop, Todo / Processed tabs, filters, duration stats.
// A package keeps its dialogue segments in seg.parts (times in the audio file); seg.text / norm / state follow them.
// Every change is saved per audio (PUT /api/audios/<id>/state). The package view itself is in package.js.
let curTask = null;          // GET /api/tasks/<id>: {id, name, created, ..., audios: [{id, name, segments}]}
let crops = [];              // [{audio, seg, no, pkg}] every package of the task (no = crop number in its audio)
let cur = -1;                // index in crops of the package open in the package view (-1 = list view)
let cropTab = "todo";        // "todo" or "processed" (checked and completed by the annotator, or skipped)
let pkgPage = 1, pkgPer = 10;
let recRunning = false, recStop = false;
const cropPeaks = new Map(); // audio id -> {peaks: Int8Array, rate, max}
const cropSaveTimers = new Map(), cropUnsaved = new Set();

const liveParts = seg => (seg.parts || []).filter(p => !p.deleted);
function cropState(c) {
  const s = c.seg, parts = liveParts(s);
  if (s.deleted || !parts.length) return "skipped";
  if (parts.some(p => p.state === "running")) return "running";
  if (parts.every(p => (p.text || "").trim())) return s.completed ? "done" : "review";   // review = recognized, not checked yet
  return parts.some(p => p.state === "error") ? "error" : "pending";
}
const STATUS = { pending: "Pending", running: "Recognizing", error: "Error", review: "To check", done: "Completed", skipped: "Skipped" };
const handTyped = s => !!s.text && s.text !== s.wordsText;   // never overwrite in a batch
const isProcessed = c => ["done", "skipped"].includes(cropState(c));
const inTab = (c, tab) => tab === "processed" ? isProcessed(c) : !isProcessed(c);
const pkgName = (a, no) => `${a.name.replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "_")}_${String(no).padStart(4, "0")}`;   // = exported file name

// Crops saved before dialogue segments existed get one part = the whole crop
function ensureParts(seg) {
  if (!seg.parts || !seg.parts.length)
    seg.parts = [{ id: 1, start: seg.start, end: seg.end, role: seg.role || "Narrator", text: seg.text || "", norm: seg.norm || "",
                   normEdited: !!seg.normEdited, words: seg.words || null, wordsText: seg.wordsText ?? null,
                   state: seg.state === "running" ? "pending" : (seg.state || "pending"), error: seg.error || "", deleted: false }];
  seg.parts.forEach(p => { if (p.state === "running") p.state = "pending"; });
  syncCrop(seg);
}

// seg.text / norm / role / state summarize the parts (what My Tasks counts and older exports read)
function syncCrop(seg) {
  const parts = liveParts(seg);
  seg.text = parts.map(p => (p.text || "").trim()).filter(Boolean).join(" ");
  seg.norm = parts.map(p => (p.norm || "").trim()).filter(Boolean).join(" ");
  seg.role = (parts[0] || {}).role || seg.role || "Narrator";
  seg.state = parts.length && parts.every(p => (p.text || "").trim()) ? "done" : parts.some(p => p.state === "error") ? "error" : "pending";
  if (seg.state !== "done") seg.completed = false;   // a segment lost its text (or a new one was cut): back to Todo
}

function setTaskStatus(t) { $("taskStatus").textContent = t; }

// ---------- open a task ----------
async function openTask(id) {
  await flushCropSaves();
  curTask = await fetchJson(`/api/tasks/${id}`);
  crops = curTask.audios.flatMap(a => a.segments.map((seg, k) => {
    ensureParts(seg);
    return { audio: a, seg, no: k + 1, pkg: pkgName(a, k + 1) };
  }));
  ["fAudio", "fPkg", "fAnnotator"].forEach(f => { $(f).value = ""; });
  cropTab = crops.some(c => inTab(c, "todo")) || !crops.length ? "todo" : "processed";
  pkgPage = 1;
  setTaskStatus("");
  tpWasRunning = tpRunning = false;
  await showList();
  $("tpJob").hidden = true;
  tpPoll();                // a push to the Hub of this task may still be running
  return curTask;
}

// ---------- list view ----------
async function showList() {
  if (cur >= 0) { await saveNow(); closeAudio(); }   // leave the package view: save it, free the editor
  cur = -1;
  $("pkgListView").hidden = false;
  $("pkgWorkView").hidden = true;
  $("taskSub").textContent = `${curTask.name} - Package List`;
  setCrumbs([["Workbench"], ["My Tasks", "#/tasks"], [curTask.name]]);
  renderPackages();
}

function filteredPackages() {
  const qa = $("fAudio").value.trim().toLowerCase(), qp = $("fPkg").value.trim().toLowerCase(), who = $("fAnnotator").value;
  return crops.map((c, i) => i).filter(i => {
    const c = crops[i];
    return inTab(c, cropTab) && (!qa || c.audio.name.toLowerCase().includes(qa)) &&
           (!qp || c.pkg.toLowerCase().includes(qp)) && (!who || (c.seg.annotator || "") === who);
  });
}

function renderPackages() {
  const list = filteredPackages(), pages = Math.max(1, Math.ceil(list.length / pkgPer));
  pkgPage = Math.min(pkgPage, pages);
  const shown = list.slice((pkgPage - 1) * pkgPer, pkgPage * pkgPer);
  $("pkgBody").innerHTML = shown.map(i => {
    const c = crops[i], s = c.seg, st = cropState(c), n = liveParts(s).length;
    return `<tr data-i="${i}">
      <td><a class="open">${esc(c.pkg)}</a>
        <div class="pkg-sub">${fmtT(s.start)} – ${fmtT(s.end)} · ${(s.end - s.start).toFixed(1)} s${n > 1 ? ` · ${n} segments` : ""}</div></td>
      <td><span class="st ${st}">${STATUS[st]}</span></td>
      <td>${s.annotator ? `<span class="who">${esc(s.annotator)}</span>` : "-"}</td>
      <td>-</td><td>-</td><td>-</td>
      <td>${esc(curTask.created)}</td>
      <td>${esc(s.updated || "-")}</td>
      <td><a class="open">${cropTab === "todo" ? "Annotate" : "View"}</a></td></tr>`;
  }).join("");
  $("pkgEmpty").hidden = list.length > 0;
  $("pkgPager").innerHTML = list.length ? `<span>Current ${(pkgPage - 1) * pkgPer + 1}-${(pkgPage - 1) * pkgPer + shown.length}, Total: ${list.length}</span>
    <button data-p="${pkgPage - 1}" ${pkgPage === 1 ? "disabled" : ""} aria-label="Previous page">${icon("chevron-left")}</button>` +
    Array.from({ length: pages }, (_, k) => `<button data-p="${k + 1}" class="${k + 1 === pkgPage ? "on" : ""}">${k + 1}</button>`).join("") +
    `<button data-p="${pkgPage + 1}" ${pkgPage === pages ? "disabled" : ""} aria-label="Next page">${icon("chevron-right")}</button>
    <select id="pkgPer" aria-label="Packages per page">${[10, 20, 50, 100].map(n => `<option value="${n}" ${n === pkgPer ? "selected" : ""}>${n} / page</option>`).join("")}</select>` : "";
  const per = $("pkgPer");
  if (per) per.onchange = () => { pkgPer = +per.value; pkgPage = 1; renderPackages(); };
  updateTabCounts();
  updateDurationStats();
  updateAnnotatorFilter();
  $("btnClaim").disabled = !crops.some(c => inTab(c, "todo"));
  tpUpdateButton();
}

function updateTabCounts() {
  document.querySelectorAll(".crop-tabs button").forEach(b => {
    b.innerHTML = `${b.dataset.f === "todo" ? "Todo" : "Processed"}<span class="n">${crops.filter(c => inTab(c, b.dataset.f)).length}</span>`;
    b.classList.toggle("on", b.dataset.f === cropTab);
    b.setAttribute("aria-selected", b.dataset.f === cropTab);
  });
}

function updateDurationStats() {
  const live = crops.filter(c => cropState(c) !== "skipped"), len = c => liveParts(c.seg).reduce((a, p) => a + p.end - p.start, 0);
  const total = live.reduce((a, c) => a + len(c), 0), done = live.filter(c => cropState(c) === "done").reduce((a, c) => a + len(c), 0);
  const q = t => `<span class="q" title="${t}">${icon("help")}</span>`;
  $("durStats").innerHTML =
    `<span>Total Duration: <b>${fmtHms(total)}</b>${q("Length of all segments in this task (skipped ones not counted)")}</span>
     <span>Effective Duration: <b>${fmtHms(done)}</b>${q("Length of the completed packages (every segment has annotation text)")}</span>
     <span>Quality Passed Effective Duration: <b>0h 0m 0s</b>${q("Completed packages that passed quality inspection — inspection is not set up yet")}</span>`;
}

function updateAnnotatorFilter() {
  const sel = $("fAnnotator"), keep = sel.value;
  const names = [...new Set(crops.map(c => c.seg.annotator).filter(Boolean))].sort();
  sel.innerHTML = `<option value="">Filter by annotator</option>` + names.map(n => `<option>${esc(n)}</option>`).join("");
  sel.value = names.includes(keep) ? keep : "";
}

$("pkgBody").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-i]");
  if (tr && e.target.closest("a.open")) openPackage(+tr.dataset.i);
});
$("pkgPager").addEventListener("click", e => { const b = e.target.closest("button[data-p]"); if (b && !b.disabled) { pkgPage = +b.dataset.p; renderPackages(); } });
document.querySelectorAll(".crop-tabs button").forEach(b => b.onclick = () => { cropTab = b.dataset.f; pkgPage = 1; renderPackages(); });
["fAudio", "fPkg"].forEach(id => {
  $(id).oninput = () => { pkgPage = 1; renderPackages(); };
  $(id).nextElementSibling.onclick = () => { pkgPage = 1; renderPackages(); };
});
$("fAnnotator").onchange = () => { pkgPage = 1; renderPackages(); };
$("btnBackTasks").onclick = () => { location.hash = "#/tasks"; };
$("btnClaim").onclick = () => {
  const i = crops.findIndex(c => inTab(c, "todo"));
  if (i >= 0) { cropTab = "todo"; openPackage(i); }
};

// The packages Prev / Next walk through: the open tab with its filters (the open package always included)
function workList() {
  const list = filteredPackages();
  if (cur >= 0 && !list.includes(cur)) { list.push(cur); list.sort((a, b) => a - b); }
  return list;
}

// ---------- Recognize all (every segment without text in the task) ----------
async function recognizePart(c, p) {   // p: a part of c.seg (times in the audio file)
  p.state = "running"; p.error = "";
  let result = "done";
  try {
    const j = await api(`/api/audios/${c.audio.id}/transcribe`, { start: p.start, end: p.end });
    p.text = p.wordsText = j.text; p.words = j.words || null; p.state = "done";
    if (!p.normEdited) p.norm = j.text.trim() ? (await api("/api/text/normalize", { text: j.text })).normalized : "";
  } catch (e) {
    p.state = "error"; p.error = e.message;
    result = e.fatal ? "fatal" : "error";
  }
  syncCrop(c.seg);
  markCropDirty(c);
  return result;
}

$("btnRecAll").onclick = async () => {
  recRunning = true; recStop = false;
  $("btnRecAll").disabled = true; $("btnRecStop").disabled = false;
  const todo = crops.filter(c => !c.seg.deleted).flatMap(c =>
    liveParts(c.seg).filter(p => p.state !== "done" && !handTyped(p) && !(p.text || "").trim()).map(p => [c, p]));
  let k = 0, fatal = false;
  for (const [c, p] of todo) {
    if (recStop) break;
    setTaskStatus(`Recognizing ${++k} / ${todo.length}: ${c.pkg}…`);
    renderPackages();
    if (await recognizePart(c, p) === "fatal") {
      setTaskStatus("Stopped — " + p.error);
      notify("Recognition stopped: " + p.error + "\nCheck the model files in models/Omnilingual-ASR-Khm.", "error");
      fatal = true;
      break;
    }
  }
  recRunning = false;
  $("btnRecAll").disabled = false; $("btnRecStop").disabled = true;
  if (cur < 0) renderPackages();
  if (fatal) return;
  const err = crops.filter(c => cropState(c) === "error").length;
  const msg = `${recStop ? "Stopped" : "Finished"}: ${k} segment(s) recognized${err ? `, ${err} package(s) with errors (open them and press Recognize)` : ""}.` +
              (todo.length ? "" : " Nothing to do — every segment already has text.") +
              " Check each package in Todo, then press Complete to move it to Processed.";
  setTaskStatus(msg);
  notify(msg, err ? "warn" : recStop ? "info" : "success");
};
$("btnRecStop").onclick = () => { recStop = true; setTaskStatus("Stopping after the current segment…"); };

// ---------- saving (per audio) and export ----------
// touched = the annotator changed it (stamps annotator + update time); false for automatic updates
function markCropDirty(c, touched = true) {
  if (touched) {
    c.seg.updated = nowStamp();
    if (userName()) c.seg.annotator = userName();
  }
  const a = c.audio;
  cropUnsaved.add(a);
  clearTimeout(cropSaveTimers.get(a));
  cropSaveTimers.set(a, setTimeout(() => saveCropAudio(a), 800));
  setSave("Unsaved changes…");
  $("cwSave").innerHTML = icon("loader", "spin") + "Saving…";
}

async function saveCropAudio(a) {
  clearTimeout(cropSaveTimers.get(a));
  if (!cropUnsaved.delete(a)) return;
  const segments = JSON.parse(JSON.stringify(a.segments, (k, v) => k.startsWith("_") ? undefined : v))
    .map(s => ({ ...s, parts: s.parts && s.parts.map(p => ({ ...p, state: p.state === "running" ? "pending" : p.state })) }));
  try {
    await api(`/api/audios/${a.id}/state`, { segments }, "PUT");
    if (!cropUnsaved.size) { setSave("All changes saved", "ok"); $("cwSave").innerHTML = icon("check") + "Saved"; }
  } catch (e) {
    if (!cropUnsaved.has(a)) notify(`Not saved (${a.name}): ${e.message}. It will be tried again with your next change.`, "error");
    cropUnsaved.add(a);
    setSave("Not saved: " + e.message, "err");
    $("cwSave").innerHTML = icon("alert") + "Not saved";
  }
}

async function flushCropSaves() {
  for (const a of [...cropUnsaved]) await saveCropAudio(a);
}

$("btnExportTask").onclick = async () => {
  if (!curTask) return;
  await flushCropSaves();
  const a = document.createElement("a");
  a.href = `/api/tasks/${curTask.id}/export`;
  a.click();
  setTaskStatus(`Exporting “${curTask.name}”…`);
  notify(`Exporting “${curTask.name}” — the ZIP will download in a moment.`, "info");
};
