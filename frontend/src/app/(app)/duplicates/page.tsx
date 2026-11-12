"use client";
// Duplicates (managers): audio that was uploaded or loaded twice - also converted, louder / quieter, or cut out of a
// longer recording. Each pair: the newer audio (the copy) next to the older one (the original), both playable from
// where the shared speech starts. Skip the copy's packages so nobody annotates (and is paid for) them twice, delete a
// copy still in Upload & Crop, or mark the pair as not a duplicate. GET /api/duplicates.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { useNotify } from "@/components/notify";
import { useCrumbs, useSession } from "@/components/session";
import { api, del, getJson } from "@/lib/api";
import { DUP_KIND } from "@/lib/duplicates";
import type { DupKind, Job } from "@/lib/types";

interface Side { id: string; name: string; duration: number; created: string; task_id: string | null; task: string | null; start: number }
interface Pkg { index: number; start: number; end: number; stage: string }
interface Pair { kind: DupKind; seconds: number; duplicate: Side & { packages: Pkg[] }; original: Side; also: number }
interface Report { pairs: Pair[]; missing: number; job: Job | null }

const STAGE: Record<string, string> = { annotating: "To annotate", returned: "Returned", inspecting: "To review", accepted: "Accepted", skipped: "Skipped" };
const open = (p: Pair) => p.duplicate.packages.filter(k => k.stage !== "skipped" && k.stage !== "accepted");
const needsAction = (p: Pair) => !p.duplicate.task_id || open(p).length > 0;
const secs = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
const at = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export default function DuplicatesPage() {
  useCrumbs([["Data"], ["Duplicates"]]);
  const { can } = useSession();
  const { notify } = useNotify();
  const router = useRouter();
  const [rep, setRep] = useState<Report | null>(null);
  const [show, setShow] = useState<"todo" | "all">("todo");
  const [busy, setBusy] = useState("");

  const load = useCallback(() => getJson<Report>("/api/duplicates").then(setRep)
    .catch(e => notify("Cannot load duplicates: " + e.message, "error")), [notify]);
  useEffect(() => {
    if (!can("task.manage")) { router.replace("/tasks"); return; }
    load();
  }, [can, router, load]);
  useEffect(() => {   // while the scan runs, follow it
    if (!rep?.job?.running) return;
    const t = setTimeout(load, 2000);
    return () => clearTimeout(t);
  }, [rep, load]);

  const pairs = useMemo(() => (rep?.pairs || []).filter(p => show === "all" || needsAction(p)), [rep, show]);
  if (!rep) return <div className="boot muted">Loading…</div>;
  const todo = rep.pairs.filter(needsAction).length;
  const openPkgs = rep.pairs.reduce((n, p) => n + open(p).length, 0);
  const shared = rep.pairs.reduce((n, p) => n + p.seconds, 0);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try { await fn(); notify(done, "success"); await load(); }
    catch (e: any) { notify(e.message, "error"); }
    finally { setBusy(""); }
  };
  const skip = (p: Pair) => act(p.duplicate.id + "skip", () => api("/api/duplicates/skip",
    { audio: p.duplicate.id, packages: open(p).map(k => k.index), original: p.original.id }),
    `Skipped ${open(p).length} package(s) of “${p.duplicate.name}”.`);
  const remove = (p: Pair) => {
    if (!confirm(`Delete “${p.duplicate.name}” from Upload & Crop? The original “${p.original.name}” stays.`)) return;
    act(p.duplicate.id + "del", () => del(`/api/audios/${p.duplicate.id}`), `Deleted “${p.duplicate.name}”.`);
  };
  const ignore = (p: Pair) => act(p.duplicate.id + "ign", () => api("/api/duplicates/ignore", { a: p.duplicate.id, b: p.original.id }),
    "Marked as not a duplicate.");

  return (
    <section className="activity dash dups">
      <header className="dash-head">
        <div>
          <h2>Duplicates</h2>
          <p>Audio that was uploaded or loaded more than once — also in another format, louder or quieter, or cut out of a
            longer recording. Skip the copies before anyone annotates them, so the same speech is not done and paid twice.</p>
        </div>
        <button className="sec" onClick={load}><Icon name="restore" /> Refresh</button>
      </header>

      {rep.job?.running && (
        <div className="panel dup-scan">
          <Icon name="loader" className="spin" />
          <div><b>Checking recordings from before duplicate detection…</b>
            <span className="muted">{rep.job.message}</span>
            <div className="kpi-bar"><div style={{ width: `${rep.job.total ? 100 * rep.job.done / rep.job.total : 0}%` }} /></div></div>
        </div>)}

      <div className="kpis">
        <div className={`kpi ${todo ? "err" : "ok"}`}>
          <div className="kpi-top"><span className="kpi-icon"><Icon name="copy" /></span>Need a decision</div>
          <div className="kpi-value">{todo}</div>
          <div className="kpi-sub">{rep.pairs.length} duplicate pair{rep.pairs.length === 1 ? "" : "s"} found in total</div>
        </div>
        <div className={`kpi ${openPkgs ? "warn" : ""}`}>
          <div className="kpi-top"><span className="kpi-icon"><Icon name="list-checks" /></span>Duplicate packages open</div>
          <div className="kpi-value">{openPkgs}</div>
          <div className="kpi-sub">still to annotate or review — skip them</div>
        </div>
        <div className="kpi">
          <div className="kpi-top"><span className="kpi-icon"><Icon name="clock" /></span>Duplicate speech</div>
          <div className="kpi-value">{secs(shared)}</div>
          <div className="kpi-sub">shared between the pairs</div>
        </div>
        <div className="kpi">
          <div className="kpi-top"><span className="kpi-icon"><Icon name="check-circle" /></span>Checked</div>
          <div className="kpi-value">{rep.missing ? "…" : "All"}</div>
          <div className="kpi-sub">{rep.missing ? `${rep.missing} recordings still being checked` : "every recording has a fingerprint"}</div>
        </div>
      </div>

      <div className="panel dash-panel">
        <div className="dash-title"><Icon name="copy" /><b>Pairs</b><span className="count">{pairs.length}</span>
          <span className="seg">
            <button type="button" className={show === "todo" ? "on" : ""} onClick={() => setShow("todo")}>Need a decision</button>
            <button type="button" className={show === "all" ? "on" : ""} onClick={() => setShow("all")}>All</button>
          </span>
        </div>

        {!pairs.length ? (
          <div className="dash-none"><Icon name="check-circle" />
            {rep.pairs.length ? "Every duplicate is handled." : rep.missing ? "Nothing found so far — still checking." : "No duplicate audio. Every recording is unique."}
          </div>
        ) : (
          <ul className="dup-list">
            {pairs.map(p => {
              const o = open(p), d = p.duplicate;
              return (
                <li key={d.id + p.original.id} className={needsAction(p) ? "todo" : ""}>
                  <div className="dup-head">
                    <span className={`pill ${p.kind === "identical" ? "err" : "warn"}`}>{DUP_KIND[p.kind]}</span>
                    <span className="muted">{secs(p.seconds)} of the same speech</span>
                    {p.also > 0 && <span className="muted">· also matches {p.also} other cop{p.also > 1 ? "ies" : "y"}</span>}
                  </div>
                  <div className="dup-sides">
                    <SideView label="Copy (newer)" s={d} />
                    <span className="dup-arrow" aria-hidden="true"><Icon name="arrow-right" /></span>
                    <SideView label="Original (older)" s={p.original} />
                  </div>
                  {d.task_id && (
                    <div className="dup-pkgs"><span className="muted">Packages of the copy in the shared part:</span>
                      {d.packages.length ? d.packages.map(k => (
                        <span key={k.index} className={`pill ${k.stage === "skipped" ? "" : k.stage === "accepted" ? "ok" : "warn"}`}
                              title={`${at(k.start)}–${at(k.end)}`}>#{k.index + 1} {STAGE[k.stage] || k.stage}</span>))
                        : <span className="muted">none</span>}
                    </div>)}
                  <div className="dup-actions">
                    {d.task_id ? (
                      <button disabled={!o.length || !!busy} onClick={() => skip(p)}
                              title="The packages leave the work: nobody annotates or reviews them (accepted ones stay)">
                        <Icon name="eye-off" /> {o.length ? `Skip ${o.length} package${o.length > 1 ? "s" : ""}` : "Nothing left to skip"}</button>
                    ) : (
                      <button className="stop" disabled={!!busy} onClick={() => remove(p)}><Icon name="trash" /> Delete the copy</button>
                    )}
                    <button className="sec" disabled={!!busy} onClick={() => ignore(p)}><Icon name="x" /> Not a duplicate</button>
                  </div>
                </li>);
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

function SideView({ label, s }: { label: string; s: Side }) {
  return (
    <div className="dup-side">
      <span className="dup-label">{label}</span>
      <b title={s.name}>{s.name}</b>
      <span className="muted">
        {s.task_id ? <Link href={`/tasks/${s.task_id}`}>{s.task || "task"}</Link> : "Upload & Crop"} · {s.created.slice(0, 16)} · {secs(s.duration)}
      </span>
      <audio controls preload="none" src={`/api/audios/${s.id}/audio#t=${s.start}`} />
      <span className="muted dup-from">plays from {at(s.start)}, where the shared speech starts</span>
    </div>
  );
}
