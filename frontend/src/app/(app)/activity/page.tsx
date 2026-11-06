"use client";
// Activity & Status (Administrator only): every user of every role with their status (online, signed out, never
// signed in, default password, deactivated) and how much they did today / this week, and the full activity log
// (sign-ins, wrong passwords, every change) with filters. Refreshes every 30 s. ReportPanel downloads an Excel report
// of everyone for a week, a month or any period.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DateRangePicker } from "@/components/DateRangePicker";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icon-sprite";
import { Pager } from "@/components/Pager";
import { useNotify } from "@/components/notify";
import { ROLE_LABEL, useCrumbs, useSession } from "@/components/session";
import { getJson } from "@/lib/api";

type Status = "online" | "offline" | "never" | "default_password" | "deactivated";
interface UserStatus {
  username: string; name: string; role: string; active: boolean; status: Status; must_change: boolean;
  last_login: string | null; last_seen: string | null; last_action: string | null;
  actions_today: number; actions_week: number; failed_today: number;
}
interface Overview {
  users: UserStatus[]; today: string; actions: { id: string; label: string }[];
  totals: { users: number; online: number; active_today: number; idle_today: number; default_password: number;
            never: number; failed_today: number; by_role: Record<string, number> };
}
interface Entry { id: number; at: string; username: string; role: string; action: string; label: string;
                  detail: string; ok: boolean; ip: string; count: number }
interface Log { entries: Entry[]; total: number; page: number; pages: number }

const STATUS: Record<Status, [string, string]> = {
  online: ["Online", "done"], offline: ["Signed out", ""], never: ["Never signed in", "error"],
  default_password: ["Default password", "running"], deactivated: ["Deactivated", "skipped"],
};
const NO_FILTER = { username: "", role: "", action: "", since: "", until: "", q: "" };

export default function ActivityPage() {
  useCrumbs([["Administration"], ["Activity & Status"]]);
  const { can } = useSession();
  const { notify } = useNotify();
  const router = useRouter();
  const [over, setOver] = useState<Overview | null>(null);
  const [log, setLog] = useState<Log | null>(null);
  const [filter, setFilter] = useState(NO_FILTER);
  const [page, setPage] = useState(1);
  const [per, setPer] = useState(50);
  const [userView, setUserView] = useState({ role: "", status: "", q: "" });

  useEffect(() => {   // /activity?user=ana (from Users & Roles)
    const u = new URLSearchParams(location.search).get("user");
    if (u) setFilter(f => ({ ...f, username: u }));
  }, []);

  const loadOverview = useCallback(() => getJson<Overview>("/api/activity/overview").then(setOver), []);
  const loadLog = useCallback(() => {
    const qs = new URLSearchParams({ ...filter, page: String(page), per: String(per) });
    return getJson<Log>(`/api/activity?${qs}`).then(setLog);
  }, [filter, page, per]);

  useEffect(() => {
    if (!can("users.manage")) { router.replace("/tasks"); return; }
    const all = () => Promise.all([loadOverview(), loadLog()]).catch(e => notify(e.message, "error"));
    all();
    const t = setInterval(all, 30000);
    return () => clearInterval(t);
  }, [can, router, loadOverview, loadLog, notify]);

  const set = (k: keyof typeof NO_FILTER, v: string) => { setFilter(f => ({ ...f, [k]: v })); setPage(1); };
  const showUser = (username: string) => {
    set("username", username);
    document.getElementById("actLog")?.scrollIntoView({ behavior: "smooth" });
  };

  const users = useMemo(() => (over?.users || []).filter(u =>
    (!userView.role || u.role === userView.role) &&
    // the same rules as the cards' counts
    (!userView.status || (userView.status === "idle" ? u.active && u.actions_today === 0
                          : userView.status === "default_password" ? u.active && u.must_change
                          : u.active && u.status === userView.status)) &&
    (!userView.q || `${u.username} ${u.name}`.toLowerCase().includes(userView.q.toLowerCase()))), [over, userView]);

  if (!over) return <div className="boot muted">Loading…</div>;
  const t = over.totals;
  const cards: { label: string; value: number; icon: IconName; tone?: string; status?: string }[] = [
    { label: "Active accounts", value: t.users, icon: "users" },
    { label: "Online now", value: t.online, icon: "check-circle", tone: "ok", status: "online" },
    { label: "Worked today", value: t.active_today, icon: "dashboard", tone: "ok" },
    { label: "No activity today", value: t.idle_today, icon: "clock", tone: t.idle_today ? "warn" : "", status: "idle" },
    { label: "Default password", value: t.default_password, icon: "shield", tone: t.default_password ? "warn" : "", status: "default_password" },
    { label: "Never signed in", value: t.never, icon: "inbox", tone: t.never ? "warn" : "", status: "never" },
    { label: "Wrong passwords today", value: t.failed_today, icon: "alert", tone: t.failed_today ? "err" : "" },
  ];

  return (
    <section className="activity">
      <div className="panel headcard act-head">
        <div>
          <h2>Activity &amp; Status</h2>
          <p>Every account of every role: who is online, who worked today and who did not, who still has the default
            password, and everything that was done. Updates every 30 seconds.</p>
        </div>
        <button className="sec" onClick={() => Promise.all([loadOverview(), loadLog()]).catch(e => notify(e.message, "error"))}>
          <Icon name="restore" /> Refresh</button>
      </div>

      <ReportPanel today={over.today} />

      <div className="act-cards">
        {cards.map(c => (
          <button key={c.label} type="button" className={`act-card ${c.tone || ""}${c.status && userView.status === c.status ? " on" : ""}`}
                  disabled={!c.status} onClick={() => c.status && setUserView(v => ({ ...v, status: v.status === c.status ? "" : c.status! }))}>
            <Icon name={c.icon} /><b>{c.value}</b><span>{c.label}</span>
          </button>
        ))}
      </div>

      <div className="panel">
        <div className="act-bar">
          <b className="sec-title"><Icon name="users" /> Users ({users.length})</b>
          <span style={{ flex: 1 }} />
          <div className="act-roles">
            <button type="button" className={`chip${!userView.role ? " on" : ""}`} onClick={() => setUserView(v => ({ ...v, role: "" }))}>All roles</button>
            {Object.entries(t.by_role).map(([r, n]) => (
              <button type="button" key={r} className={`chip${userView.role === r ? " on" : ""}`}
                      onClick={() => setUserView(v => ({ ...v, role: v.role === r ? "" : r }))}>{ROLE_LABEL[r] || r} <span>{n}</span></button>
            ))}
          </div>
          {(userView.role || userView.status || userView.q) && <button type="button" className="sec" onClick={() => setUserView({ role: "", status: "", q: "" })}>Clear</button>}
          <input type="search" placeholder="Search user" value={userView.q} onChange={e => setUserView(v => ({ ...v, q: e.target.value }))} />
        </div>
        <div className="table-wrap">
          <table className="pkg-table act-table">
            <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Last seen</th><th>Last work</th>
              <th className="num">Today</th><th className="num">7 days</th><th className="num">Wrong passwords</th><th /></tr></thead>
            <tbody>
              {users.map(u => {
                const [label, cls] = STATUS[u.status];
                const idle = u.active && u.actions_today === 0;
                return (
                  <tr key={u.username} className={u.active ? "" : "inactive"}>
                    <td><b>{u.name}</b><div className="pkg-sub">{u.username}</div></td>
                    <td><span className={`role-pill r-${u.role}`}>{ROLE_LABEL[u.role] || u.role}</span></td>
                    <td><span className={`st ${cls}`}>{label}</span>
                      {u.must_change && u.status !== "default_password" && <div className="pkg-sub">default password</div>}</td>
                    <td>{u.last_login || <span className="muted">Never</span>}</td>
                    <td>{u.last_seen || <span className="muted">-</span>}</td>
                    <td>{u.last_action || <span className="muted">Nothing yet</span>}</td>
                    <td className={`num${idle ? " idle" : ""}`}>{u.actions_today || (idle ? "none" : 0)}</td>
                    <td className="num">{u.actions_week}</td>
                    <td className={`num${u.failed_today ? " bad" : ""}`}>{u.failed_today}</td>
                    <td><a onClick={() => showUser(u.username)}>Log</a></td>
                  </tr>
                );
              })}
              {!users.length && <tr><td colSpan={10} className="empty">No user matches.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel" id="actLog">
        <b className="sec-title"><Icon name="file" /> Activity log{log ? <span className="count-note" style={{ fontWeight: 400 }}>{log.total} entries</span> : null}</b>
        <div className="act-filters">
          <select aria-label="User" value={filter.username} onChange={e => set("username", e.target.value)}>
            <option value="">Every user</option>
            {over.users.map(u => <option key={u.username} value={u.username}>{u.name} ({u.username})</option>)}
          </select>
          <select aria-label="Role" value={filter.role} onChange={e => set("role", e.target.value)}>
            <option value="">Every role</option>
            {Object.keys(t.by_role).map(r => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}
          </select>
          <select aria-label="Action" value={filter.action} onChange={e => set("action", e.target.value)}>
            <option value="">Every action</option>
            {over.actions.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          <DateRangePicker label="Log dates" since={filter.since} until={filter.until} max={over.today}
                           onChange={(since, until) => { setFilter(f => ({ ...f, since, until })); setPage(1); }} />
          <input type="search" placeholder="Search details" value={filter.q} onChange={e => set("q", e.target.value)} />
          <button type="button" className="sec small" disabled={JSON.stringify(filter) === JSON.stringify(NO_FILTER)}
                  onClick={() => { setFilter(NO_FILTER); setPage(1); }}>Clear</button>
        </div>
        <div className="table-wrap">
          <table className="pkg-table act-table">
            <thead><tr><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Details</th><th>Result</th><th>IP</th></tr></thead>
            <tbody>
              {log?.entries.map(e => (
                <tr key={e.id} className={e.ok ? "" : "refused"}>
                  <td className="nowrap">{e.at}</td>
                  <td><a onClick={() => set("username", e.username)}>{e.username}</a></td>
                  <td>{e.role ? ROLE_LABEL[e.role] || e.role : ""}</td>
                  <td>{e.label}{e.count > 1 && <span className="pill">×{e.count}</span>}</td>
                  <td className="act-detail">{e.detail}</td>
                  <td>{e.ok ? <span className="st done">OK</span> : <span className="st error">Refused</span>}</td>
                  <td className="muted">{e.ip}</td>
                </tr>
              ))}
              {log && !log.entries.length && <tr><td colSpan={7} className="empty">Nothing logged for these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        {log && <Pager page={log.page} pages={log.pages} onPage={setPage} label={`${log.total} entries`}
                       perPage={per} perOptions={[25, 50, 100, 200]} onPer={n => { setPer(n); setPage(1); }} />}
      </div>
    </section>
  );
}

// ---------- Excel report ----------
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const day = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtDay = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

/** The last 12 weeks (Monday - Sunday) and months, newest first: [a day in it, label]. */
function periods(today: string) {
  const t = day(today), mon = new Date(t);
  mon.setDate(t.getDate() - (t.getDay() + 6) % 7);
  const weeks = Array.from({ length: 12 }, (_, k) => {
    const a = new Date(mon); a.setDate(mon.getDate() - 7 * k);
    const b = new Date(a); b.setDate(a.getDate() + 6);
    return [iso(a), `${k === 0 ? "This week" : k === 1 ? "Last week" : "Week of"} · ${fmtDay(a)} – ${fmtDay(b)}`];
  });
  const months = Array.from({ length: 12 }, (_, k) => {
    const a = new Date(t.getFullYear(), t.getMonth() - k, 1);
    return [iso(a), a.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) + (k === 0 ? " (this month)" : "")];
  });
  return { weeks, months };
}

function ReportPanel({ today }: { today: string }) {
  const { notify } = useNotify();
  const { weeks, months } = useMemo(() => periods(today), [today]);
  const [kind, setKind] = useState<"week" | "month" | "custom">("week");
  const [pick, setPick] = useState({ week: weeks[0][0], month: months[0][0], since: today.slice(0, 8) + "01", until: today });
  const [busy, setBusy] = useState(false);

  const qs = kind === "custom" ? `period=custom&since=${pick.since}&until=${pick.until}` : `period=${kind}&date=${pick[kind]}`;
  const get = async () => {
    if (kind === "custom" && (!pick.since || !pick.until)) return notify("Choose the first and the last day.", "warn");
    setBusy(true);
    try {   // fetched here (not a plain link), so an error shows as a message instead of a broken file
      const r = await fetch(`/api/activity/report?${qs}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const name = /filename="?([^";]+)/.exec(r.headers.get("Content-Disposition") || "")?.[1] || "activity_report.xlsx";
      const url = URL.createObjectURL(await r.blob()), a = document.createElement("a");
      a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e: any) { notify("Cannot make the report: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  return (
    <div className="panel report-panel">
      <div className="act-bar">
        <b className="sec-title"><Icon name="download" /> Download report (Excel)</b>
        <span className="muted">Everyone&apos;s status, sign-ins, actions per day, annotation / review / cleaning work and the full log for the period.</span>
      </div>
      <div className="report-row">
        <div className="presets" role="group" aria-label="Report period">
          {(["week", "month", "custom"] as const).map(k => (
            <button key={k} type="button" className={`sec preset${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>
              {{ week: "Weekly", month: "Monthly", custom: "Custom" }[k]}</button>))}
        </div>
        {kind === "week" && <select aria-label="Week" value={pick.week} onChange={e => setPick({ ...pick, week: e.target.value })}>
          {weeks.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
        {kind === "month" && <select aria-label="Month" value={pick.month} onChange={e => setPick({ ...pick, month: e.target.value })}>
          {months.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
        {kind === "custom" && <DateRangePicker label="Report dates" since={pick.since} until={pick.until} max={today} placeholder="Choose the dates"
                                                onChange={(since, until) => setPick({ ...pick, since, until })} />}
        <button type="button" onClick={get} disabled={busy}>
          {busy ? <><Icon name="loader" className="spin" /> Preparing…</> : <><Icon name="download" /> Download .xlsx</>}</button>
      </div>
    </div>
  );
}
