"use client";
// Project Dashboard (administrators and project managers): where the work stands - tasks and their pull status,
// packages per review stage, the review, daily throughput, what needs attention, the team and dataset
// cleaning. One request (GET /api/dashboard?days=), refreshed every minute.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icon-sprite";
import { useNotify } from "@/components/notify";
import { useCrumbs, useSession } from "@/components/session";
import { getJson } from "@/lib/api";
import { fmtHms } from "@/lib/format";
import type { Pull } from "@/lib/types";

type Status = "not_shared" | "waiting_pull" | "pulled" | "assigned" | "finished";
interface Row {
  id: string; name: string; created: string; created_by: string; kind: string; status: Status;
  annotators: string[]; pulled: Pull[]; packages: number; completed: number; stages: Record<string, number>;
  hours: number; accepted_hours: number; last_save: string;
}
interface Day { day: string; completed: number; accepted: number; returned: number }
interface Dash {
  generated: string; days: number; since: string;
  tasks: Record<Status | "total", number>;
  packages: { total: number; completed: number; todo: number };
  pipeline: Record<string, number>;
  hours: { total: number; accepted: number };
  quality: { accepted: number; returned: number; returns: number; reviews: number; reviewed_packages: number; first_pass: number;
             first_pass_rate: number | null; return_rate: number | null };
  waiting: { inspecting: string | null };
  daily: Day[];
  attention: { task: string; name: string; kind: "waiting_pull" | "stale" | "returned"; text: string; since?: string }[];
  team: { roles: Record<string, { label: string; active: number; total: number }>; free_annotators: string[] };
  cleaning: { datasets: number; todo: number; accepted: number; rejected: number; likely_bad: number; accepted_hours: number };
  rows: Row[];
}

/** the review pipeline, in order: slate = to do, red = returned, light -> dark blue = further along (skipped is neutral) */
const STAGES: { key: string; label: string; color: string }[] = [
  { key: "annotating", label: "To annotate", color: "var(--s1)" },
  { key: "returned", label: "Returned to fix", color: "var(--s2)" },
  { key: "inspecting", label: "Waiting for review", color: "var(--s4)" },
  { key: "accepted", label: "Accepted", color: "var(--s5)" },
  { key: "skipped", label: "Skipped", color: "var(--s-none)" },
];
const SERIES: { key: keyof Day; label: string; color: string }[] = [
  { key: "completed", label: "Completed", color: "var(--d1)" },
  { key: "accepted", label: "Accepted", color: "var(--d3)" },
];
const STATUS: Record<Status, { label: string; cls: string }> = {
  not_shared: { label: "Not shared", cls: "" },
  waiting_pull: { label: "Waiting for pull", cls: "warn" },
  pulled: { label: "Pulled", cls: "pulled" },
  assigned: { label: "Assigned", cls: "dur" },
  finished: { label: "Finished", cls: "ok" },
};
const ATTENTION: Record<string, IconName> = { waiting_pull: "inbox", stale: "clock", returned: "alert" };
const hrs = (h: number) => h ? fmtHms(h * 3600) : "-";
const pct = (n: number, of: number) => of ? Math.round(100 * n / of) : 0;
const ago = (stamp: string | null) => {
  if (!stamp) return "";
  const d = (Date.now() - new Date(stamp.replace(" ", "T")).getTime()) / 86400000;
  return d < 1 ? "less than a day" : `${Math.floor(d)} day${d >= 2 ? "s" : ""}`;
};

export default function DashboardPage() {
  useCrumbs([["Workbench"], ["Dashboard"]]);
  const { can, nameOf } = useSession();
  const { notify } = useNotify();
  const router = useRouter();
  const [dash, setDash] = useState<Dash | null>(null);
  const [days, setDays] = useState(14);
  const [filter, setFilter] = useState<Status | "">("");
  const [q, setQ] = useState("");

  const load = useCallback(() => getJson<Dash>(`/api/dashboard?days=${days}`).then(setDash)
    .catch(e => notify("Cannot load the dashboard: " + e.message, "error")), [days, notify]);
  useEffect(() => {
    if (!can("task.manage")) { router.replace("/tasks"); return; }
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [can, router, load]);

  const rows = useMemo(() => (dash?.rows || []).filter(r => (!filter || r.status === filter) &&
    (!q || `${r.name} ${r.id} ${r.annotators.join(" ")}`.toLowerCase().includes(q.toLowerCase()))), [dash, filter, q]);

  if (!dash) return <div className="boot muted">Loading…</div>;
  const { tasks: t, packages: p, pipeline: pl, quality: qa } = dash;
  const cards: { label: string; value: string | number; sub?: string; icon: IconName; tone?: string; status?: Status }[] = [
    { label: "Tasks", value: t.total, sub: `${t.finished} finished`, icon: "file" },
    { label: "Waiting for pull", value: t.waiting_pull, sub: "pushed, nobody pulled", icon: "inbox", tone: t.waiting_pull ? "warn" : "", status: "waiting_pull" },
    { label: "Pulled datasets", value: t.pulled, sub: "pulled by an annotator", icon: "download", tone: "pulled", status: "pulled" },
    { label: "Packages completed", value: p.completed, sub: `of ${p.total} · ${pct(p.completed, p.total)}%`, icon: "check" },
    { label: "Waiting for review", value: pl.inspecting, sub: dash.waiting.inspecting ? `oldest ${ago(dash.waiting.inspecting)}` : "nothing waiting", icon: "shield", tone: pl.inspecting ? "warn" : "" },
    { label: "Accepted", value: pl.accepted, sub: `${hrs(dash.hours.accepted)} of speech`, icon: "check-circle", tone: "ok" },
    { label: "Returned to fix", value: pl.returned, sub: `${qa.returns} returns in total`, icon: "alert", tone: pl.returned ? "err" : "" },
  ];
  const maxDay = Math.max(1, ...dash.daily.flatMap(d => SERIES.map(s => d[s.key] as number)));

  return (
    <section className="activity dash">
      <div className="panel headcard act-head">
        <div>
          <h2>Dashboard</h2>
          <p>Where the work stands: tasks pushed and pulled, packages through annotation and review,
            and what needs a manager. Updates every minute (last {dash.generated.slice(11, 16)}).</p>
        </div>
        <button className="sec" onClick={load}><Icon name="restore" /> Refresh</button>
      </div>

      <div className="act-cards">
        {cards.map(c => (
          <button key={c.label} type="button" disabled={!c.status} className={`act-card ${c.tone || ""}${c.status && filter === c.status ? " on" : ""}`}
                  title={c.status ? "Show these tasks in the table" : undefined}
                  onClick={() => c.status && setFilter(f => f === c.status ? "" : c.status!)}>
            <Icon name={c.icon} /><b>{c.value}</b><span>{c.label}{c.sub && <><br /><small>{c.sub}</small></>}</span>
          </button>
        ))}
      </div>

      <div className="dash-grid">
        <div className="panel">
          <b className="sec-title"><Icon name="dashboard" /> Review pipeline · {p.total} packages · {hrs(dash.hours.total)}</b>
          <div className="dash-stack" role="img" aria-label={STAGES.map(s => `${s.label} ${pl[s.key] || 0}`).join(", ")}>
            {STAGES.filter(s => pl[s.key]).map(s => (
              <div key={s.key} style={{ flexGrow: pl[s.key], background: s.color }} title={`${s.label}: ${pl[s.key]} (${pct(pl[s.key], p.total + pl.skipped)}%)`} />
            ))}
          </div>
          <ul className="dash-legend">
            {STAGES.map(s => <li key={s.key}><i style={{ background: s.color }} />{s.label} <b>{pl[s.key] || 0}</b></li>)}
          </ul>
        </div>

        <div className="panel">
          <b className="sec-title"><Icon name="shield" /> Review</b>
          <div className="dash-kv">
            <div><b>{qa.first_pass_rate === null ? "-" : `${qa.first_pass_rate}%`}</b><span>accepted at the first review</span></div>
            <div><b className={qa.return_rate ? "bad" : ""}>{qa.return_rate === null ? "-" : `${qa.return_rate}%`}</b><span>of reviews returned</span></div>
            <div><b>{qa.reviewed_packages}</b><span>packages reviewed</span></div>
            <div><b>{qa.accepted}</b><span>accepted</span></div>
            <div><b className={qa.returned ? "bad" : ""}>{qa.returned}</b><span>returned to annotators</span></div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="act-bar">
          <b className="sec-title"><Icon name="clock" /> Daily work</b>
          <span style={{ flex: 1 }} />
          {[7, 14, 30].map(n => <button key={n} type="button" className={`chip${days === n ? " on" : ""}`} onClick={() => setDays(n)}>{n} days</button>)}
        </div>
        <DailyChart daily={dash.daily} max={maxDay} />
      </div>

      <div className="dash-grid">
        <div className="panel">
          <b className="sec-title"><Icon name="alert" /> Needs attention ({dash.attention.length})</b>
          {dash.attention.length ? (
            <ul className="dash-attn">
              {dash.attention.map((a, k) => (
                <li key={k} className={a.kind} onClick={() => router.push(`/tasks/${a.task}`)}>
                  <Icon name={ATTENTION[a.kind]} /><span><b>{a.name}</b><br />{a.text}</span><Icon name="chevron-right" />
                </li>))}
            </ul>
          ) : <p className="muted">Nothing waiting — every task is moving.</p>}
        </div>

        <div className="panel">
          <b className="sec-title"><Icon name="users" /> Team</b>
          <div className="dash-kv">
            {Object.entries(dash.team.roles).filter(([, r]) => r.total).map(([k, r]) => (
              <div key={k}><b>{r.active}</b><span>{r.label}{r.active !== r.total ? ` (${r.total - r.active} deactivated)` : ""}</span></div>))}
          </div>
          <p className="dash-free"><b>Free to pull ({dash.team.free_annotators.length}):</b>{" "}
            {dash.team.free_annotators.length ? dash.team.free_annotators.map(u => <span key={u} className="pill">{nameOf(u)}</span>)
              : <span className="muted">every annotator has an unfinished task</span>}</p>
          {dash.team.free_annotators.length > t.waiting_pull &&
            <p className="muted">{dash.team.free_annotators.length - t.waiting_pull} annotator(s) have nothing to pull — push more tasks.</p>}
          <b className="sec-title" style={{ marginTop: 16 }}><Icon name="database" /> Dataset cleaning</b>
          <div className="dash-kv">
            <div><b>{dash.cleaning.datasets}</b><span>dataset batches</span></div>
            <div><b>{dash.cleaning.todo}</b><span>clips to review{dash.cleaning.likely_bad ? ` (${dash.cleaning.likely_bad} likely bad)` : ""}</span></div>
            <div><b>{dash.cleaning.accepted}</b><span>accepted · {hrs(dash.cleaning.accepted_hours)}</span></div>
            <div><b className={dash.cleaning.rejected ? "bad" : ""}>{dash.cleaning.rejected}</b><span>rejected</span></div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="act-bar">
          <b className="sec-title"><Icon name="file" /> Tasks ({rows.length})</b>
          <span style={{ flex: 1 }} />
          <div className="act-roles">
            <button type="button" className={`chip${!filter ? " on" : ""}`} onClick={() => setFilter("")}>All</button>
            {(Object.keys(STATUS) as Status[]).map(s => (
              <button key={s} type="button" className={`chip${filter === s ? " on" : ""}`} onClick={() => setFilter(f => f === s ? "" : s)}>
                {STATUS[s].label} <span>{t[s]}</span></button>))}
          </div>
          <input type="search" placeholder="Search task or annotator" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="table-wrap">
          <table className="pkg-table act-table dash-table">
            <thead><tr>
              <th>Task</th><th>Status</th><th>Annotator</th><th>Progress</th>
              <th className="num">To annotate</th><th className="num">Returned</th><th className="num">To review</th>
              <th className="num">Accepted</th><th className="num">Hours</th><th>Last save</th>
            </tr></thead>
            <tbody>
              {rows.map(r => {
                const done = pct(r.completed, r.packages), acc = pct(r.stages.accepted, r.packages);
                return (
                  <tr key={r.id} className="click" onClick={() => router.push(`/tasks/${r.id}`)}>
                    <td><b>{r.name}</b><div className="pkg-sub">{r.kind === "hub" ? "Hugging Face" : r.kind === "local" ? "Local folder" : "Upload & Crop"} · {r.created.slice(0, 10)}</div></td>
                    <td><span className={`pill ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span></td>
                    <td>{r.pulled.length ? r.pulled.map(x => <div key={x.username}>{nameOf(x.username)}<div className="pkg-sub">pulled {x.at.slice(0, 16)}</div></div>)
                      : r.annotators.map(nameOf).join(", ") || <span className="muted">-</span>}</td>
                    <td><div className="dash-prog" title={`${done}% completed, ${acc}% accepted`}>
                      <div style={{ width: `${done}%` }} /><div className="acc" style={{ width: `${acc}%` }} /></div>
                      <div className="pkg-sub">{r.completed} / {r.packages} completed · {acc}% accepted</div></td>
                    <td className="num">{r.stages.annotating}</td>
                    <td className={`num${r.stages.returned ? " bad" : ""}`}>{r.stages.returned}</td>
                    <td className="num">{r.stages.inspecting}</td>
                    <td className="num ok">{r.stages.accepted}</td>
                    <td className="num">{hrs(r.hours)}</td>
                    <td className="nowrap">{r.last_save.slice(0, 16)}</td>
                  </tr>);
              })}
              {!rows.length && <tr><td colSpan={11} className="empty">No task matches.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted work-note">Completed = the annotator pressed Complete (waiting for review or accepted). Pulled = an
          annotator pulled the task themselves. "Accepted at the first review" counts each package once, by its first
          review decision.</p>
      </div>
    </section>
  );
}

/** grouped bars per day (3 series, one y-axis), a hover tooltip per day with every count */
function DailyChart({ daily, max }: { daily: Day[]; max: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 860, H = 200, L = 32, B = 22, T = 8, gw = (W - L) / daily.length;
  const bw = Math.max(2, Math.min(14, (gw - 6) / SERIES.length - 2));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const every = Math.ceil(daily.length / 10);
  const empty = daily.every(d => SERIES.every(s => !d[s.key]));
  return (
    <div className="dash-chart">
      <ul className="dash-legend">{SERIES.map(s => <li key={s.key}><i style={{ background: s.color }} />{s.label}</li>)}</ul>
      <div className="dash-chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Packages completed and accepted per day"
             onMouseLeave={() => setHover(null)}>
          {ticks.map(v => <g key={v}><line x1={L} x2={W} y1={y(v)} y2={y(v)} className="grid" /><text x={L - 6} y={y(v) + 4} className="tick" textAnchor="end">{v}</text></g>)}
          {daily.map((d, i) => {
            const x0 = L + i * gw + (gw - SERIES.length * (bw + 2)) / 2;
            return (
              <g key={d.day}>
                {hover === i && <rect x={L + i * gw} y={T} width={gw} height={H - T - B} className="hover-band" />}
                {SERIES.map((s, k) => {
                  const v = d[s.key] as number, top = y(v), h = H - B - top;
                  return v ? <path key={s.key} fill={s.color}
                    d={`M${x0 + k * (bw + 2)},${H - B} v${-(h - Math.min(4, h))} q0,${-Math.min(4, h)} ${Math.min(4, bw / 2)},${-Math.min(4, h)} h${bw - 2 * Math.min(4, bw / 2)} q${Math.min(4, bw / 2)},0 ${Math.min(4, bw / 2)},${Math.min(4, h)} V${H - B} z`} /> : null;
                })}
                {i % every === 0 && <text x={L + i * gw + gw / 2} y={H - 6} className="tick" textAnchor="middle">{d.day.slice(5)}</text>}
                <rect x={L + i * gw} y={0} width={gw} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
              </g>);
          })}
          <line x1={L} x2={W} y1={H - B} y2={H - B} className="axis" />
        </svg>
        {hover !== null && (
          <div className="dash-tip" style={{ left: `${100 * (L + (hover + 0.5) * gw) / W}%` }}>
            <b>{daily[hover].day}</b>
            {SERIES.map(s => <div key={s.key}><i style={{ background: s.color }} />{s.label} <b>{daily[hover][s.key]}</b></div>)}
            <div><i className="none" />Returned <b>{daily[hover].returned}</b></div>
          </div>)}
        {empty && <div className="dash-empty muted">No package was completed or reviewed in this period.</div>}
      </div>
    </div>
  );
}
