// Network + DOM helpers shared by every other script.
const $ = id => document.getElementById(id);
// An icon from the SVG sprite (templates/partials/icons.html), e.g. icon("trash")
const icon = (name, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
async function api(url, body, method = "POST") {   // JSON request -> JSON reply; throws {message, fatal}
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.fatal = j.fatal; throw e; }
  return j;
}

async function fetchJson(url, opt) {
  const r = await fetch(url, opt), j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
