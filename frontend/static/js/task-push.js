// Task page: push the annotated segments of the task to a Hugging Face dataset repo (POST /api/tasks/<id>/hub-push,
// a background job on the server; its progress is polled here). One clip per segment, like the task ZIP.
// The button shows once every package is completed (or skipped). A private repo needs an access token.
let tpTimer = null, tpWasRunning = false, tpRunning = false;

function tpUpdateButton() {
  const ready = crops.length && !crops.some(c => inTab(c, "todo")) && crops.some(c => cropState(c) === "done");
  $("btnTaskPush").hidden = !ready && !tpRunning;
  $("btnTaskPush").disabled = tpRunning;
}

// segments that go up: [count, seconds] (completed packages)
function tpCount() {
  const segs = crops.filter(c => cropState(c) === "done").flatMap(c => liveParts(c.seg).filter(p => (p.text || "").trim()));
  return [segs.length, segs.reduce((a, p) => a + p.end - p.start, 0)];
}

const tpPr = () => document.querySelector("input[name=tpMode]:checked").value === "pr";
const tpNeedsToken = () => !tpPr() && $("tpPrivate").checked;

function tpUpdateInfo() {
  const [n, sec] = tpCount(), pr = tpPr();
  $("tpPrivate").disabled = pr;
  $("tpTokenLabel").classList.toggle("req", tpNeedsToken());
  $("tpToken").placeholder = tpNeedsToken() ? "Required for a private repo (hf_…)" : "Empty = your saved hf login";
  $("tpInfo").textContent = `${n} segments (${fmtHms(sec)}) of the completed packages are uploaded as parquet to data/${$("tpSplit").value || "train"}-task-${curTask.id}-*.parquet ` +
    `with audio, text, text_normalized, role, speaker and audio information.` +
    (pr ? " A pull request is opened — the owner of the repo decides whether to merge it."
        : " Only this task's earlier files are replaced: other tasks pushed to the same repo stay, and the dataset card's batch table gets a row for this task.");
  $("tpOk").disabled = !n;
}

$("btnTaskPush").onclick = async () => {
  if (!curTask) return;
  await saveNow();
  await flushCropSaves();
  // this task's last push, else the latest push of another task (tasks usually all go to one repo)
  const last = curTask.last_push || tasks.map(t => t.last_push).filter(p => p && !p.pr).sort((a, b) => a.at < b.at ? 1 : -1)[0];
  $("tpRepo").value = last && !last.pr ? last.repo : "";
  $("tpSplit").value = last ? last.split : "train";
  document.querySelector("input[name=tpMode][value=own]").checked = true;
  tpUpdateInfo();
  $("tpDialog").showModal();
  if (!$("tpRepo").value) {
    const r = await api("/api/hub/whoami", { token: $("tpToken").value }).catch(() => ({}));
    const repo = curTask.name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "khmer_asr_dataset";
    if (r.name && !$("tpRepo").value) $("tpRepo").value = `${r.name}/${repo}`;
    else if (!r.name) $("tpInfo").textContent += "\nNot logged in: enter a write token from huggingface.co/settings/tokens (or run `hf auth login`).";
  }
};
document.querySelectorAll("input[name=tpMode]").forEach(r => r.onchange = tpUpdateInfo);
$("tpPrivate").onchange = tpUpdateInfo;
$("tpSplit").oninput = tpUpdateInfo;
$("tpCancel").onclick = () => $("tpDialog").close();
$("tpOk").onclick = async () => {
  if (tpNeedsToken() && !$("tpToken").value.trim()) {
    $("tpInfo").textContent = "⚠ A private repo needs your Hugging Face access token with write access (huggingface.co/settings/tokens).";
    return $("tpToken").focus();
  }
  try {
    await api(`/api/tasks/${curTask.id}/hub-push`, { repo_id: $("tpRepo").value, split: $("tpSplit").value,
      include: "done", private: $("tpPrivate").checked, create_pr: tpPr(), token: $("tpToken").value });
    $("tpDialog").close();
    tpWasRunning = true;
    tpPoll();
  } catch (e) { $("tpInfo").textContent = "⚠ " + e.message; }
};
$("tpJobStop").onclick = () => api(`/api/tasks/${curTask.id}/stop`, {}).catch(e => notify(e.message, "error"));

// progress of the push (also picked up when the task is opened while a push runs)
async function tpPoll() {
  clearTimeout(tpTimer);
  if (!curTask || $("pageTask").hidden) return;
  const id = curTask.id;
  let job = null;
  try { job = (await fetchJson(`/api/tasks/${id}/job`)).job; } catch (e) {}
  if (!curTask || curTask.id !== id) return;
  const box = $("tpJob"), running = !!(job && job.running);
  if (!job || (!running && !tpWasRunning && box.hidden)) box.hidden = true;
  else {
    box.hidden = false;
    box.classList.toggle("err", !!job.error);
    const url = job.result && job.result.url;
    $("tpJobText").innerHTML = (running ? icon("loader", "spin") : job.error ? icon("alert") : icon("check")) + " " +
      esc(url ? job.message.replace(url, "") : job.message) + (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : "");
    $("tpJobBar").style.width = `${job.total ? 100 * job.done / job.total : 0}%`;
    $("tpJobBar").parentElement.hidden = !running;
    $("tpJobStop").hidden = !running;
  }
  if (!running && tpWasRunning && job) {
    if (job.error) notify("Push failed: " + job.error, "error");
    else { notify(job.message, "success", 0); curTask.last_push = { ...(curTask.last_push || {}), repo: $("tpRepo").value, split: $("tpSplit").value,
                                                                     pr: document.querySelector("input[name=tpMode]:checked").value === "pr" }; }
  }
  tpWasRunning = tpRunning = running;
  tpUpdateButton();
  if (running) tpTimer = setTimeout(tpPoll, 1000);
}
