"use client";
// Sign in. There is no sign-up: the administrator (ADMIN_USERNAME / ADMIN_PASSWORD in .env) adds every account with a
// default password, which its owner replaces on /change-password at the first sign-in.
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthLayout } from "@/components/AuthLayout";
import { Icon } from "@/components/Icon";
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
    getJson<{ user: Me | null }>("/api/auth/me")
      .then(j => j.user ? router.replace(next(j.user)) : setReady(true))
      .catch(() => { setReady(true); setErr("Cannot reach the server - is the Flask backend (python app.py) running?"); });
  }, [router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const j = await api<{ user: Me }>("/api/auth/login", { username: f.username.trim(), password: f.password });
      router.replace(next(j.user));
    } catch (x: any) { setErr(x.message); setBusy(false); }
  };

  return (
    <AuthLayout>
      {ready && <form className="auth-card" id="loginForm" onSubmit={submit} noValidate>
        <div className="auth-head"><h1>Welcome back</h1><p>Sign in to continue to your workspace.</p></div>
        <label className="fld"><span>User name</span>
          <input id="lgUser" autoComplete="username" autoCapitalize="none" required autoFocus value={f.username}
                 onChange={e => setF({ ...f, username: e.target.value })} /></label>
        <label className="fld"><span>Password</span>
          <input id="lgPass" type="password" autoComplete="current-password" required value={f.password}
                 onChange={e => setF({ ...f, password: e.target.value })} /></label>
        <div className="errmsg" role="alert">{err}</div>
        <button type="submit" id="lgOk" className="auth-submit" disabled={busy || !f.username || !f.password}>
          {busy ? <><Icon name="loader" className="spin" /> Signing in…</> : "Sign in"}</button>
      </form>}
    </AuthLayout>
  );
}
