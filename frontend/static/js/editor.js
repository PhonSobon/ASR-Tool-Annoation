// Cut editing on Upload & Crop: selection, cut / crop / merge / delete, undo / redo.
// ---------- selection ----------
function select(s, { seek: doSeek = false } = {}) {
  if (!s) return;
  sel = s;
  hooks.select(s);
  if (doSeek && !(pos >= s.start && pos < s.end)) seek(s.start);
  const a = X(s.start), b = X(s.end), w = viewW();   // bring the segment into view on the timeline
  if (b < 0 || a > w) $("hbar").scrollLeft = s.start * pps - w * 0.1;
  requestDraw();
}

function stepSeg(d) {
  if (!segs.length) return;
  const k = Math.min(segs.length - 1, Math.max(0, (sel ? segs.indexOf(sel) : -1) + d));
  select(segs[k]);
  seek(segs[k].start);
}
$("btnPrev").onclick = () => stepSeg(-1);
$("btnNext").onclick = () => stepSeg(1);

// ---------- cut / merge / delete (all undoable) ----------
function splitAt(a, t) {   // a -> a + b at time t; returns b
  t = r3(t);
  const b = newSeg({ start: t, end: a.end, role: a.role, deleted: a.deleted });
  if (untouched(a)) {      // split the recognized text by word timings
    b.words = a.words.filter(w => (w.start + w.end) / 2 >= t);
    a.words = a.words.filter(w => (w.start + w.end) / 2 < t);
    [a, b].forEach(s => { s.text = s.wordsText = wordsToText(s.words); s.state = "done"; s.normEdited = false; });
  } else if (a.text) {
    a.words = null;
    setStatus(`The text stays in segment ${segs.indexOf(a) + 1} (it was edited or has no word timings) — fix it on the task page.`);
  }
  a.end = t;
  segs.splice(segs.indexOf(a) + 1, 0, b);
  [a, b].forEach(staleNorm);
  return b;
}

function cutHere() {
  if (!sel) return setStatus("Select a segment first (click it on the waveform), then cut.");
  if (pos <= sel.start + 0.1 || pos >= sel.end - 0.1)
    return setStatus(`Move the playhead inside segment ${segs.indexOf(sel) + 1} (${fmtT(sel.start)} – ${fmtT(sel.end)}) to cut it.`);
  pushUndo();
  splitAt(sel, pos);
  afterStructure();
}

function merge(k) {   // join segs[k] into segs[k-1]
  pushUndo();
  joinSegs(k);
  afterStructure();
  setStatus(`Merged segments ${k} and ${k + 1}.`);
}

// Crop [t0, t1] out of the timeline: cut at both ends, and join whatever lies between into one segment
function cropRange(t0, t1) {
  t0 = r3(t0); t1 = r3(t1);
  if (t1 - t0 < 0.1) return setStatus("Drag a longer range (at least 0.1 s) to crop.");
  pushUndo();
  [t0, t1].forEach(t => {
    const s = segAt(t);
    if (t > s.start + 0.05 && t < s.end - 0.05) splitAt(s, t);
  });
  const inside = () => segs.findIndex((s, k) => k && s.start >= t0 - 0.05 && s.end <= t1 + 0.05 &&
                                               segs[k - 1].start >= t0 - 0.05);
  for (let k = inside(); k > 0; k = inside()) joinSegs(k);
  const c = segAt((t0 + t1) / 2);
  c.deleted = false;
  sel = c;
  afterStructure();
  select(c);
  seek(c.start);
  setStatus(`Cropped ${fmtT(c.start)} – ${fmtT(c.end)} into segment ${segs.indexOf(c) + 1}. Space to listen, Del to leave it out.`);
}

function joinSegs(k) {
  const a = segs[k - 1], b = segs[k];
  if (untouched(a) && untouched(b)) {
    a.words = [...a.words, ...b.words.map((w, j) => j ? w : { ...w, sp: true })];
    a.text = a.wordsText = wordsToText(a.words);
  } else {
    a.text = [a.text, b.text].filter(Boolean).join(" ");
    a.words = null;
  }
  if (a.normEdited || b.normEdited) { a.norm = [a.norm, b.norm].filter(Boolean).join(" "); a.normEdited = true; }
  else staleNorm(a);
  a.state = a.text ? "done" : "pending";
  a.error = "";
  a.deleted = a.deleted && b.deleted;
  a.end = b.end;
  segs.splice(k, 1);
  if (sel === b) sel = a;
}

function toggleDelete(s) {
  pushUndo();
  s.deleted = !s.deleted;
  afterStructure();
  const n = segs.filter(x => x.deleted).length;
  setStatus(`Segment ${segs.indexOf(s) + 1} ${s.deleted ? "deleted" : "restored"}.` + (n ? ` ${n} deleted segment(s) will be left out of the export.` : ""));
}

// Text moved by a cut: drop the auto-normalized text; the task page makes it again from the annotation text
function staleNorm(s) { if (!s.normEdited) s.norm = ""; }

function afterStructure() { dirty(); updateUndo(); requestDraw(); hooks.structure(); }

$("btnCutHere").onclick = cutHere;

// ---------- undo / redo (cuts, merges, boundary moves, deletes) ----------
const snap = () => JSON.stringify({ segs, sel: sel && sel.id }, (k, v) => k.startsWith("_") ? undefined : v);
function restore(str) {
  const o = JSON.parse(str);
  segs = o.segs.map(s => ({ ...s, state: s.state === "running" ? "pending" : s.state }));
  sel = segs.find(s => s.id === o.sel) || null;
}
function pushUndo(state = snap()) { undoStack.push(state); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0; updateUndo(); }
function undo() { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); afterStructure(); }
function redo() { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); afterStructure(); }
function updateUndo() { $("btnUndo").disabled = !undoStack.length; $("btnRedo").disabled = !redoStack.length; }
$("btnUndo").onclick = undo;
$("btnRedo").onclick = redo;
