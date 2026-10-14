// Upload & Crop page: upload several audio files, cut them (one or all), fix the cuts, push the ticked ones to a task.
let draftItems = [];         // audio still in Upload & Crop (+ rows of files being uploaded)

async function loadDrafts() {
  $("uploadEditorSlot").appendChild($("editorArea"));   // the package page borrows the editor
  try { draftItems = (await fetchJson("/api/audios")).audios; }
  catch (e) { draftItems = []; setStatus("Cannot load audio: " + e.message); }
  renderDrafts();
  const keep = session && draftItems.some(a => a.id === session.id);
  if (keep) { markOpenRow(); requestAnimationFrame(() => applyZoom(pos)); }
  else if (draftItems.length) await openDraft(draftItems[0]);
  else closeAudio();
  updateUploadControls();
}

function renderDrafts() {
  renderAudioList($("draftList"), draftItems, { onOpen: openDraft, onDelete: deleteDraft, onPick: updateUploadControls });
  const ready = draftItems.filter(a => !a.uploading && !a.error);
  $("draftEmpty").hidden = draftItems.length > 0;
  $("draftCount").textContent = ready.length ? `(${ready.length})` : "";
  updateUploadControls();
}

function updateUploadControls() {
  const ready = draftItems.filter(a => !a.uploading && !a.error);
  const inList = session && ready.some(a => a.id === session.id);
  $("btnCut").disabled = !inList;
  $("btnCutAll").disabled = !ready.length;
  $("pushBar").hidden = !ready.length;
  const picked = ready.filter(isPicked), uncut = picked.filter(a => !isCut(a)).length;
  $("btnPush").innerHTML = `Push ${picked.length} selected audio to task ${icon("arrow-right")}`;
  $("btnPush").disabled = !picked.length;
  $("pushInfo").textContent = `${picked.length} of ${ready.length} audio ticked` +
    (picked.length < ready.length ? " — the others stay here" : "") + (uncut ? ` · ${uncut} ticked audio not cut yet` : "");
  if (!$("taskName").value) $("taskName").placeholder = `Batch ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  showEstimate();
}

async function openDraft(it) {
  if (session && session.id === it.id) return;   // already open
  try { if (await loadAudio(it.id)) markOpenRow(); }
  catch (e) { setStatus("Cannot open audio: " + e.message); }
  updateUploadControls();
}

async function deleteDraft(it) {
  if (it.error) { draftItems = draftItems.filter(a => a !== it); return renderDrafts(); }   // failed upload: just the row
  if (!await askConfirm(`Remove “${it.name}” from Upload & Crop? Its audio and cuts will be deleted.`,
                        { title: "Remove audio", ok: "Remove", danger: true })) return;
  try { await fetchJson(`/api/audios/${it.id}`, { method: "DELETE" }); } catch (e) { return notify("Delete failed: " + e.message, "error"); }
  notify(`“${it.name}” removed.`, "success");
  thumbs.delete(it.id);
  draftItems = draftItems.filter(a => a !== it);
  if (session && session.id === it.id) {
    closeAudio();
    const next = draftItems.find(a => !a.uploading && !a.error);
    if (next) await openDraft(next);
  }
  renderDrafts();
}

// ---------- step 1: upload one or more files (one request each, with progress) ----------
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(), fd = new FormData();
    fd.append("audio", file);
    x.open("POST", "/api/audios");
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let j = {};
      try { j = JSON.parse(x.responseText); } catch (e) {}
      x.status < 300 ? resolve(j) : reject(new Error(j.error || `HTTP ${x.status}`));
    };
    x.onerror = () => reject(new Error("Network error"));
    x.send(fd);
  });
}

let uploading = false;
const uploadQueue = [];
async function addFiles(files) {
  const rows = [...files].map(f => ({ file: f, name: f.name, uploading: true, progress: 0 }));
  if (!rows.length) return;
  draftItems.push(...rows);
  uploadQueue.push(...rows);
  renderDrafts();
  if (uploading) return;                 // the running loop picks up the new rows
  uploading = true;
  while (uploadQueue.length) {
    const row = uploadQueue.shift();
    try {
      const j = await uploadFile(row.file, p => {
        row.progress = p;
        const el = [...$("draftList").children][draftItems.indexOf(row)];
        if (el) fillRowInfo(el, row, "crop");
      });
      draftItems[draftItems.indexOf(row)] = j;
      if (!session || !draftItems.some(a => a.id === session.id)) { renderDrafts(); await openDraft(j); }
    } catch (e) {
      Object.assign(row, { uploading: false, error: `${row.name}: ${e.message}` });
    }
    renderDrafts();
  }
  uploading = false;
  const n = draftItems.filter(a => a.error).length;
  setStatus(n ? `${n} file(s) could not be read — remove them and try another format.` :
                "Upload finished. Choose a cut length, then “Cut selected audio” or “Cut all audio”.");
  if (n) notify(`${n} file(s) could not be read. Remove them and try another format.`, "error");
  else notify("Upload finished. Choose a cut length, then cut the audio.", "success");
}

$("audioFiles").onchange = () => { addFiles($("audioFiles").files); $("audioFiles").value = ""; };
["dragenter", "dragover"].forEach(t => $("drop").addEventListener(t, e => { e.preventDefault(); $("drop").classList.add("over"); }));
["dragleave", "drop"].forEach(t => $("drop").addEventListener(t, () => $("drop").classList.remove("over")));
$("drop").addEventListener("drop", e => { e.preventDefault(); addFiles(e.dataTransfer.files); });

// ---------- step 3: cut length ----------
function showEstimate() {
  const dur = session && draftItems.some(a => a.id === session.id) ? session.duration : 0;
  $("cutEstimate").textContent = dur ? `About ${Math.ceil(dur / cutSec())} crop${Math.ceil(dur / cutSec()) === 1 ? "" : "s"} of ${cutSec()} s for “${session.name}”` : "";
}
function syncPresets() {
  document.querySelectorAll(".preset").forEach(b => b.classList.toggle("on", +b.dataset.sec === +$("chunk").value));
  showEstimate();
}
document.querySelectorAll(".preset").forEach(b => b.onclick = () => { $("chunk").value = b.dataset.sec; syncPresets(); });
$("chunk").oninput = syncPresets;
$("chunk").onchange = () => { $("chunk").value = cutSec(); syncPresets(); };   // tidy up empty / 0 / decimals
$("chunk").onkeydown = e => { if (e.key === "Enter" && !$("btnCut").disabled) $("btnCut").click(); };
syncPresets();

async function recut(it, sec) {
  const j = await api(`/api/audios/${it.id}/recut`, { chunk_seconds: sec });
  Object.assign(it, { count: j.segments.length, done: 0, todo: j.segments.length, chunk_seconds: sec });
  delete it.pick;                         // a freshly cut audio is ticked for push
  if (session && session.id === it.id) {  // the open audio: show the new cuts (Ctrl+Z brings the old ones back)
    loadToken++;                          // a load still running would bring back the old cuts
    pushUndo();
    setSegments(j.segments);
    savePending = false;                  // the server already saved them
    updateUndo(); requestDraw(); seek(0);
  }
}

$("btnCut").onclick = async () => {
  const it = draftItems.find(a => session && a.id === session.id);
  if (!it) return;
  const sec = cutSec();
  if (segs.length > 1 && !await askConfirm(`Cut “${it.name}” again into ${sec} s crops? Your current cuts are replaced (Ctrl+Z undoes it).`,
                                           { title: "Cut again", ok: "Cut" })) return;
  $("btnCut").disabled = true;
  try {
    await saveNow();
    await recut(it, sec);
    renderDrafts(); markOpenRow();
    setStatus(`Cut “${it.name}” into ${segs.length} crops of ${sec} s. Now check every cut on the waveform and fix the wrong ones.`);
    notify(`“${it.name}” cut into ${segs.length} crops.`, "success");
  } catch (e) { notify("Cut failed: " + e.message, "error"); }
  finally { updateUploadControls(); }
};

$("btnCutAll").onclick = async () => {
  const ready = draftItems.filter(a => !a.uploading && !a.error), sec = cutSec();
  const edited = ready.filter(a => a.count > 1).length;
  if (!await askConfirm(`Cut all ${ready.length} audio into ${sec} s crops?` +
                        (edited ? `\n\n${edited} of them are already cut — their cuts will be replaced.` : ""),
                        { title: "Cut all audio", ok: "Cut all" })) return;
  $("btnCutAll").disabled = $("btnCut").disabled = true;
  try {
    await saveNow();
    for (const [k, it] of ready.entries()) {
      setStatus(`Cutting ${k + 1} / ${ready.length}: ${it.name}…`);
      await recut(it, sec);
    }
    renderDrafts(); markOpenRow();
    setStatus(`Cut ${ready.length} audio into ${sec} s crops. Click each audio to check and fix its cuts.`);
    notify(`${ready.length} audio cut into ${sec} s crops.`, "success");
  } catch (e) { notify("Cut failed: " + e.message, "error"); }
  finally { updateUploadControls(); }
};

// ---------- step 4: push the ticked audio to a new task ----------
function pickAll(rule) {
  draftItems.forEach(a => { a.pick = rule(a); });
  renderDrafts();
}
$("pickAll").onclick = () => pickAll(() => true);
$("pickCut").onclick = () => pickAll(isCut);
$("pickNone").onclick = () => pickAll(() => false);

$("btnPush").onclick = async () => {
  const picked = draftItems.filter(isPicked);
  if (!picked.length) return notify("Tick the audio you want to push.", "warn");
  if (uploading) return notify("Wait until all files are uploaded.", "warn");
  const uncut = picked.filter(a => !isCut(a));
  if (uncut.length && !await askConfirm(`${uncut.length} ticked audio are not cut yet (each is one long crop):\n` +
      uncut.slice(0, 5).map(a => "• " + a.name).join("\n") + (uncut.length > 5 ? "\n…" : "") + "\n\nPush anyway?",
      { title: "Push to task", ok: "Push anyway" })) return;
  $("btnPush").disabled = true;
  try {
    await saveNow();
    const name = $("taskName").value.trim() || $("taskName").placeholder;
    const task = await api("/api/tasks", { name, audio_ids: picked.map(a => a.id) });
    $("taskName").value = "";
    draftItems = draftItems.filter(a => !picked.includes(a));
    picked.forEach(a => thumbs.delete(a.id));
    notify(`Pushed ${picked.length} audio to “${task.name}”.`, "success");
    if (!draftItems.some(a => !a.uploading && !a.error)) { location.hash = `#/task/${task.id}`; return; }
    if (session && picked.some(a => a.id === session.id)) closeAudio();   // the open audio went to the task
    renderDrafts();
    if (!session) await openDraft(draftItems.find(a => !a.uploading && !a.error));
    setStatus(`Pushed ${picked.length} audio to “${task.name}”. The other ${draftItems.length} audio stay here.`);
    $("pushInfo").innerHTML = `${icon("check")}Pushed to <a href="#/task/${esc(task.id)}">${esc(task.name)}</a> · ` + esc($("pushInfo").textContent);
  } catch (e) { notify("Push failed: " + e.message, "error"); }
  finally { updateUploadControls(); }
};
