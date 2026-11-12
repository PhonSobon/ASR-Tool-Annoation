"use client";
// Dashboard > Team (administrators): what every user produced in a period - hours annotated, packages completed,
// returned (errors) and accepted, the reviews they made and the dataset clips they cleaned. Read from the work
// itself (GET /api/activity/work), not from the activity log.
import { useCallback, useEffect, useMemo, useState } from "react";
import { DateRangePicker } from "@/components/DateRangePicker";
import { Icon } from "@/components/Icon";
import { useNotify } from "@/components/notify";
import { ROLE_LABEL } from "@/components/session";
import { getJson } from "@/lib/api";
import { Kpi, dur, pct } from "./parts";

interface UserWork {
  username: string; name: string; role: string; active: boolean; deleted: boolean;
  annotation: { done: number; done_seconds: number; accepted: number; accepted_seconds: number; passed: number;
                returned: number; in_progress: number };
  review: { inspected: number; accepted: number; returned: number };
  cleaning: { accepted: number; rejected: number; accepted_seconds: number };
}
interface Work {
  users: UserWork[]; since: string; until: string;
  totals: { done: number; done_seconds: number; accepted: number; accepted_seconds: number; returned: number;
            in_progress: number; clips_accepted: number; clips_rejected: number; clips_seconds: number };
}

const day = (back: number) => {
  const d = new Date(Date.now() - back * 86400000), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const PERIODS: { label: string; since: () => string }[] = [
  { label: "All time", since: () => "" }, { label: "Today", since: () => day(0) },
  { label: "7 days", since: () => day(6) }, { label: "30 days", since: () => day(29) },
];
const SORTS: Record<string, [string, (u: UserWork) => number]> = {
  hours: ["Hours annotated", u => u.annotation.done_seconds],
  done: ["Packages done", u => u.annotation.done],
  returned: ["Returned (errors)", u => u.annotation.returned],
  accepted: ["Accepted", u => u.annotation.accepted],
  reviews: ["Reviews made", u => u.review.inspected + u.review.accepted + u.review.returned],
  clips: ["Clips cleaned", u => u.cleaning.accepted + u.cleaning.rejected],
};
const hasWork = (u: UserWork) => [u.annotation, u.review, u.cleaning].some(g => Object.values(g).some(v => v > 0));

export function TeamView({ refresh }: { refresh: number }) {
  const { notify } = useNotify();
  const [work, setWork] = useState<Work | null>(null);
  const [range, setRange] = useState({ since: "", until: "" });
  const [view, setView] = useState({ role: "", q: "", sort: "hours", idle: false });

  const load = useCallback(() => getJson<Work>(`/api/activity/work?${new URLSearchParams(range)}`).then(setWork)
    .catch(e => notify(e.message, "error")), [range, notify]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load, refresh]);

  const users = useMemo(() => {
    const key = SORTS[view.sort][1];
    return (work?.users || []).filter(u =>
      (!view.role || u.role === view.role) && (view.idle || hasWork(u) || u.active) &&
      (!view.q || `${u.username} ${u.name}`.toLowerCase().includes(view.q.toLowerCase())))
      .sort((a, b) => key(b) - key(a) || a.username.localeCompare(b.username));
  }, [work, view]);

  if (!work) return <div className="boot muted">Loading…</div>;
  const t = work.totals;
  const roles = Array.from(new Set(work.users.map(u => u.role).filter(Boolean)));
  const period = PERIODS.find(p => p.since() === range.since && !range.until);

  return (
    <>
      <div className="dash-period">
        <span className="seg">
          {PERIODS.map(p => (
            <button key={p.label} type="button" className={period === p ? "on" : ""}
                    onClick={() => setRange({ since: p.since(), until: "" })}>{p.label}</button>))}
        </span>
        <DateRangePicker label="Work dates" since={range.since} until={range.until} onChange={(since, until) => setRange({ since, until })} />
      </div>

      <div className="kpis">
        <Kpi icon="clock" label="Hours annotated" value={dur(t.done_seconds, "0h")}
             sub={`${dur(t.accepted_seconds, "0h")} accepted`} />
        <Kpi icon="check" label="Packages done" value={t.done}
             sub={`${t.in_progress} in progress · ${t.accepted} accepted`} />
        <Kpi icon="alert" label="Returned (errors)" value={t.returned} tone={t.returned ? "err" : ""}
             sub={t.done ? `${pct(t.returned, t.done)}% of packages done` : "no package done yet"} />
        <Kpi icon="database" label="Clips cleaned" value={t.clips_accepted + t.clips_rejected} tone="ok"
             sub={`${t.clips_accepted} accepted · ${t.clips_rejected} rejected · ${dur(t.clips_seconds, "0h")}`} />
      </div>

      <div className="panel dash-panel">
        <div className="dash-title"><Icon name="users" /><b>People</b><span className="count">{users.length}</span>
          <span style={{ flex: 1 }} />
          <select aria-label="Sort by" value={view.sort} onChange={e => setView(v => ({ ...v, sort: e.target.value }))}>
            {Object.entries(SORTS).map(([k, [label]]) => <option key={k} value={k}>Sort: {label}</option>)}
          </select>
          <input type="search" placeholder="Search user" value={view.q} onChange={e => setView(v => ({ ...v, q: e.target.value }))} />
        </div>
        <div className="act-roles dash-filter">
          <button type="button" className={`chip${!view.role ? " on" : ""}`} onClick={() => setView(v => ({ ...v, role: "" }))}>All roles</button>
          {roles.map(r => (
            <button type="button" key={r} className={`chip${view.role === r ? " on" : ""}`}
                    onClick={() => setView(v => ({ ...v, role: v.role === r ? "" : r }))}>{ROLE_LABEL[r] || r}</button>))}
          <span style={{ flex: 1 }} />
          <label className="check"><input type="checkbox" checked={view.idle}
                 onChange={e => setView(v => ({ ...v, idle: e.target.checked }))} /> Show deactivated</label>
        </div>
        <div className="table-wrap">
          <table className="pkg-table act-table work-table">
            <thead>
              <tr className="groups"><th /><th colSpan={6}>Annotation (own packages)</th>
                <th colSpan={2}>Reviews made</th><th colSpan={3}>Dataset cleaning</th></tr>
              <tr><th>User</th>
                <th className="num gs">Speech</th><th className="num">Done</th><th className="num" title="Packages still being annotated">Open</th>
                <th className="num" title="Times a reviewer returned one of their packages">Returned</th>
                <th className="num">Accepted</th><th className="num" title="Speech time of their accepted packages">Acc. speech</th>
                <th className="num gs">Accepted</th><th className="num">Returned</th>
                <th className="num gs">Accepted</th><th className="num">Rejected</th><th className="num">Speech</th></tr>
            </thead>
            <tbody>
              {users.map(u => {
                const a = u.annotation, r = u.review, c = u.cleaning;
                return (
                  <tr key={u.username} className={u.active ? "" : "inactive"}>
                    <td title={u.username}><b className="nowrap">{u.name}{u.deleted && " (deleted)"}</b>
                      <div className="pkg-sub">{u.role && <span className={`role-pill r-${u.role}`}>{ROLE_LABEL[u.role] || u.role}</span>}</div></td>
                    <td className="num strong gs nowrap">{dur(a.done_seconds)}</td>
                    <td className="num">{a.done}</td>
                    <td className="num">{a.in_progress}</td>
                    <td className={`num${a.returned ? " bad" : ""}`}>{a.returned}
                      {a.done > 0 && a.returned > 0 && <div className="pkg-sub">{pct(a.returned, a.done)}% of done</div>}</td>
                    <td className="num ok">{a.accepted}</td>
                    <td className="num nowrap">{dur(a.accepted_seconds)}</td>
                    <td className="num gs">{r.accepted + r.inspected}</td>
                    <td className="num">{r.returned}</td>
                    <td className="num gs">{c.accepted}</td>
                    <td className={`num${c.rejected ? " bad" : ""}`}>{c.rejected}</td>
                    <td className="num nowrap">{dur(c.accepted_seconds)}</td>
                  </tr>
                );
              })}
              {!users.length && <tr><td colSpan={12} className="empty">No user matches.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted work-note">Done = packages the user annotated and completed (counted on their last edit).
          Returned = times a reviewer sent one of their packages back. Accepted = their packages that
          the reviewer accepted. Speech = speech time of the packages (deleted segments left out).</p>
      </div>
    </>
  );
}
