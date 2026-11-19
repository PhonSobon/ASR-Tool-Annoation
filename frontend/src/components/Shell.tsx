"use client";
// Platform shell: top bar (brand, save status, account menu), left menu, breadcrumbs.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { isStrong, MAX_PASSWORD } from "@/lib/password";
import { roleInfo } from "@/lib/roles";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { PasswordRules } from "./PasswordRules";
import type { IconName } from "./icon-sprite";
import { useNotify } from "./notify";
import { useSession } from "./session";
import { ThemeSwitch } from "./theme";

// Every link has its own icon; the group headings are plain labels. The Dashboard has a Projects and (for
// administrators) a Team tab - the former Work Dashboard (/work redirects there).
const MENU: { head: string; perm?: string; items: { href: string; label: string; icon: IconName; perm?: string }[] }[] = [
  { head: "Workbench", items: [{ href: "/dashboard", label: "Dashboard", icon: "chart", perm: "task.manage" },
                               { href: "/tasks", label: "My Tasks", icon: "list-checks" }] },
  { head: "Data", perm: "audio.upload", items: [{ href: "/upload", label: "Load Data", icon: "upload" },
                                                { href: "/duplicates", label: "Duplicates", icon: "copy", perm: "task.manage" }] },
  { head: "Administration", perm: "users.manage",
    items: [{ href: "/users", label: "Users & Roles", icon: "users" },
            { href: "/activity", label: "Activity & Status", icon: "activity" }] },
];

export function Shell({ children }: { children: ReactNode }) {
  const { me, can, crumbs, save } = useSession();
  const path = usePathname();
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [side, setSide] = useState<"" | "hidden" | "open">("");
  const [menu, setMenu] = useState(false);
  const [pw, setPw] = useState(false);

  useEffect(() => { document.body.classList.toggle("side-hidden", side === "hidden"); document.body.classList.toggle("side-open", side === "open"); }, [side]);
  useEffect(() => { setSide(s => s === "open" ? "" : s); }, [path]);
  useEffect(() => {                                            // phones: Esc closes the open menu
    if (side !== "open") return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setSide(""); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [side]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!(e.target as Element).closest(".me")) setMenu(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);

  const logout = async () => {
    window.dispatchEvent(new Event("app:flush"));     // pages save what is still pending
    await new Promise(r => setTimeout(r, 300));
    await api("/api/auth/logout").catch(() => {});
    location.href = "/login";
  };

  return (
    <>
      <div className="layout">
        {side === "open" && <div className="side-backdrop" aria-hidden="true" onClick={() => setSide("")} />}
        <nav className="sidebar" aria-label="Main menu">
          <Link className="brand" href="/tasks">
            <Logo />
            <span>Data Annotation Platform</span>
          </Link>
          {MENU.filter(g => !g.perm || can(g.perm)).map(g => (
            <div key={g.head} className={`nav-group${closed.has(g.head) ? " closed" : ""}`}>
              <button className="nav-head" type="button" onClick={() => setClosed(c => {
                const n = new Set(c); n.has(g.head) ? n.delete(g.head) : n.add(g.head); return n; })}>
                {g.head} <span className="caret"><Icon name="chevron-up" /></span>
              </button>
              {g.items.filter(it => !it.perm || can(it.perm)).map(it => (
                <Link key={it.href} className={`nav-item${path === it.href || path.startsWith(it.href + "/") ? " on" : ""}`} href={it.href}>
                  <Icon name={it.icon} /> {it.label}</Link>
              ))}
            </div>
          ))}
          <div className="side-foot"><b>{me.name || me.username}</b>{me.role_label}</div>
        </nav>

        <div className="content">
          <header className="appbar">
            <button className="crumb-toggle" title="Show / hide menu" aria-label="Show / hide menu"
                    onClick={() => setSide(s => matchMedia("(max-width:800px)").matches ? (s === "open" ? "" : "open") : (s === "hidden" ? "" : "hidden"))}>
              <Icon name="menu" />
            </button>
            <div className="crumbs">
              {crumbs.map(([label, href], k) => (
                <Fragment key={k}>
                  {k > 0 && <span className="crumb-sep"><Icon name="chevron-right" /></span>}
                  {href ? <Link href={href}>{label}</Link> : <span>{label}</span>}
                </Fragment>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            <span className={`save-state${save.kind === "err" ? " err" : ""}`}>
              {save.text && save.kind === "ok" && <Icon name="check" />}{save.text && save.kind === "err" && <Icon name="alert" />}{save.text}
            </span>
            <ThemeSwitch className="bar-theme" />
            <div className="me">
              <button className="avatar" type="button" aria-haspopup="menu" aria-label="Your account" title={`${me.name} (${me.role_label})`}
                      onClick={() => setMenu(m => !m)}>{(me.name || me.username).trim()[0].toUpperCase()}</button>
              {menu && (
                <div className="me-menu" role="menu">
                  <div className="me-who"><b>{me.name}</b><span className="muted">{me.username}</span></div>
                  <div className={`me-role r-${me.role}`}><b><span className="role-mark" /> {me.role_label}</b>{roleInfo(me.role)?.summary}</div>
                  {me.role === "admin"
                    ? <div className="me-note muted">Your password is set by the system (.env) and cannot be changed here.</div>
                    : <button type="button" className="me-item" role="menuitem" onClick={() => { setMenu(false); setPw(true); }}>Change password</button>}
                  <div className="me-theme"><span>Theme</span><ThemeSwitch labels /></div>
                  <Link className="me-item" role="menuitem" href="/" onClick={() => setMenu(false)}>Home page</Link>
                  <button type="button" className="me-item" role="menuitem" onClick={logout}>Sign out</button>
                </div>
              )}
            </div>
          </header>
          <main className="main">{children}</main>
        </div>
      </div>
      {pw && <PasswordDialog onClose={() => setPw(false)} />}
    </>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const { notify } = useNotify();
  const { me } = useSession();
  const ref = useRef<HTMLDialogElement>(null);
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [err, setErr] = useState("");
  useEffect(() => { ref.current?.showModal(); }, []);
  const ok = async () => {
    if (f.next !== f.again) return setErr("The two new passwords are not the same.");
    try {
      await api("/api/auth/password", { current: f.current, new: f.next });
      notify("Password changed. Other browsers logged in as you are logged out.", "success");
      onClose();
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <dialog className="confirm" ref={ref} onClose={onClose}>
      <h3>Change password</h3>
      <label className="fld"><span>Current password</span>
        <input type="password" autoComplete="current-password" autoFocus value={f.current} onChange={e => setF({ ...f, current: e.target.value })} /></label>
      <label className="fld"><span>New password</span>
        <input type="password" autoComplete="new-password" maxLength={MAX_PASSWORD} value={f.next}
               onChange={e => setF({ ...f, next: e.target.value })} /></label>
      <PasswordRules password={f.next} username={me.username} />
      <label className="fld"><span>New password again</span>
        <input type="password" autoComplete="new-password" maxLength={MAX_PASSWORD} value={f.again}
               onChange={e => setF({ ...f, again: e.target.value })} /></label>
      <div className="errmsg">{err}</div>
      <div className="confirm-actions">
        <button type="button" className="sec" onClick={onClose}>Cancel</button>
        <button type="button" disabled={!f.current || !isStrong(f.next, me.username) || !f.again} onClick={ok}>Change</button>
      </div>
    </dialog>
  );
}
