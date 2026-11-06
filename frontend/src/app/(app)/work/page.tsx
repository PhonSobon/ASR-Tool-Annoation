"use client";
// Work Dashboard (Administrator only): what every user produced in a period - hours annotated, packages completed,
// returned (errors) and accepted, the reviews they made and the dataset clips they cleaned. Read from the work
// itself (GET /api/activity/work), not from the activity log.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DateRangePicker } from "@/components/DateRangePicker";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icon-sprite";
import { useNotify } from "@/components/notify";
import { ROLE_LABEL, useCrumbs, useSession } from "@/components/session";
import { getJson } from "@/lib/api";
import { fmtHms } from "@/lib/format";

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
const hours = (s: number) => s ? fmtHms(s) : "-";
const hasWork = (u: UserWork) => [u.annotation, u.review, u.cleaning].some(g => Object.values(g).some(v => v > 0));
/** returns per completed package, in % */
const errorRate = (u: UserWork) => u.annotation.done ? Math.round(100 * u.annotation.returned / u.annotation.done) : null;

export default function WorkPage() {
  useCrumbs([["Administration"], ["Work Dashboard"]]);
  const { can } = useSession();
  const { notify } = useNotify();
  const router = useRouter();
  const [work, setWork] = useState<Work | null>(null);
  const [range, setRange] = useState({ since: "", until: "" });
  const [view, setView] = useState({ role: "", q: "", sort: "hours", idle: false });

  const load = useCallback(() => {
    const qs = new URLSearchParams(range);
    return getJson<Work>(`/api/activity/work?${qs}`).then(setWork).catch(e => notify(e.message, "error"));
  }, [range, notify]);

  useEffect(() => {
    if (!can("users.manage")) { router.replace("/tasks"); return; }
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [can, router, load]);

  const users = useMemo(() => {
    const key = SORTS[view.sort][1];
    return (work?.users || []).filter(u =>
      (!view.role || u.role === view.role) && (view.idle || hasWork(u) || u.active) &&
      (!view.q || `${u.username} ${u.name}`.toLowerCase().includes(view.q.toLowerCase())))
      .sort((a, b) => key(b) - key(a) || a.username.localeCompare(b.username));
  }, [work, view]);

  if (!work) return <div className="boot muted">Loading…</div>;
  const t = work.totals;
  const cards: { label: string; value: string | number; icon: IconName; tone?: string }[] = [
    { label: "Hours annotated", value: hours(t.done_seconds), icon: "clock" },
    { label: "Packages done", value: t.done, icon: "check" },
    { label: "In progress", value: t.in_progress, icon: "loader", tone: t.in_progress ? "warn" : "" },
    { label: "Returned (errors)", value: t.returned, icon: "alert", tone: t.returned ? "err" : "" },
    { label: "Accepted", value: t.accepted, icon: "check-circle", tone: "ok" },
    { label: "Accepted hours", value: hours(t.accepted_seconds), icon: "clock", tone: "ok" },
    { label: "Clips accepted", value: t.clips_accepted, icon: "database", tone: "ok" },
    { label: "Clips rejected", value: t.clips_rejected, icon: "x", tone: t.clips_rejected ? "err" : "" },
  ];
  const roles = Array.from(new Set(work.users.map(u => u.role).filter(Boolean)));
  const period = PERIODS.find(p => p.since() === range.since && !range.until);

  return (
    <section className="activity">
      <div className="panel headcard act-head">
        <div>
          <h2>Work Dashboard</h2>
          <p>What every user produced: hours annotated, packages completed, returned to the annotator (errors) and
            accepted, the reviews they made and the dataset clips they cleaned. Updates every minute.</p>
        </div>
        <button className="sec" onClick={load}><Icon name="restore" /> Refresh</button>
      </div>

      <div className="act-filters">
        {PERIODS.map(p => (
          <button key={p.label} type="button" className={`chip${period === p ? " on" : ""}`}
                  onClick={() => setRange({ since: p.since(), until: "" })}>{p.label}</button>
        ))}
        <DateRangePicker label="Work dates" since={range.since} until={range.until} onChange={(since, until) => setRange({ since, until })} />
      </div>

      <div className="act-cards">
        {cards.map(c => (
          <div key={c.label} className={`act-card ${c.tone || ""}`}><Icon name={c.icon} /><b>{c.value}</b><span>{c.label}</span></div>
        ))}
      </div>

      <div className="panel">
        <div className="act-bar">
          <b className="sec-title"><Icon name="users" /> Users ({users.length})</b>
          <span style={{ flex: 1 }} />
          <div className="act-roles">
            <button type="button" className={`chip${!view.role ? " on" : ""}`} onClick={() => setView(v => ({ ...v, role: "" }))}>All roles</button>
            {roles.map(r => (
              <button type="button" key={r} className={`chip${view.role === r ? " on" : ""}`}
                      onClick={() => setView(v => ({ ...v, role: v.role === r ? "" : r }))}>{ROLE_LABEL[r] || r}</button>
            ))}
          </div>
          <select aria-label="Sort by" value={view.sort} onChange={e => setView(v => ({ ...v, sort: e.target.value }))}>
            {Object.entries(SORTS).map(([k, [label]]) => <option key={k} value={k}>Sort: {label}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={view.idle}
                 onChange={e => setView(v => ({ ...v, idle: e.target.checked }))} /> Show deactivated</label>
          <input type="search" placeholder="Search user" value={view.q} onChange={e => setView(v => ({ ...v, q: e.target.value }))} />
        </div>
        <div className="table-wrap">
          <table className="pkg-table act-table work-table">
            <thead>
              <tr className="groups"><th colSpan={2} /><th colSpan={6}>Annotation (own packages)</th>
                <th colSpan={3}>Reviews made</th><th colSpan={3}>Dataset cleaning</th></tr>
              <tr><th>User</th><th>Role</th>
                <th className="num">Hours</th><th className="num">Done</th><th className="num">In progress</th>
                <th className="num" title="Times their packages were returned by an inspector or acceptor">Returned</th>
                <th className="num">Accepted</th><th className="num">Accepted hours</th>
                <th className="num">Passed</th><th className="num">Accepted</th><th className="num">Returned</th>
                <th className="num">Accepted</th><th className="num">Rejected</th><th className="num">Hours</th></tr>
            </thead>
            <tbody>
              {users.map(u => {
                const a = u.annotation, r = u.review, c = u.cleaning, rate = errorRate(u);
                return (
                  <tr key={u.username} className={u.active ? "" : "inactive"}>
                    <td><b>{u.name}</b><div className="pkg-sub">{u.username}{u.deleted && " (deleted)"}</div></td>
                    <td>{u.role && <span className={`role-pill r-${u.role}`}>{ROLE_LABEL[u.role] || u.role}</span>}</td>
                    <td className="num strong">{hours(a.done_seconds)}</td>
                    <td className="num">{a.done}</td>
                    <td className="num">{a.in_progress}</td>
                    <td className={`num${a.returned ? " bad" : ""}`}>{a.returned}
                      {rate !== null && a.returned > 0 && <div className="pkg-sub">{rate}% of done</div>}</td>
                    <td className="num ok">{a.accepted}</td>
                    <td className="num">{hours(a.accepted_seconds)}</td>
                    <td className="num">{r.inspected}</td>
                    <td className="num">{r.accepted}</td>
                    <td className="num">{r.returned}</td>
                    <td className="num">{c.accepted}</td>
                    <td className={`num${c.rejected ? " bad" : ""}`}>{c.rejected}</td>
                    <td className="num">{hours(c.accepted_seconds)}</td>
                  </tr>
                );
              })}
              {!users.length && <tr><td colSpan={14} className="empty">No user matches.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted work-note">Done = packages the user annotated and completed (counted on their last edit).
          Returned = times an inspector or acceptor sent one of their packages back. Accepted = their packages that
          passed final acceptance. Hours are speech time of the packages (deleted segments left out).</p>
      </div>
    </section>
  );
}
