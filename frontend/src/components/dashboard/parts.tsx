// Pieces shared by the Dashboard tabs (Projects, Team).
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icon-sprite";

/** speech time, compact: "38m 28s", "1h 23m"; `zero` for nothing ("–" in tables, "0h" in headline numbers) */
export const dur = (s: number, zero = "–") => {
  if (!s) return zero;
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.round(s % 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
};
/** the same from hours */
export const hrs = (h: number, zero = "–") => dur(h * 3600, zero);
export const pct = (n: number, of: number) => of ? Math.round(100 * n / of) : 0;

/** a headline number: icon, label, value (optionally "of" a total, drawn as a bar) and a line of detail */
export function Kpi({ icon, label, value, of, sub, tone = "" }:
  { icon: IconName; label: string; value: string | number; of?: number; sub?: string; tone?: string }) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="kpi-top"><span className="kpi-icon"><Icon name={icon} /></span>{label}</div>
      <div className="kpi-value">{value}{of !== undefined && <small> / {of}</small>}</div>
      {of !== undefined && <div className="kpi-bar"><div style={{ width: `${pct(Number(value), of)}%` }} /></div>}
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
