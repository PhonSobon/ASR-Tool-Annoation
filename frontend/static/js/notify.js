// In-app notifications (top-right toasts) and confirm box, instead of the browser's alert / confirm popups.
const NOTE_ICONS = { success: "check", error: "x", warn: "alert", info: "info" };

// type: "success" | "error" | "warn" | "info". Errors stay until closed; the others go away by themselves.
function notify(message, type = "info", ms = type === "error" ? 0 : 4000) {
  const el = document.createElement("div");
  el.className = `note ${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.innerHTML = `<span class="note-icon">${icon(NOTE_ICONS[type] || "info")}</span><div class="note-text"></div>
    <button class="note-x" type="button" title="Close" aria-label="Close">${icon("x")}</button>`;
  el.querySelector(".note-text").textContent = message;
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 200); };
  el.querySelector(".note-x").onclick = close;
  $("notes").appendChild(el);
  while ($("notes").children.length > 5) $("notes").firstChild.remove();
  if (ms) setTimeout(close, ms);
  return el;
}

// Resolves true (OK) or false (Cancel / Esc). opts: {title, ok, danger}
function askConfirm(message, opts = {}) {
  const d = $("confirmDialog");
  $("confirmTitle").textContent = opts.title || "Please confirm";
  $("confirmText").textContent = message;
  $("confirmOk").textContent = opts.ok || "OK";
  $("confirmOk").className = opts.danger ? "stop" : "";
  return new Promise(resolve => {
    const done = v => { d.onclose = null; if (d.open) d.close(); resolve(v); };
    $("confirmOk").onclick = () => done(true);
    $("confirmCancel").onclick = () => done(false);
    d.onclose = () => done(false);
    d.showModal();
    $("confirmOk").focus();
  });
}
