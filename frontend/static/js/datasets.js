// Dataset Cleaning page: import a Hugging Face dataset (Load -> pick config / split / columns -> Import), whole or in
// batches of rows (a big split is cleaned e.g. 200 rows at a time, every batch pushed to the same repo), and the
// cards of imported datasets (search, filter, pages; progress while importing; delete). One is reviewed in review.js.
let hubInfo = null;          // POST /api/hub/inspect
let dsCards = [];
let dsListTimer = null, dsCardPage = 1;
const DS_PER_PAGE = 12;

const CAT_LABEL = { pass: "Passed", review: "Needs review", bad: "Likely bad", unchecked: "Not checked" };

async function loadDatasets() {
  clearTimeout(dsListTimer);
  try { dsCards = (await fetchJson("/api/datasets")).datasets; }
  catch (e) { dsCards = []; notify("Cannot load datasets: " + e.message, "error"); }
  renderDatasets();
  if (dsCards.some(d => d.job && d.job.running) && !$("pageDatasets").hidden) dsListTimer = setTimeout(loadDatasets, 1500);
}

function shownDatasets() {
  const q = $("dsSearch").value.trim().toLowerCase(), show = $("dsShow").value;
  return dsCards.filter(d => {
    const b = d.batch, row = /^\d+$/.test(q) ? +q : null;
    if (q && !(row != null && b ? row >= b.start && (b.end == null || row <= b.end)
               : `${d.name} ${d.repo}`.toLowerCase().includes(q))) return false;
    if (show === "todo") return d.status_counts.todo > 0;
    if (show === "unpushed") return d.status_counts.todo === 0 && !d.last_push;
    if (show === "pushed") return !!d.last_push;
    return true;
  });
}

function renderDatasets() {
  const list = shownDatasets(), pages = Math.max(1, Math.ceil(list.length / DS_PER_PAGE));
  dsCardPage = Math.min(dsCardPage, pages);
  const shown = list.slice((dsCardPage - 1) * DS_PER_PAGE, dsCardPage * DS_PER_PAGE);
  const pushed = dsCards.filter(d => d.last_push).length;
  $("dsTotal").textContent = dsCards.length ? `Total: ${dsCards.length}` + (pushed ? ` · pushed ${pushed}` : "") : "";
  $("dsEmpty").hidden = dsCards.length > 0;
  $("dsCardPager").innerHTML = pages > 1 ? `<button data-p="${dsCardPage - 1}" ${dsCardPage === 1 ? "disabled" : ""} aria-label="Previous page">${icon("chevron-left")}</button>
    <span>Page <input id="dsCardPageNo" type="number" min="1" max="${pages}" value="${dsCardPage}" class="num"> / ${pages}</span>
    <button data-p="${dsCardPage + 1}" ${dsCardPage === pages ? "disabled" : ""} aria-label="Next page">${icon("chevron-right")}</button>
    <span>${list.length} shown</span>` : "";
  if ($("dsCardPageNo")) $("dsCardPageNo").onchange = e => { dsCardPage = Math.max(1, Math.min(pages, +e.target.value || 1)); renderDatasets(); };
  $("dsCards").innerHTML = shown.map(d => {
    const job = d.job && d.job.running ? d.job : null, sc = d.status_counts, cc = d.category_counts, n = d.count || 1;
    const reviewed = sc.accepted + sc.rejected;
    const catBar = ["pass", "review", "bad", "unchecked"].map(c => `<div class="c-${c}" style="width:${100 * cc[c] / n}%" title="${CAT_LABEL[c]}: ${cc[c]}"></div>`).join("");
    return `<div class="task-card ds-card" tabindex="0" data-id="${esc(d.id)}">
      <div class="tc-tags"><span class="tag hub">Hugging Face</span><span class="tag">${esc(d.split)}</span>
        ${d.batch ? `<span class="tag rows">${esc(d.batch.name)}</span>` : ""}
        <button class="tc-del" title="Delete this dataset" aria-label="Delete this dataset">${icon("trash")}</button></div>
      <div class="tc-body">
        <h3>${esc(d.name)}</h3>
        <div class="tc-desc">${esc(d.repo)}${d.config !== "default" ? ` · ${esc(d.config)}` : ""}<br>
          ${d.count} clips · ${fmtDur(d.duration)}${d.failed ? ` · ${d.failed} unreadable` : ""}</div>
        ${job ? `<div class="tc-counts"><span>${icon("loader", "spin")} ${esc(job.message)}</span></div>
                 <div class="bar"><div style="width:${job.total ? 100 * job.done / job.total : 0}%;background:var(--primary)"></div></div>`
              : `<div class="tc-counts"><span>Accepted: ${sc.accepted}</span><span>Rejected: ${sc.rejected}</span><span>To review: ${sc.todo}</span></div>
                 <div class="bar"><div style="width:${100 * reviewed / n}%"></div></div>
                 <div class="tc-meta">Checked by ASR: ${d.checked} / ${d.count}</div>
                 <div class="bar cat" title="Check results">${catBar}</div>`}
        <div class="tc-meta">Imported: ${esc(d.created)}</div>
        ${d.last_push ? `<div class="tc-meta">Pushed: <a href="${esc(d.last_push.url)}" target="_blank" rel="noopener">${esc(d.last_push.repo)}</a> · ${esc(d.last_push.at)}</div>` : ""}
      </div></div>`;
  }).join("");
}

$("dsCards").addEventListener("click", async e => {
  const card = e.target.closest(".ds-card");
  if (!card || e.target.closest("a")) return;
  const d = dsCards.find(x => x.id === card.dataset.id);
  if (e.target.closest(".tc-del")) {
    if (!await askConfirm(`Delete “${d.name}”? Its ${d.count} clips and every review decision are removed from this computer (nothing changes on Hugging Face).`,
                          { title: "Delete dataset", ok: "Delete", danger: true })) return;
    try { await fetchJson(`/api/datasets/${d.id}`, { method: "DELETE" }); } catch (err) { return notify("Delete failed: " + err.message, "error"); }
    notify(`“${d.name}” deleted.`, "success");
    return loadDatasets();
  }
  location.hash = `#/dataset/${d.id}`;
});
$("dsCardPager").addEventListener("click", e => { const b = e.target.closest("button[data-p]"); if (b && !b.disabled) { dsCardPage = +b.dataset.p; renderDatasets(); } });
$("dsSearch").oninput = $("dsShow").onchange = () => { dsCardPage = 1; renderDatasets(); };
$("dsCards").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.classList.contains("ds-card")) e.target.click(); });

// ---------- import ----------
$("btnInspect").onclick = async () => {
  $("impErr").textContent = "";
  $("impForm").hidden = true;
  const b = $("btnInspect"), label = b.innerHTML;
  b.disabled = true; b.innerHTML = icon("loader", "spin") + " Loading…";
  try {
    hubInfo = await api("/api/hub/inspect", { repo: $("hfRepo").value, token: $("hfToken").value });
    fillImportForm();
  } catch (e) { $("impErr").textContent = e.message; }
  finally { b.disabled = false; b.innerHTML = label; }
};
$("hfRepo").addEventListener("keydown", e => { if (e.key === "Enter") $("btnInspect").click(); });

const curConfig = () => hubInfo.configs.find(c => c.name === $("impConfig").value) || hubInfo.configs[0];
const curSplit = () => curConfig().splits.find(s => s.name === $("impSplit").value) || curConfig().splits[0];

function fillImportForm() {
  $("impConfig").innerHTML = hubInfo.configs.map(c => `<option>${esc(c.name)}</option>`).join("");
  fillConfig();
  $("impForm").hidden = false;
}

function fillConfig() {
  const c = curConfig(), opts = cols => cols.map(x => `<option value="${esc(x.name)}">${esc(x.name)} (${esc(x.type)})</option>`).join("");
  $("impSplit").innerHTML = c.splits.map(s => `<option value="${esc(s.name)}">${esc(s.name)}${s.rows != null ? ` — ${s.rows.toLocaleString()} rows` : ""}</option>`).join("");
  const audioCols = c.columns.filter(x => x.type === "audio"), textCols = c.columns.filter(x => /string/.test(x.type));
  $("impAudio").innerHTML = opts(audioCols.length ? audioCols : c.columns);
  $("impText").innerHTML = opts(textCols.length ? textCols : c.columns);
  // the usual names for the transcript, the normalized one first
  const pick = ["transcription", "sentence", "text", "transcript", "normalized_text", "raw_transcription"].find(n => textCols.some(x => x.name === n));
  if (pick) $("impText").value = pick;
  fillSplit();
}

function fillSplit() {
  const s = curSplit(), big = s.rows == null || s.rows > 2000;
  $("impName").value = `${hubInfo.repo.split("/")[1]} (${s.name})`;
  $("impStart").value = s.next_row || 0;
  $("impMax").value = big || s.next_row ? 200 : "";        // a big split goes in batches
  $("impBatches").value = 1;
  updateImpInfo();
}

function updateImpInfo() {
  const s = curSplit(), start = +$("impStart").value || 0, per = +$("impMax").value || 0, n = per ? Math.max(1, +$("impBatches").value || 1) : 1;
  const end = per ? start + per * n - 1 : null, last = s.rows != null && end != null ? Math.min(end, s.rows - 1) : end;
  $("impInfo").textContent = [`${hubInfo.repo}`, s.rows != null ? `${s.rows.toLocaleString()} rows` : "",
    s.next_row ? `rows 0–${(s.next_row - 1).toLocaleString()} already imported` : "",
    per ? `this import: rows ${start.toLocaleString()}–${last != null ? last.toLocaleString() : "end"} in ${n} batch${n > 1 ? "es" : ""} of ${per}`
        : s.bytes ? `the whole split (${fmtSize(s.bytes)} to download)` : "the whole split",
    hubInfo.partial ? "only part of this dataset is available as parquet" : ""].filter(Boolean).join(" · ");
}
$("impConfig").onchange = fillConfig;
$("impSplit").onchange = fillSplit;
["impStart", "impMax", "impBatches"].forEach(id => $(id).oninput = updateImpInfo);

$("btnImport").onclick = async () => {
  const c = curConfig(), s = curSplit();
  $("btnImport").disabled = true;
  try {
    const r = await api("/api/datasets", {
      repo: hubInfo.repo, config: c.name, split: s.name, rows: s.rows, columns: c.columns, token: $("hfToken").value,
      audio_column: $("impAudio").value, text_column: $("impText").value, name: $("impName").value,
      start_row: $("impStart").value, max_rows: $("impMax").value, batches: $("impMax").value ? $("impBatches").value : 1,
      check: $("impCheck").checked });
    const n = r.datasets.length;
    notify((n > 1 ? `Importing ${n} batches of “${$("impName").value}”` : `Importing “${r.datasets[0].name}”`) +
           " — the clips are downloaded and converted to 16 kHz in the background" + ($("impCheck").checked ? ", then checked by the ASR." : "."), "info");
    s.next_row = Math.max(s.next_row || 0, ...r.datasets.filter(d => d.batch && d.batch.end != null).map(d => d.batch.end + 1));
    if ($("impMax").value) { $("impStart").value = s.next_row; updateImpInfo(); }   // ready for the next batches
    else $("impForm").hidden = true;
    dsCardPage = 1;
    await loadDatasets();
  } catch (e) { notify("Import failed: " + e.message, "error"); }
  finally { $("btnImport").disabled = false; }
};
