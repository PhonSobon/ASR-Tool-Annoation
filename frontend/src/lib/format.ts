// Time, duration and size formatting.
export const fmtT = (s: number) => {   // 00:46.331 (h:mm:ss.mmm past an hour)
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = (Math.floor(s % 60 * 1000) / 1000).toFixed(3).padStart(6, "0");
  return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m).padStart(2, "0")) + ":" + sec;
};
export const fmtDur = (s: number) => s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}m ${String(Math.round(s % 60)).padStart(2, "0")}s`
  : s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s.toFixed(1)} s`;
export const fmtSize = (b: number) => b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + " GB" : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + " MB" : Math.ceil(b / 1024) + " KB";
export const fmtHms = (s: number) => `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m ${Math.round(s % 60)}s`;
export const nowStamp = () => {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
export const r3 = (t: number) => Math.round(t * 1000) / 1000;
