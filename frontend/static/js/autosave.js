// Every change in the cut editor is saved: PUT /api/audios/<id>/state, or session.onSave (package page).
// ---------- autosave (every change is kept on the server, per audio) ----------
let saveTimer = null, savePending = false;
// Header save status. kind: "ok" (check icon), "err" / true (warning icon), or nothing
function setSave(t, kind) {
  const err = kind === "err" || kind === true;
  $("saveState").innerHTML = t ? (kind === "ok" ? icon("check") : err ? icon("alert") : "") + esc(t) : "";
  $("saveState").classList.toggle("err", err);
}
function dirty() {
  if (!session) return;
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
  setSave("Unsaved changes…");
  refreshOpenRow();
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!session || !savePending) return;
  savePending = false;
  const segments = JSON.parse(JSON.stringify(segs, (k, v) => k.startsWith("_") ? undefined : v))
    .map(s => ({ ...s, state: s.state === "running" ? "pending" : s.state }));
  setSave("Saving…");
  try {
    if (session.onSave) await session.onSave(segments);
    else await api(`/api/audios/${session.id}/state`, { segments }, "PUT");
    if (!savePending) setSave("All changes saved", "ok");
  }
  catch (e) {
    if (!savePending) notify("Not saved: " + e.message + ". It will be tried again with your next change.", "error");
    savePending = true; setSave("Not saved: " + e.message, "err");
  }
}
