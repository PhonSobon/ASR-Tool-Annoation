"use client";
// Users & Roles (Administrator only): add users with a default password, change their full name and role in the
// table, deactivate, set a new default password, delete. Users replace the default with their own at the next sign-in; administrators do not change
// their own password (the one of .env is set there). The server keeps at least one active administrator.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { PasswordRules } from "@/components/PasswordRules";
import { RoleList } from "@/components/RoleList";
import { useNotify } from "@/components/notify";
import { ROLE_LABEL, useCrumbs, useSession } from "@/components/session";
import { api, del, getJson } from "@/lib/api";
import { isStrong, MAX_PASSWORD } from "@/lib/password";

interface UserRow {
  username: string; name: string; role: string; active: boolean; created: string;
  must_change: boolean; last_login: string | null; last_seen: string | null;
}
interface RoleRow { id: string; label: string; description: string; permissions: string[] }

const PERM_TEXT: Record<string, string> = {
  "users.manage": "Manage users and roles", "audio.upload": "Load Data, make tasks", "task.manage": "Assign people, delete tasks",
  "task.view_all": "See every task", "task.annotate": "Annotate packages", "task.review": "Review packages (accept / return)",
  "asr.run": "Run the ASR", "data.export": "Download ZIPs", "hub.push": "Push to Hugging Face",
  "dataset.manage": "Import / check / delete datasets", "dataset.view_all": "See every dataset",
  "dataset.review": "Review dataset clips", "dataset.bulk_accept": "Accept all passing clips",
};

const PERM_ORDER = Object.keys(PERM_TEXT);

export default function UsersPage() {
  useCrumbs([["Administration"], ["Users & Roles"]]);
  const { me, can } = useSession();
  const { notify, askConfirm } = useNotify();
  const router = useRouter();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [form, setForm] = useState({ username: "", name: "", role: "annotator", password: "" });
  const [err, setErr] = useState("");
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [envAdmin, setEnvAdmin] = useState("");
  const [view, setView] = useState({ q: "", role: "", status: "" });

  const load = useCallback(async () => {
    const j = await getJson<{ users: UserRow[]; roles: RoleRow[]; env_admin: string }>("/api/users");
    setUsers(j.users); setRoles(j.roles); setEnvAdmin(j.env_admin);
  }, []);
  useEffect(() => { if (!can("users.manage")) router.replace("/tasks"); else load().catch(e => notify(e.message, "error")); }, [can, router, load, notify]);

  const patch = async (username: string, changes: Record<string, unknown>, done: string) => {
    try { await api(`/api/users/${encodeURIComponent(username)}`, changes, "PATCH"); notify(done, "success"); }
    catch (e: any) { notify(e.message, "error"); }
    await load();
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      const u = await api("/api/users", { ...form, username: form.username.trim() });
      setForm({ username: "", name: "", role: form.role, password: "" });
      notify(u.must_change
        ? `${u.username} added as ${ROLE_LABEL[u.role]}. Give them their user name and the default password; they choose their own at the first sign-in.`
        : `${u.username} added as ${ROLE_LABEL[u.role]}.`, "success");
      await load();
    } catch (x: any) { setErr(x.message); }
  };

  const remove = async (u: UserRow) => {
    if (!await askConfirm(`Delete ${u.username}? Their name stays on the work they did. Deactivating keeps the account instead.`,
                          { title: "Delete user", ok: "Delete", danger: true })) return;
    try { await del(`/api/users/${encodeURIComponent(u.username)}`); notify(`${u.username} deleted.`, "success"); }
    catch (x: any) { notify(x.message, "error"); }
    await load();
  };

  const toggleActive = async (u: UserRow) => {
    if (u.active && !await askConfirm(`Deactivate ${u.username}? They are logged out and cannot log in until activated again. Their work stays.`,
                                      { title: "Deactivate user", ok: "Deactivate", danger: true })) return;
    patch(u.username, { active: !u.active }, `${u.username} ${u.active ? "deactivated" : "activated"}.`);
  };

  const ql = view.q.trim().toLowerCase();
  const shown = users.filter(u => (!ql || `${u.username} ${u.name}`.toLowerCase().includes(ql)) && (!view.role || u.role === view.role) &&
    (!view.status || (view.status === "active" ? u.active : view.status === "inactive" ? !u.active
                      : view.status === "default" ? u.active && u.must_change && u.role !== "admin" : !u.last_login)));
  const filtering = !!(ql || view.role || view.status);

  return (
    <section>
      <div className="panel headcard">
        <h2>Users &amp; Roles</h2>
        <p>There is no sign-up: you add every account here with a <b>default password</b>. Everyone except administrators
          must replace it with their own password the first time they sign in. The role decides what they can do; project
          managers then add annotators and reviewers to tasks and datasets.</p>
      </div>

      <div className="panel">
        <b className="sec-title"><Icon name="plus" /> Add a user</b>
        <form className="form-grid user-form" autoComplete="off" onSubmit={add}>
          <label className="fld"><span className="req">User name</span>
            <input placeholder="e.g. sokha" autoCapitalize="none" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} /></label>
          <label className="fld"><span>Full name</span>
            <input placeholder="e.g. Sok Sokha" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
          <label className="fld"><span className="req">Role</span>
            <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
              {roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select></label>
          <label className="fld"><span className="req">Default password (8-12 characters)</span>
            <input type="password" autoComplete="new-password" maxLength={MAX_PASSWORD} value={form.password}
                   onChange={e => setForm({ ...form, password: e.target.value })} /></label>
          <div className="fld"><span>&nbsp;</span>
            <button type="submit" disabled={!form.username.trim() || !isStrong(form.password, form.username)}><Icon name="plus" /> Add user</button></div>
        </form>
        {form.password && <PasswordRules password={form.password} username={form.username} />}
        <div className="errmsg">{err}</div>
      </div>

      <div className="panel">
        <div className="filter-bar">
          <div className="search sm"><input type="search" placeholder="Search name or user name" aria-label="Search users" value={view.q}
                                            onChange={e => setView(v => ({ ...v, q: e.target.value }))} />
            <button type="button" tabIndex={-1} aria-hidden="true"><Icon name="search" /></button></div>
          <select aria-label="Role" value={view.role} onChange={e => setView(v => ({ ...v, role: e.target.value }))}>
            <option value="">All roles</option>{roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
          <select aria-label="Status" value={view.status} onChange={e => setView(v => ({ ...v, status: e.target.value }))}>
            <option value="">Any status</option><option value="active">Active</option><option value="inactive">Deactivated</option>
            <option value="default">Default password not changed</option><option value="never">Never signed in</option></select>
          {filtering && <button type="button" className="sec" onClick={() => setView({ q: "", role: "", status: "" })}>Clear</button>}
          <span className="spacer" />
          <span className="count-note">{filtering ? `${shown.length} of ${users.length} users` : `${users.length} users`}</span>
        </div>
        <div className="table-wrap">
          <table className="pkg-table user-table">
            <thead><tr><th className="u-no">No.</th><th>Username</th><th>Full Name</th><th>Role</th><th>Status</th><th>Password</th>
              <th>Last sign-in</th><th>Created</th><th className="u-acts-h">Action</th></tr></thead>
            <tbody>
              {shown.map((u, k) => {
                const self = u.username === me.username;
                const fixedPw = self || u.username === envAdmin;
                return (
                  <tr key={u.username} className={u.active ? "" : "inactive"}>
                    <td className="u-no">{k + 1}</td>
                    <td><span className="u-name"><span className={`u-avatar r-${u.role}`} aria-hidden="true">{(u.name || u.username).trim()[0]?.toUpperCase()}</span>
                      <b>{u.username}</b>{self && <span className="pill">you</span>}</span></td>
                    <td><NameField user={u} onSave={name => patch(u.username, { name }, `Full name of ${u.username} saved.`)} /></td>
                    <td><select className="u-role" aria-label={`Role of ${u.username}`} disabled={self} value={u.role}
                                onChange={e => patch(u.username, { role: e.target.value }, `${u.username} is now ${ROLE_LABEL[e.target.value]}.`)}>
                      {roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select></td>
                    <td>{u.active ? <span className="st done">Active</span> : <span className="st skipped">Deactivated</span>}</td>
                    <td>{u.role === "admin" ? <span className="muted">{u.username === envAdmin ? "Set in .env" : "Set by admin"}</span>
                         : u.must_change ? <span className="st running">Default - not changed yet</span>
                         : <span className="st done">Own password</span>}</td>
                    <td>{u.last_login || <span className="muted">Never</span>}</td>
                    <td>{u.created}</td>
                    <td><div className="acts u-acts">
                      {!self && <button className="icon" title={u.active ? "Deactivate (they cannot sign in; their work stays)" : "Activate again"}
                                        aria-label={u.active ? `Deactivate ${u.username}` : `Activate ${u.username}`} onClick={() => toggleActive(u)}>
                        <Icon name={u.active ? "x" : "check-circle"} /></button>}
                      {!fixedPw && <button className="icon" title="Set a new default password" aria-label={`Set a default password for ${u.username}`}
                                           onClick={() => setPwFor(u.username)}><Icon name="shield" /></button>}
                      <a className="icon-link" title="Activity of this user" aria-label={`Activity of ${u.username}`}
                         href={`/activity?user=${encodeURIComponent(u.username)}`}><Icon name="clock" /></a>
                      {!self && <button className="icon u-del" title="Delete this user" aria-label={`Delete ${u.username}`} onClick={() => remove(u)}>
                        <Icon name="trash" /></button>}
                    </div></td>
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={9} className="empty">{filtering ? "No user matches these filters." : "No users yet."}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <b className="sec-title"><Icon name="shield" /> What each role can do</b>
        <div className="users-roles">
          <RoleList highlight={me.role} details={Object.fromEntries(roles.map(r => [r.id,
            <div className="role-perms" key={r.id}>{PERM_ORDER.filter(p => r.permissions.includes(p)).map(p =>
              <span key={p}>{PERM_TEXT[p] || p}</span>)}</div>]))} />
        </div>
      </div>

      {pwFor && <SetPassword username={pwFor} onClose={() => setPwFor(null)}
                             onSet={pw => { setPwFor(null); patch(pwFor, { password: pw }, `New default password set for ${pwFor}.`); }} />}
    </section>
  );
}

/** The full name, edited in the table: saved on Enter or when the field loses focus (Esc = undo). */
function NameField({ user, onSave }: { user: UserRow; onSave: (name: string) => void }) {
  const [v, setV] = useState(user.name);
  useEffect(() => setV(user.name), [user.name]);
  const save = () => { const t = v.trim(); if (!t) setV(user.name); else if (t !== user.name) onSave(t); };
  return <input className="u-fullname" aria-label={`Full name of ${user.username}`} value={v} maxLength={200}
                onChange={e => setV(e.target.value)} onBlur={save}
                onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setV(user.name); }} />;
}

function SetPassword({ username, onClose, onSet }: { username: string; onClose: () => void; onSet: (pw: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pw, setPw] = useState("");
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog className="confirm" ref={ref} onClose={onClose}>
      <h3>New default password for {username}</h3>
      <p className="muted">The user is signed out everywhere, signs in with this password and must then choose their own
        (an administrator keeps it).</p>
      <label className="fld"><span>Default password</span>
        <input type="password" autoComplete="new-password" autoFocus maxLength={MAX_PASSWORD} value={pw}
               onChange={e => setPw(e.target.value)} /></label>
      <PasswordRules password={pw} username={username} />
      <div className="confirm-actions">
        <button type="button" className="sec" onClick={onClose}>Cancel</button>
        <button type="button" disabled={!isStrong(pw, username)} onClick={() => onSet(pw)}>Set password</button>
      </div>
    </dialog>
  );
}
