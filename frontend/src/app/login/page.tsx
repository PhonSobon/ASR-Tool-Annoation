"use client";
// Sign in. There is no sign-up: the administrator (ADMIN_USERNAME / ADMIN_PASSWORD in .env) adds every account with a
// default password, which its owner replaces on /change-password at the first sign-in.
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DataBackdrop } from "@/components/DataBackdrop";
import { Logo } from "@/components/Logo";
import { api, getJson } from "@/lib/api";
import type { Me } from "@/lib/types";

const next = (u: Me) => u.must_change ? "/change-password" : "/tasks";

export default function LoginPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [f, setF] = useState({ username: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.body.classList.add("login-page");
    getJson<{ user: Me | null }>("/api/auth/me")
      .then(j => j.user ? router.replace(next(j.user)) : setReady(true))
      .catch(() => { setReady(true); setErr("Cannot reach the server - is the Flask backend (python app.py) running?"); });
    return () => document.body.classList.remove("login-page");
  }, [router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const j = await api<{ user: Me }>("/api/auth/login", { username: f.username.trim(), password: f.password });
      router.replace(next(j.user));
    } catch (x: any) { setErr(x.message); setBusy(false); }
  };

  if (!ready) return null;
  return (
    <>
      <DataBackdrop />
      <form className="login-card" id="loginForm" onSubmit={submit} noValidate>
        <Link className="login-brand" href="/">
          <Logo />
          <span>Data Annotation Platform</span>
        </Link>
        <h1>Sign in</h1>
        <label className="fld"><span>User name</span>
          <input id="lgUser" autoComplete="username" autoCapitalize="none" required autoFocus value={f.username}
                 onChange={e => setF({ ...f, username: e.target.value })} /></label>
        <label className="fld"><span>Password</span>
          <input id="lgPass" type="password" autoComplete="current-password" required value={f.password}
                 onChange={e => setF({ ...f, password: e.target.value })} /></label>
        <div className="errmsg" role="alert">{err}</div>
        <button type="submit" id="lgOk" disabled={busy || !f.username || !f.password}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="muted small-print">New here? Your administrator gives you a user name and a default password; you choose
          your own the first time you sign in. Forgot it? Ask your administrator for a new default.</p>
        <Link className="small-print back-home" href="/">← Back to home</Link>
      </form>
    </>
  );
}
