// Pages and navigation: #/tasks (My Tasks), #/upload (Upload & Crop), #/task/<id> (one task),
// #/datasets (Dataset Cleaning), #/dataset/<id> (one dataset). Sidebar.
const PAGES = { tasks: "pageTasks", upload: "pageUpload", task: "pageTask", datasets: "pageDatasets", dataset: "pageDataset" };
const NAV_OF = { task: "tasks", dataset: "datasets" };   // sidebar item that stays highlighted on a detail page

function showPage(page, crumbs) {
  for (const [name, id] of Object.entries(PAGES)) $(id).hidden = name !== page;
  document.querySelectorAll(".nav-item").forEach(a => a.classList.toggle("on", a.dataset.page === (NAV_OF[page] || page)));
  document.body.classList.remove("side-open");
  setCrumbs(crumbs);
  player.pause();
  rvAudio.pause();
}

// crumbs: [[label, href?], ...]
function setCrumbs(crumbs) {
  $("crumbs").innerHTML = crumbs.map(([label, href]) => href ? `<a href="${href}">${esc(label)}</a>` : `<span>${esc(label)}</span>`)
                                .join(`<span class="crumb-sep">${icon("chevron-right")}</span>`);
}

async function route() {
  const h = location.hash || "#/tasks", m = h.match(/^#\/task\/([\w-]+)/), d = h.match(/^#\/dataset\/([\w-]+)/);
  await saveNow();                       // the package editor saves into its crop first
  await flushCropSaves();
  await flushReview();
  try {
    if (m) {
      showPage("task", [["Workbench"], ["My Tasks", "#/tasks"], ["…"]]);
      const t = await openTask(m[1]);
      showPage("task", [["Workbench"], ["My Tasks", "#/tasks"], [t.name]]);
    } else if (d) {
      showPage("dataset", [["Dataset Cleaning"], ["Hugging Face Datasets", "#/datasets"], ["…"]]);
      const x = await openDataset(d[1]);
      setCrumbs([["Dataset Cleaning"], ["Hugging Face Datasets", "#/datasets"], [x.name]]);
    } else if (h.startsWith("#/datasets")) {
      showPage("datasets", [["Dataset Cleaning"], ["Hugging Face Datasets"]]);
      await loadDatasets();
    } else if (h.startsWith("#/upload")) {
      showPage("upload", [["Audio Annotation"], ["Upload & Crop"]]);
      await loadDrafts();
    } else {
      showPage("tasks", [["Workbench"], ["My Tasks"]]);
      await loadTasks();
    }
  } catch (e) {
    notify("Cannot open this page: " + e.message, "error");
    if (m) location.hash = "#/tasks";
    if (d) location.hash = "#/datasets";
  }
}
window.addEventListener("hashchange", route);

// sidebar: collapse groups, show / hide the whole menu
document.querySelectorAll(".nav-head").forEach(b => b.onclick = () => b.parentElement.classList.toggle("closed"));
$("btnSide").onclick = () => {
  if (matchMedia("(max-width:800px)").matches) document.body.classList.toggle("side-open");
  else { document.body.classList.toggle("side-hidden"); if (session) requestAnimationFrame(() => applyZoom(pos)); }
};
