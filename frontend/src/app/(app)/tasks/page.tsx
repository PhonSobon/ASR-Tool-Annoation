"use client";
// My Tasks: one card per task the user may see, search, pagination, delete (managers). A manager pushes a task to
// the annotators (Push to annotators); they find it under "Available to pull" and join it with Pull dataset.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Pager } from "@/components/Pager";
import { useNotify } from "@/components/notify";
import { useCrumbs, useSession } from "@/components/session";
import { api, del, getJson } from "@/lib/api";
import { fmtDur } from "@/lib/format";
import type { TaskSummary } from "@/lib/types";

const PER_PAGE = 12;
/** the "Show" filter: which stage a task still has packages in */
const SHOW: Record<string, { label: string; test: (t: TaskSummary) => boolean }> = {
  todo: { label: "Has packages to annotate", test: t => t.stages.annotating + t.stages.returned > 0 },
  returned: { label: "Has returned packages", test: t => t.stages.returned > 0 },
  review: { label: "Waiting for review", test: t => t.stages.inspecting > 0 },
  finished: { label: "Finished (everything accepted)",
              test: t => t.stages.accepted > 0 && t.stages.annotating + t.stages.returned + t.stages.inspecting === 0 },
};

export default function TasksPage() {
  useCrumbs([["Workbench"], ["My Tasks"]]);
  const { can, nameOf } = useSession();
  const { notify, askConfirm } = useNotify();
  const router = useRouter();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [show, setShow] = useState("");
  const [page, setPage] = useState(1);
  const [pulling, setPulling] = useState(""), [sharing, setSharing] = useState("");

  const load = useCallback(async () => {
    try { setTasks((await getJson<{ tasks: TaskSummary[] }>("/api/tasks")).tasks); setError(""); }
    catch (e: any) { setTasks([]); setError("Cannot load tasks: " + e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const mine = (tasks || []).filter(t => !t.can_claim), open = (tasks || []).filter(t => t.can_claim);
  const ql = q.trim().toLowerCase();
  const list = mine.filter(t => (!ql || t.name.toLowerCase().includes(ql) || t.id.toLowerCase().includes(ql)) &&
                                         (!show || SHOW[show].test(t)));
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE)), cur = Math.min(page, pages);
  const shown = list.slice((cur - 1) * PER_PAGE, cur * PER_PAGE);

  const pull = async (t: TaskSummary) => {
    setPulling(t.id);
    try { await api(`/api/tasks/${t.id}/pull`); }
    catch (e: any) { setPulling(""); load(); return notify("Cannot pull: " + e.message, "error"); }
    notify(`You pulled “${t.name}” — it is in your tasks now.`, "success");
    router.push(`/tasks/${t.id}`);
  };

  const pushedTo = (t: TaskSummary) => !!t.open_roles?.includes("annotator");
  const pullers = (t: TaskSummary) => (t.pulled || []).filter(p => p.role === "annotator");
  const share = async (t: TaskSummary) => {
    const on = !pushedTo(t);
    setSharing(t.id);
    try {
      const r = await api<{ open_roles: string[] }>(`/api/tasks/${t.id}/share`, { annotator: on }, "PUT");
      setTasks(ts => (ts || []).map(x => x.id === t.id ? { ...x, open_roles: r.open_roles } : x));
      notify(on ? `“${t.name}” pushed: annotators can pull it now.` : `“${t.name}” taken back from annotators.`, "success");
    } catch (e: any) { notify("Cannot push: " + e.message, "error"); }
    finally { setSharing(""); }
  };

  const remove = async (t: TaskSummary) => {
    if (!await askConfirm(`Delete task “${t.name}”? Its ${t.audio_count} audio and all segments/text will be removed. This cannot be undone.`,
                          { title: "Delete task", ok: "Delete", danger: true })) return;
    try { await del(`/api/tasks/${t.id}`); } catch (e: any) { return notify("Delete failed: " + e.message, "error"); }
    notify(`Task “${t.name}” deleted.`, "success");
    setTasks(ts => (ts || []).filter(x => x.id !== t.id));
  };

  return (
    <section>
      <div className="panel headcard">
        <h2>My Tasks</h2>
        <p>Each task is a batch of audio pushed from Upload &amp; Crop. Annotators complete its packages and reviewers
          accept them or return them with a note.</p>
      </div>
      {open.length > 0 && (
        <div className="panel">
          <div className="toolbar"><b className="sec-title"><Icon name="inbox" /> Available to pull ({open.length})</b>
            <span className="muted">Datasets your manager pushed to you — pull one to start annotating it.</span></div>
          <div className="cards">
            {open.map(t => (
              <div className="task-card claim-card" key={t.id}>
                <div className="tc-tags">
                  <span className="tag">{t.audio_count} audio</span><span className="tag">{fmtDur(t.duration)}</span><span className="tag">{t.count} packages</span></div>
                <div className="tc-body">
                  <h3>{t.name}</h3>
                  <div className="tc-desc">Created {t.created}{t.created_by ? ` by ${t.created_by}` : ""}</div>
                  <div className="stats">
                    <span className="pill">To annotate {t.stages.annotating + t.stages.returned}</span>
                    <span className="pill">To review {t.stages.inspecting}</span>
                  </div>
                  <button className="claim-btn" disabled={!!pulling} onClick={() => pull(t)}>
                    <Icon name={pulling === t.id ? "loader" : "download"} className={pulling === t.id ? "spin" : ""} /> Pull dataset</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="panel">
        <div className="toolbar">
          <div className="search">
            <input type="search" placeholder="Search task name or ID" aria-label="Search tasks" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />
            <button type="button" tabIndex={-1} aria-hidden="true"><Icon name="search" /></button>
          </div>
          <select aria-label="Show" value={show} onChange={e => { setShow(e.target.value); setPage(1); }}>
            <option value="">All tasks</option>
            {Object.entries(SHOW).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
          </select>
          {(q || show) && <button type="button" className="sec" onClick={() => { setQ(""); setShow(""); setPage(1); }}>Clear</button>}
          <span className="spacer" />
          <span className="count-note">{list.length === mine.length ? `${list.length} tasks` : `${list.length} of ${mine.length} tasks`}</span>
          {can("audio.upload") && <button onClick={() => router.push("/upload")}><Icon name="plus" /> Load Data</button>}
        </div>
        <div className="cards">
          {shown.map(t => {
            const pct = t.done + t.todo ? Math.round(100 * t.done / (t.done + t.todo)) : 0;
            return (
              <div className="task-card" key={t.id} tabIndex={0} onClick={() => router.push(`/tasks/${t.id}`)}
                   onKeyDown={e => { if (e.key === "Enter") router.push(`/tasks/${t.id}`); }}>
                <div className="tc-tags">
                  <span className="tag">{t.audio_count} audio</span><span className="tag">{fmtDur(t.duration)}</span><span className="tag">{t.count} packages</span>
                  {t.access?.manage && <button className="tc-del" title="Delete this task" aria-label="Delete this task"
                                              onClick={e => { e.stopPropagation(); remove(t); }}><Icon name="trash" /></button>}</div>
                <div className="tc-body">
                  <h3>{t.name}</h3>
                  <div className="tc-desc">Created {t.created}{t.created_by ? ` by ${t.created_by}` : ""}</div>
                  <div className="tc-counts"><span>Done <b>{t.done}</b> of {t.done + t.todo}</span><span><b>{pct}%</b></span></div>
                  <div className="bar"><div style={{ width: `${pct}%` }} /></div>
                  <div className="stats">
                    <span className="pill">To review {t.stages.inspecting}</span>
                    <span className="pill ok">Accepted {t.stages.accepted}</span>
                    {t.stages.returned > 0 && <span className="pill err">Returned {t.stages.returned}</span>}
                  </div>
                  <div className="tc-meta">Last saved {t.updated}</div>
                  {t.access?.manage && (
                    <div className="tc-share" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                      {pullers(t).length > 0
                        ? <span className="pill pulled" title={pullers(t).map(p => `${nameOf(p.username)} pulled it ${p.at}`).join(" · ")}>
                            <Icon name="users" /> Pulled by {pullers(t).map(p => nameOf(p.username)).join(", ")}</span>
                        : pushedTo(t) && <span className="pill ok"><Icon name="check" /> Pushed — waiting for a pull</span>}
                      <button className={`small${pushedTo(t) ? " sec" : ""}`} disabled={sharing === t.id || (pushedTo(t) && pullers(t).length > 0)}
                              onClick={() => share(t)}
                              title={pullers(t).length ? "Someone already pulled this task — it cannot be taken back"
                                     : pushedTo(t) ? "Annotators can no longer pull it"
                                     : "Annotators see it under “Available to pull” and pull it themselves"}>
                        <Icon name={sharing === t.id ? "loader" : pushedTo(t) ? "x" : "upload"} className={sharing === t.id ? "spin" : ""} />
                        {pushedTo(t) ? " Take back" : " Push to annotators"}</button>
                    </div>)}
                </div>
              </div>
            );
          })}
        </div>
        {tasks && !list.length && (
          <div className="empty">{error || (q || show ? "No task matches these filters."
            : can("audio.upload") ? "No tasks yet — make one in “Load Data”: upload and cut audio, or load a Hugging Face dataset or a local folder."
            : open.length ? "No task is assigned to you yet — pull a dataset above, or ask your project manager."
            : "No task is assigned to you yet — ask your project manager to push a dataset to annotators.")}</div>
        )}
        {list.length > PER_PAGE && <Pager page={cur} pages={pages} onPage={setPage} className="pager"
          label={`${(cur - 1) * PER_PAGE + 1}–${(cur - 1) * PER_PAGE + shown.length} of ${list.length}`} />}
      </div>
    </section>
  );
}
