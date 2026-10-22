// My Tasks: one card per task, search, pagination, delete.
let tasks = [], taskPage = 1;
const PER_PAGE = 8;

// ---------- My Tasks ----------
async function loadTasks() {
  await flushCropSaves();                  // so the last edits on a task page are counted
  $("taskEmpty").textContent = "";
  try { tasks = (await fetchJson("/api/tasks")).tasks; } catch (e) { tasks = []; $("taskEmpty").textContent = "Cannot load tasks: " + e.message; }
  renderTasks();
}

function renderTasks() {
  const q = $("taskSearch").value.trim().toLowerCase();
  const list = tasks.filter(t => !q || t.name.toLowerCase().includes(q) || t.id.includes(q));
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  taskPage = Math.min(taskPage, pages);
  const shown = list.slice((taskPage - 1) * PER_PAGE, taskPage * PER_PAGE);
  $("taskTotal").textContent = `Total: ${list.length} items`;
  $("taskCards").innerHTML = shown.map(t => {
    const pct = t.done + t.todo ? Math.round(100 * t.done / (t.done + t.todo)) : 0;
    return `<div class="task-card" tabindex="0" data-id="${esc(t.id)}">
      <div class="tc-tags"><span class="tag">Batch</span><span class="tag">AUDIO</span><span class="tag">Khmer ASR</span>
        <button class="tc-del" title="Delete this task" aria-label="Delete this task">${icon("trash")}</button></div>
      <div class="tc-body">
        <h3>${esc(t.name)}</h3>
        <div>Description:</div>
        <div class="tc-desc">${t.audio_count} audio · ${fmtDur(t.duration)} · ${t.count} crops</div>
        <div class="tc-counts"><span>Todo: ${t.todo}</span><span>Already done: ${t.done}</span></div>
        <div class="bar"><div style="width:${pct}%"></div></div>
        <div class="tc-meta">Generated On: ${esc(t.created)}</div>
        <div class="tc-meta">Last saved: ${esc(t.updated)}</div>
      </div></div>`;
  }).join("");
  $("taskEmpty").hidden = list.length > 0;
  if (!list.length && !$("taskEmpty").textContent.startsWith("Cannot"))
    $("taskEmpty").textContent = q ? "No task matches your search." : "No tasks yet — upload and cut audio in “Upload & Crop”, then push it to a task.";
  $("pager").innerHTML = list.length ? `<span>Total ${list.length} items, Current ${(taskPage - 1) * PER_PAGE + 1}-${(taskPage - 1) * PER_PAGE + shown.length}</span>
    <button data-p="${taskPage - 1}" ${taskPage === 1 ? "disabled" : ""} aria-label="Previous page">${icon("chevron-left")}</button>` +
    Array.from({ length: pages }, (_, i) => `<button data-p="${i + 1}" class="${i + 1 === taskPage ? "on" : ""}">${i + 1}</button>`).join("") +
    `<button data-p="${taskPage + 1}" ${taskPage === pages ? "disabled" : ""} aria-label="Next page">${icon("chevron-right")}</button><span>${PER_PAGE} / page</span>` : "";
}

$("taskCards").addEventListener("click", async e => {
  const card = e.target.closest(".task-card");
  if (!card) return;
  const id = card.dataset.id, t = tasks.find(x => x.id === id);
  if (e.target.closest(".tc-del")) {
    if (!await askConfirm(`Delete task “${t.name}”? Its ${t.audio_count} audio and all segments/text will be removed. This cannot be undone.`,
                          { title: "Delete task", ok: "Delete", danger: true })) return;
    try { await fetchJson(`/api/tasks/${id}`, { method: "DELETE" }); } catch (err) { return notify("Delete failed: " + err.message, "error"); }
    notify(`Task “${t.name}” deleted.`, "success");
    if (curTask && curTask.id === id) curTask = null;
    tasks = tasks.filter(x => x.id !== id);
    return renderTasks();
  }
  location.hash = `#/task/${id}`;
});
$("taskCards").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.classList.contains("task-card")) e.target.click(); });
$("pager").addEventListener("click", e => { const b = e.target.closest("button[data-p]"); if (b && !b.disabled) { taskPage = +b.dataset.p; renderTasks(); } });
$("taskSearch").oninput = () => { taskPage = 1; renderTasks(); };
$("btnSearch").onclick = () => { taskPage = 1; renderTasks(); };
$("btnNewTask").onclick = () => { location.hash = "#/upload"; $("audioFiles").click(); };
