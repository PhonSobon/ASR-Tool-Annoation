// Who is annotating: the name comes from the server (ANNOTATOR_NAME, or the computer's user name) — nothing to type.
// It is saved on every package you edit (Annotator column of the Task Batch List).
let currentUser = "";

function userName() { return currentUser; }

(async () => {
  try { currentUser = (await fetchJson("/api/me")).name || ""; } catch (e) {}
  $("avatar").textContent = (currentUser.trim()[0] || "?").toUpperCase();
  $("avatar").title = currentUser ? `Annotator: ${currentUser}` : "Annotator";
})();

$("avatar").onclick = () => notify(currentUser ? `You are annotating as ${currentUser}.` : "No annotator name.", "info");
