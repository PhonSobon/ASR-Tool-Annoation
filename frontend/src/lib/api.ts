// Talking to the Flask API (forwarded by next.config.ts). Errors become exceptions with the server's message;
// 401 (logged out meanwhile) goes back to the login page.
export class ApiError extends Error {
  constructor(message: string, public status: number, public fatal = false) { super(message); }
}

function checkLogin(r: Response) {
  if (r.status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
    location.href = "/login";
  }
}

async function handle<T>(r: Response): Promise<T> {
  checkLogin(r);
  const j = await r.json().catch(() => ({}));
  if (r.status === 403 && j.error === "Choose your own password first" && typeof window !== "undefined") {
    location.href = "/change-password";          // signed in with the default password
  }
  if (!r.ok) throw new ApiError(j.error || `HTTP ${r.status}`, r.status, !!j.fatal);
  return j as T;
}

/** JSON request -> JSON reply. */
export async function api<T = any>(url: string, body?: unknown, method = "POST"): Promise<T> {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return handle<T>(r);
}

export async function getJson<T = any>(url: string): Promise<T> {
  return handle<T>(await fetch(url));
}

export async function del<T = any>(url: string): Promise<T> {
  return handle<T>(await fetch(url, { method: "DELETE" }));
}

/** Upload one file with progress (fetch has no upload progress). */
export function uploadFile(file: File, onProgress: (p: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(), fd = new FormData();
    fd.append("audio", file);
    x.open("POST", "/api/audios");
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let j: any = {};
      try { j = JSON.parse(x.responseText); } catch { /* not JSON */ }
      x.status < 300 ? resolve(j) : reject(new Error(j.error || `HTTP ${x.status}`));
    };
    x.onerror = () => reject(new Error("Network error"));
    x.send(fd);
  });
}

/** base64 min/max int8 pairs (GET /api/audios/<id>/peaks) -> Int8Array */
export function decodePeaks(b64: string): Int8Array {
  const bin = atob(b64), out = new Int8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);   // wraps 128..255 to negative
  return out;
}

/** Start a download of a URL (the browser keeps the page). */
export function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.click();
}
