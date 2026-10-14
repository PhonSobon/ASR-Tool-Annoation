// The audio open in the cut editor (Upload & Crop): load it (waveform + segments + player), close it.
let loadToken = 0;           // ignore a slow load when another audio was clicked meanwhile

async function loadAudio(id) {
  const token = ++loadToken;
  hooks.structure = hooks.select = () => {};
  await saveNow();                       // don't lose the audio that was open before
  const [j, p] = await Promise.all([fetchJson(`/api/audios/${id}`), fetchJson(`/api/audios/${id}/peaks`)]);
  if (token !== loadToken) return false;

  const bin = atob(p.peaks);
  peaks = new Int8Array(bin.length);
  for (let k = 0; k < bin.length; k++) peaks[k] = bin.charCodeAt(k);   // wraps 128..255 to negative
  peakRate = p.rate;
  peakMax = Math.max(1, ...Array.from({ length: 64 }, (_, k) => {    // loudness from a sampled max (fast on long audio)
    let m = 0; for (let b = k; b < peaks.length; b += 64) m = Math.max(m, Math.abs(peaks[b])); return m; }));

  session = { id: j.id, name: j.name, duration: j.duration, created: j.created, task_id: j.task_id };
  setSegments(j.segments);
  pos = 0; playEnd = null; hover = null; dragRange = null;
  undoStack.length = redoStack.length = 0;
  player.pause();
  player.src = `/api/audios/${j.id}/audio`;
  $("edName").textContent = j.name;
  $("edDur").innerHTML = icon("clock") + fmtDur(j.duration);
  $("edInfo").textContent = j.created ? "Uploaded " + j.created : "";
  $("editorArea").hidden = false;
  $("zoom").value = 0;
  setStatus("Fix the cuts: drag across the waveform to crop, drag a dark line to move a cut, double-click a line to merge, S to cut at the playhead.");
  updateUndo(); showClock();
  requestAnimationFrame(() => applyZoom(0));
  return true;
}

// Replace all segments (open, or a new cut length) and select the first one
function setSegments(list) {
  nextId = Math.max(0, ...list.map(s => s.id || 0)) + 1;   // saved segments keep their ids, new ones count on
  segs = list.map(s => newSeg({ ...s, state: s.state === "running" ? "pending" : (s.state || "pending") }));
  sel = segs[0] || null;
}

function closeAudio() {
  loadToken++;
  session = null; segs = []; sel = null; peaks = null; savePending = false;
  player.pause(); player.removeAttribute("src");
  $("editorArea").hidden = true;
  setSave("");
}
