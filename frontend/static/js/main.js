// Keyboard shortcuts and start-up. Loaded last.
// ---------- keyboard ----------
document.addEventListener("keydown", e => {
  if (!session || $("editorArea").hidden || !$("editorArea").offsetParent) return;   // editor not on screen
  if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); return togglePlay(); }   // works while typing
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { if (e.key === "Escape") e.target.blur(); return; }
  const k = e.key.toLowerCase();
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (k === "s" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); cutHere(); }
  else if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); toggleDelete(sel); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); seek(pos + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1)); follow(); }
  else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.ctrlKey) { e.preventDefault(); stepSeg(e.key === "ArrowUp" ? -1 : 1); }
  else if ((e.ctrlKey || e.metaKey) && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
});

// Warn before closing the tab while the last changes are not saved yet
window.addEventListener("beforeunload", e => {
  if (savePending || cropUnsaved.size) { saveNow().then(flushCropSaves); e.preventDefault(); e.returnValue = ""; }
});

route();
