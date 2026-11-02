"use client";
// First sign-in: replace the default password from the administrator with your own. Until then the server refuses
// every other request, so every page behind the login sends you here.
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PasswordRules } from "@/components/PasswordRules";
import { api, getJson } from "@/lib/api";
import { isStrong, MAX_PASSWORD } from "@/lib/password";
import type { Me } from "@/lib/types";

export default function ChangePasswordPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.body.classList.add("login-page");
    getJson<{ user: Me | null }>("/api/auth/me")
      .then(j => !j.user ? router.replace("/login") : j.user.must_change ? setMe(j.user) : router.replace("/tasks"))
      .catch(() => router.replace("/login"));
    return () => document.body.classList.remove("login-page");
  }, [router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.next !== f.again) return setErr("The two new passwords are not the same.");
    setErr(""); setBusy(true);
    try {
      await api("/api/auth/password", { current: f.current, new: f.next });
      router.replace("/tasks");
    } catch (x: any) { setErr(x.message); setBusy(false); }
  };

  const signOut = async () => { await api("/api/auth/logout").catch(() => {}); location.href = "/"; };

  if (!me) return null;
  return (
    <form className="login-card" onSubmit={submit} noValidate>
      <h1>Choose your password</h1>
      <p className="muted">Welcome, <b>{me.name}</b> ({me.role_label}). You signed in with the default password from your
        administrator. Choose your own to continue; nobody else, not even the administrator, will know it.</p>
      <label className="fld"><span>Default password</span>
        <input type="password" autoComplete="current-password" autoFocus required value={f.current}
               onChange={e => setF({ ...f, current: e.target.value })} /></label>
      <label className="fld"><span>New password</span>
        <input type="password" autoComplete="new-password" required maxLength={MAX_PASSWORD} value={f.next}
               onChange={e => setF({ ...f, next: e.target.value })} /></label>
      <PasswordRules password={f.next} username={me.username} />
      <label className="fld"><span>New password again</span>
        <input type="password" autoComplete="new-password" required maxLength={MAX_PASSWORD} value={f.again}
               onChange={e => setF({ ...f, again: e.target.value })} /></label>
      <div className="errmsg" role="alert">{err}</div>
      <button type="submit" disabled={busy || !f.current || !isStrong(f.next, me.username) || !f.again}>
        {busy ? "Saving…" : "Save and continue"}</button>
      <button type="button" className="link" onClick={signOut}>Sign out</button>
    </form>
  );
}
