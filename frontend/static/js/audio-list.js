// Upload & Crop audio list: one row per file with a "push" checkbox, a waveform thumbnail and its cut state.
const THUMB_BUCKETS = 220;
const thumbs = new Map();    // audio id -> Int8Array of min/max pairs

const isCut = it => it.count > 1 || !!it.chunk_seconds;
// ticked for push: what the user chose, otherwise "is it cut yet"
const isPicked = it => !it.uploading && !it.error && (it.pick ?? isCut(it));

// items: [{id, name, duration, count, chunk_seconds, pick?, uploading?, progress?, error?}]
// opts: {onOpen(item), onDelete(item), onPick(item)}
function renderAudioList(box, items, opts) {
  box.innerHTML = "";
  items.forEach(it => box.appendChild(audioRow(it, opts)));
}

function audioRow(it, opts) {
  const ready = !it.uploading && !it.error;
  const row = document.createElement("div");
  row.className = "audio-row" + (it.uploading ? " uploading" : "") + (it.error ? " failed" : "") +
                  (session && session.id === it.id ? " on" : "");
  row.dataset.id = it.id || "";
  row.tabIndex = ready ? 0 : -1;
  row.innerHTML = `<input type="checkbox" class="ar-pick" title="Push this audio to the task" aria-label="Push this audio" ${ready ? "" : "disabled"}>
    <canvas class="ar-thumb" width="220" height="44"></canvas>
    <div class="ar-main"><div class="ar-name"></div><div class="ar-info"></div></div>
    ${it.uploading ? "" : `<button class="ar-del" title="Remove this audio" aria-label="Remove this audio">${icon("trash")}</button>`}`;
  row.querySelector(".ar-name").textContent = it.name;
  row.querySelector(".ar-name").title = it.name;
  const pick = row.querySelector(".ar-pick");
  pick.checked = isPicked(it);
  pick.onclick = e => { e.stopPropagation(); it.pick = pick.checked; opts.onPick(it); };
  fillRowInfo(row, it);
  if (ready) {
    row.onclick = e => { if (!e.target.closest(".ar-del, .ar-pick")) opts.onOpen(it); };
    row.onkeydown = e => { if (e.key === "Enter" && e.target === row) opts.onOpen(it); };
    drawThumb(row.querySelector("canvas"), it.id);
  }
  const del = row.querySelector(".ar-del");
  if (del) del.onclick = () => opts.onDelete(it);
  return row;
}

function fillRowInfo(row, it) {
  const info = row.querySelector(".ar-info");
  if (it.uploading) {
    info.innerHTML = `<span>Uploading… ${Math.round((it.progress || 0) * 100)}%</span>
      <span class="bar"><div style="width:${(it.progress || 0) * 100}%"></div></span>`;
  } else if (it.error) {
    info.innerHTML = `<span class="errmsg">${esc(it.error)}</span>`;
  } else {
    info.innerHTML = `<span class="pill dur">${icon("clock")}${fmtDur(it.duration)}</span>
      <span class="pill ${isCut(it) ? "ok" : "warn"}">${isCut(it) ? `${icon("scissors")}${it.count} crops` : "Not cut yet"}</span>`;
    row.querySelector(".ar-pick").checked = isPicked(it);
  }
}

async function drawThumb(cv, id) {
  if (!thumbs.has(id)) {
    try {
      const p = await fetchJson(`/api/audios/${id}/peaks?buckets=${THUMB_BUCKETS}`);
      const bin = atob(p.peaks), a = new Int8Array(bin.length);
      for (let k = 0; k < bin.length; k++) a[k] = bin.charCodeAt(k);
      thumbs.set(id, a);
    } catch (e) { return; }
  }
  const a = thumbs.get(id), g = cv.getContext("2d"), w = cv.width, h = cv.height, n = a.length / 2;
  let max = 1;
  for (let k = 0; k < a.length; k++) max = Math.max(max, Math.abs(a[k]));
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#5f8a6a";
  for (let x = 0; x < w; x++) {
    const b = Math.floor(x / w * n), lo = a[2 * b], hi = a[2 * b + 1];
    const y1 = h / 2 - hi / max * (h / 2 - 2), y2 = h / 2 - lo / max * (h / 2 - 2);
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

// Keep the open audio's row in step with the cut editor while cutting
function refreshOpenRow() {
  if (!session) return;
  const it = draftItems.find(x => x.id === session.id);
  if (!it) return;
  it.count = segs.filter(s => !s.deleted).length;
  const row = $("draftList").querySelector(`.audio-row[data-id="${session.id}"]`);
  if (row) fillRowInfo(row, it);
  updateUploadControls();
}

function markOpenRow() {
  document.querySelectorAll(".audio-row").forEach(r => r.classList.toggle("on", !!session && r.dataset.id === session.id));
}
