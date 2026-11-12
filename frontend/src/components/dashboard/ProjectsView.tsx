"use client";
// Dashboard > Projects (administrators and project managers): where the work stands - tasks and their pull status,
// packages per review stage, the review, daily throughput, what needs attention, the team and dataset cleaning.
// One request (GET /api/dashboard?days=), refreshed every minute.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icon-sprite";
import { useNotify } from "@/components/notify";
import { useSession } from "@/components/session";
import { getJson } from "@/lib/api";
import type { Pull } from "@/lib/types";
import { Kpi, hrs, pct } from "./parts";

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
const KIND: Record<string, string> = { hub: "Hugging Face", local: "Local folder" };
const ago = (stamp: string | null) => {
  if (!stamp) return "";
  const d = (Date.now() - new Date(stamp.replace(" ", "T")).getTime()) / 86400000;
  return d < 1 ? "less than a day" : `${Math.floor(d)} day${d >= 2 ? "s" : ""}`;
};

export function ProjectsView({ refresh }: { refresh: number }) {
  const { nameOf } = useSession();
  const { notify } = useNotify();
  const router = useRouter();
  const [dash, setDash] = useState<Dash | null>(null);
  const [days, setDays] = useState(14);
  const [filter, setFilter] = useState<Status | "">("");
  const [q, setQ] = useState("");
  const [dups, setDups] = useState<{ pairs: number; packages_open: number } | null>(null);

  const load = useCallback(() => getJson<Dash>(`/api/dashboard?days=${days}`).then(setDash)
    .catch(e => notify("Cannot load the dashboard: " + e.message, "error")), [days, notify]);
  useEffect(() => { getJson<{ pairs: number; packages_open: number }>("/api/duplicates/summary").then(setDups).catch(() => {}); }, [refresh]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load, refresh]);

  const rows = useMemo(() => (dash?.rows || []).filter(r => (!filter || r.status === filter) &&
    (!q || `${r.name} ${r.id} ${r.annotators.join(" ")}`.toLowerCase().includes(q.toLowerCase()))), [dash, filter, q]);

  if (!dash) return <div className="boot muted">Loading…</div>;
  const { tasks: t, packages: p, pipeline: pl, quality: qa } = dash;
  const maxDay = Math.max(1, ...dash.daily.flatMap(d => SERIES.map(s => d[s.key] as number)));
  const roles = Object.entries(dash.team.roles).filter(([, r]) => r.total);
  const free = dash.team.free_annotators;

  return (
    <>
      {!!dups?.packages_open && (
        <Link className="dash-alert" href="/duplicates">
          <Icon name="copy" />
          <span><b>{dups.packages_open} package{dups.packages_open > 1 ? "s" : ""} are duplicates of audio already in the tool</b>
            Skip them before anyone annotates — or is paid for — the same speech twice.</span>
          <Icon name="chevron-right" />
        </Link>)}
      <div className="kpis">
        <Kpi icon="file" label="Tasks" value={t.total}
             sub={`${t.finished} finished · ${t.pulled} pulled · ${t.waiting_pull} waiting for pull`} />
        <Kpi icon="check" label="Packages completed" value={p.completed} of={p.total}
             sub={`${pct(p.completed, p.total)}% of ${p.total} packages · ${hrs(dash.hours.total)}`} />
        <Kpi icon="shield" label="Waiting for review" value={pl.inspecting} tone={pl.inspecting ? "warn" : ""}
             sub={dash.waiting.inspecting ? `oldest waits ${ago(dash.waiting.inspecting)}` : "nothing waiting"} />
        <Kpi icon="check-circle" label="Accepted" value={pl.accepted} tone="ok"
             sub={`${hrs(dash.hours.accepted, "0h")} of speech${pl.returned ? ` · ${pl.returned} returned to fix` : ""}`} />
      </div>

      <div className="dash-row two-one">
        <div className="panel">
          <div className="dash-title"><Icon name="dashboard" /><b>Review pipeline</b>
            <span className="muted">{p.total} packages · {hrs(dash.hours.total)}</span></div>
          <div className="dash-stack" role="img" aria-label={STAGES.map(s => `${s.label} ${pl[s.key] || 0}`).join(", ")}>
            {STAGES.filter(s => pl[s.key]).map(s => (
              <div key={s.key} style={{ flexGrow: pl[s.key], background: s.color }} title={`${s.label}: ${pl[s.key]} (${pct(pl[s.key], p.total + pl.skipped)}%)`} />
            ))}
          </div>
          <ul className="dash-stages">
            {STAGES.map(s => (
              <li key={s.key}><i style={{ background: s.color }} /><span>{s.label}</span>
                <b>{pl[s.key] || 0}</b><small>{pct(pl[s.key] || 0, p.total + (pl.skipped || 0))}%</small></li>))}
          </ul>
        </div>

        <div className="panel">
          <div className="dash-title"><Icon name="shield" /><b>Review quality</b></div>
          <div className="dash-big">
            {qa.first_pass_rate === null ? <b className="none">No reviews yet</b> : <b>{qa.first_pass_rate}%</b>}
            <span>accepted at the first review</span>
          </div>
          <dl className="dash-list">
            <div><dt>Packages reviewed</dt><dd>{qa.reviewed_packages}</dd></div>
            <div><dt>Accepted</dt><dd>{qa.accepted}</dd></div>
            <div><dt>Returned to annotators</dt><dd className={qa.returned ? "bad" : ""}>{qa.returned}</dd></div>
            <div><dt>Reviews returned</dt><dd className={qa.return_rate ? "bad" : ""}>{qa.return_rate === null ? "–" : `${qa.return_rate}%`}</dd></div>
          </dl>
        </div>
      </div>

      <div className="panel dash-panel">
        <div className="dash-title"><Icon name="chart" /><b>Daily work</b>
          <span className="muted">packages completed and accepted per day</span>
          <span className="seg">
            {[7, 14, 30].map(n => <button key={n} type="button" className={days === n ? "on" : ""} onClick={() => setDays(n)}>{n} days</button>)}
          </span>
        </div>
        <DailyChart daily={dash.daily} max={maxDay} />
      </div>

      <div className="dash-row three">
        <div className="panel">
          <div className="dash-title"><Icon name="alert" /><b>Needs attention</b>
            {dash.attention.length > 0 && <span className="count">{dash.attention.length}</span>}</div>
          {dash.attention.length ? (
            <ul className="dash-attn">
              {dash.attention.map((a, k) => (
                <li key={k} className={a.kind} onClick={() => router.push(`/tasks/${a.task}`)}>
                  <Icon name={ATTENTION[a.kind]} /><span><b>{a.name}</b>{a.text}</span><Icon name="chevron-right" />
                </li>))}
            </ul>
          ) : <div className="dash-none"><Icon name="check-circle" />Nothing waiting — every task is moving.</div>}
        </div>

        <div className="panel">
          <div className="dash-title"><Icon name="users" /><b>Team</b></div>
          <dl className="dash-list">
            {roles.map(([k, r]) => (
              <div key={k}><dt>{r.label}</dt>
                <dd>{r.active}{r.active !== r.total && <small> +{r.total - r.active} off</small>}</dd></div>))}
          </dl>
          <div className="dash-sub">Free to pull <span className="count">{free.length}</span></div>
          <div className="dash-pills">
            {free.length ? free.map(u => <span key={u} className="pill">{nameOf(u)}</span>)
              : <span className="muted">Every annotator has an unfinished task.</span>}
          </div>
          {free.length > t.waiting_pull &&
            <p className="dash-hint">{free.length - t.waiting_pull} annotator(s) have nothing to pull — push more tasks.</p>}
        </div>

        <div className="panel">
          <div className="dash-title"><Icon name="database" /><b>Dataset cleaning</b></div>
          <dl className="dash-list">
            <div><dt>Dataset batches</dt><dd>{dash.cleaning.datasets}</dd></div>
            <div><dt>Clips to review</dt><dd>{dash.cleaning.todo}</dd></div>
            <div><dt>Likely bad</dt><dd className={dash.cleaning.likely_bad ? "bad" : ""}>{dash.cleaning.likely_bad}</dd></div>
            <div><dt>Accepted</dt><dd>{dash.cleaning.accepted}<small> · {hrs(dash.cleaning.accepted_hours)}</small></dd></div>
            <div><dt>Rejected</dt><dd className={dash.cleaning.rejected ? "bad" : ""}>{dash.cleaning.rejected}</dd></div>
          </dl>
        </div>
      </div>

      <div className="panel dash-panel">
        <div className="dash-title"><Icon name="file" /><b>Tasks</b><span className="count">{rows.length}</span>
          <span style={{ flex: 1 }} />
          <input type="search" placeholder="Search task or annotator" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="act-roles dash-filter">
          <button type="button" className={`chip${!filter ? " on" : ""}`} onClick={() => setFilter("")}>All <span>{t.total}</span></button>
          {(Object.keys(STATUS) as Status[]).map(s => (
            <button key={s} type="button" className={`chip${filter === s ? " on" : ""}`} onClick={() => setFilter(f => f === s ? "" : s)}>
              {STATUS[s].label} <span>{t[s]}</span></button>))}
        </div>
        <div className="table-wrap">
          <table className="pkg-table act-table dash-table">
            <thead><tr>
              <th>Task</th><th>Status</th><th>Annotator</th><th>Progress</th>
              <th className="num">To annotate</th><th className="num">Returned</th><th className="num">To review</th>
              <th className="num">Accepted</th><th className="num">Speech</th><th>Last save</th>
            </tr></thead>
            <tbody>
              {rows.map(r => {
                const done = pct(r.completed, r.packages), acc = pct(r.stages.accepted, r.packages);
                return (
                  <tr key={r.id} className="click" onClick={() => router.push(`/tasks/${r.id}`)}>
                    <td><b>{r.name}</b><div className="pkg-sub">{KIND[r.kind] || "Upload & Crop"} · {r.created.slice(0, 10)}</div></td>
                    <td><span className={`pill ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span></td>
                    <td>{r.pulled.length ? r.pulled.map(x => <div key={x.username}>{nameOf(x.username)}<div className="pkg-sub">pulled {x.at.slice(0, 16)}</div></div>)
                      : r.annotators.map(nameOf).join(", ") || <span className="muted">–</span>}</td>
                    <td><div className="dash-prog" title={`${done}% completed, ${acc}% accepted`}>
                      <div style={{ width: `${done}%` }} /><div className="acc" style={{ width: `${acc}%` }} /></div>
                      <div className="pkg-sub nowrap">{r.completed} / {r.packages} completed</div></td>
                    <td className="num">{r.stages.annotating}</td>
                    <td className={`num${r.stages.returned ? " bad" : ""}`}>{r.stages.returned}</td>
                    <td className="num">{r.stages.inspecting}</td>
                    <td className="num ok">{r.stages.accepted}</td>
                    <td className="num nowrap">{hrs(r.hours)}</td>
                    <td className="nowrap">{r.last_save.slice(0, 16)}</td>
                  </tr>);
              })}
              {!rows.length && <tr><td colSpan={10} className="empty">No task matches.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted work-note">Completed = the annotator pressed Complete (waiting for review or accepted). Pulled = an
          annotator pulled the task themselves. &quot;Accepted at the first review&quot; counts each package once, by its first
          review decision.</p>
      </div>
    </>
  );
}

/** grouped bars per day (one y-axis), a hover tooltip per day with every count */
function DailyChart({ daily, max }: { daily: Day[]; max: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const empty = daily.every(d => SERIES.every(s => !d[s.key]));
  const W = 860, H = empty ? 120 : 200, L = 32, B = 22, T = 8, gw = (W - L) / daily.length;
  const bw = Math.max(2, Math.min(14, (gw - 6) / SERIES.length - 2));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const every = Math.ceil(daily.length / 10);
  return (
    <div className="dash-chart">
      <ul className="dash-legend">{SERIES.map(s => <li key={s.key}><i style={{ background: s.color }} />{s.label}</li>)}</ul>
      <div className="dash-chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Packages completed and accepted per day"
             onMouseLeave={() => setHover(null)}>
          {!empty && ticks.map(v => <g key={v}><line x1={L} x2={W} y1={y(v)} y2={y(v)} className="grid" /><text x={L - 6} y={y(v) + 4} className="tick" textAnchor="end">{v}</text></g>)}
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
