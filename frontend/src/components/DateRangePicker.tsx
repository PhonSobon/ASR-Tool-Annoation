"use client";
// A "From – To" date field with a calendar: quick ranges on the left (Today, This week, Last month…), a month grid
// on the right where the first click picks the start and the second the end (the days between are highlighted, also
// while hovering). Values are "YYYY-MM-DD" ("" = open end); onChange gets both at once.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const add = (d: Date, days: number) => { const x = new Date(d); x.setDate(x.getDate() + days); return x; };
const monday = (d: Date) => add(d, -((d.getDay() + 6) % 7));
const show = (s: string) => parse(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = Array.from({ length: 12 }, (_, m) => new Date(2000, m, 1).toLocaleDateString("en-GB", { month: "long" }));

function presets(today: Date): [string, string, string][] {
  const t = iso(today), m0 = new Date(today.getFullYear(), today.getMonth(), 1);
  const lm0 = new Date(today.getFullYear(), today.getMonth() - 1, 1), lm1 = add(m0, -1);
  return [
    ["Today", t, t], ["Yesterday", iso(add(today, -1)), iso(add(today, -1))],
    ["This week", iso(monday(today)), t], ["Last 7 days", iso(add(today, -6)), t],
    ["This month", iso(m0), t], ["Last month", iso(lm0), iso(lm1)],
    ["Last 30 days", iso(add(today, -29)), t], ["Any time", "", ""],
  ];
}

export function DateRangePicker({ since, until, onChange, max, label = "Dates", placeholder = "Any time" }: {
  since: string; until: string; onChange: (since: string, until: string) => void;
  max?: string; label?: string; placeholder?: string;
}) {
  const today = useMemo(() => new Date(new Date().setHours(0, 0, 0, 0)), []);
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState<string | null>(null);     // start picked, waiting for the end
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState(() => { const d = since ? parse(since) : today; return new Date(d.getFullYear(), d.getMonth(), 1); });
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  const close = () => { setOpen(false); setFirst(null); setHover(null); };
  const toggle = () => {
    if (open) return close();
    const d = until ? parse(until) : since ? parse(since) : today;
    setView(new Date(d.getFullYear(), d.getMonth(), 1));
    setOpen(true);
  };
  const apply = (a: string, b: string) => { onChange(a, b); close(); };

  const pick = (d: string) => {
    if (!first) { setFirst(d); return; }
    apply(d < first ? d : first, d < first ? first : d);
  };

  // the range drawn: the one being picked (first .. hover), else the current value
  const [lo, hi] = first ? [first, hover || first].sort() : [since, until];
  const days = useMemo(() => {
    const start = monday(view);
    return Array.from({ length: 42 }, (_, k) => add(start, k));
  }, [view]);
  const step = (n: number) => setView(v => new Date(v.getFullYear(), v.getMonth() + n, 1));
  const years = useMemo(() => Array.from({ length: 8 }, (_, k) => today.getFullYear() - 6 + k), [today]);

  const text = since || until
    ? since === until ? show(since) : `${since ? show(since) : "…"} – ${until ? show(until) : "…"}`
    : placeholder;
  const current = presets(today).find(([, a, b]) => a === since && b === until)?.[0];

  return (
    <div className="drp" ref={box}>
      <button type="button" className={`drp-field${since || until ? " set" : ""}`} aria-haspopup="dialog" aria-expanded={open}
              aria-label={`${label}: ${text}`} onClick={toggle}>
        <Icon name="clock" /><span className="drp-text">{current && current !== "Any time" ? <><b>{current}</b> · {text}</> : text}</span>
        <Icon name="chevron-right" className="drp-caret" />
      </button>
      {(since || until) && <button type="button" className="drp-clear" title="Clear the dates" aria-label="Clear the dates"
                                   onClick={() => onChange("", "")}><Icon name="x" /></button>}
      {open && (
        <div className="drp-pop" role="dialog" aria-label={label}>
          <div className="drp-presets">
            {presets(today).map(([name, a, b]) => (
              <button type="button" key={name} className={current === name ? "on" : ""}
                      disabled={!!max && a > max} onClick={() => apply(a, b)}>{name}</button>))}
          </div>
          <div className="drp-cal">
            <div className="drp-head">
              <button type="button" className="icon" aria-label="Previous month" onClick={() => step(-1)}><Icon name="chevron-left" /></button>
              <select aria-label="Month" value={view.getMonth()} onChange={e => setView(new Date(view.getFullYear(), +e.target.value, 1))}>
                {MONTHS.map((m, k) => <option key={m} value={k}>{m}</option>)}</select>
              <select aria-label="Year" value={view.getFullYear()} onChange={e => setView(new Date(+e.target.value, view.getMonth(), 1))}>
                {years.map(y => <option key={y}>{y}</option>)}</select>
              <button type="button" className="icon" aria-label="Next month" onClick={() => step(1)}><Icon name="chevron-right" /></button>
            </div>
            <div className="drp-grid" onMouseLeave={() => setHover(null)}>
              {WEEKDAYS.map(w => <span key={w} className="drp-wd">{w}</span>)}
              {days.map(d => {
                const s = iso(d), out = d.getMonth() !== view.getMonth(), off = !!max && s > max;
                const inside = !!lo && !!hi && s >= lo && s <= hi, edge = s === lo || s === hi;
                return (
                  <button type="button" key={s} disabled={off} aria-label={show(s)} aria-pressed={edge}
                          className={["drp-day", out && "out", inside && "in", edge && "edge", s === iso(today) && "today"].filter(Boolean).join(" ")}
                          onMouseEnter={() => first && setHover(s)} onClick={() => pick(s)}>{d.getDate()}</button>
                );
              })}
            </div>
            <div className="drp-foot">
              <span className="muted">{first ? `From ${show(first)} — now click the last day` : "Click the first day, then the last day"}</span>
              <span style={{ flex: 1 }} />
              {first && <button type="button" className="sec small" onClick={() => apply(first, first)}>Only this day</button>}
              <button type="button" className="sec small" onClick={() => { setView(new Date(today.getFullYear(), today.getMonth(), 1)); }}>Go to today</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
