"use client";
// My Tasks: one card per task the user may see, search, pagination, delete (managers).
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Pager } from "@/components/Pager";
import { useNotify } from "@/components/notify";
import { useCrumbs, useSession } from "@/components/session";
import { del, getJson } from "@/lib/api";
import { fmtDur } from "@/lib/format";
import type { TaskSummary } from "@/lib/types";

const PER_PAGE = 12;
/** the "Show" filter: which stage a task still has packages in */
const SHOW: Record<string, { label: string; test: (t: TaskSummary) => boolean }> = {
  todo: { label: "Has packages to annotate", test: t => t.stages.annotating + t.stages.returned > 0 },
  returned: { label: "Has returned packages", test: t => t.stages.returned > 0 },
  inspect: { label: "Waiting for inspection", test: t => t.stages.inspecting > 0 },
  accept: { label: "Waiting for acceptance", test: t => t.stages.accepting > 0 },
  finished: { label: "Finished (everything accepted)",
              test: t => t.stages.accepted > 0 && t.stages.annotating + t.stages.returned + t.stages.inspecting + t.stages.accepting === 0 },
};

export default function TasksPage() {
  useCrumbs([["Workbench"], ["My Tasks"]]);
  const { can } = useSession();
  const { notify, askConfirm } = useNotify();
  const router = useRouter();
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [show, setShow] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    try { setTasks((await getJson<{ tasks: TaskSummary[] }>("/api/tasks")).tasks); setError(""); }
    catch (e: any) { setTasks([]); setError("Cannot load tasks: " + e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const ql = q.trim().toLowerCase();
  const list = (tasks || []).filter(t => (!ql || t.name.toLowerCase().includes(ql) || t.id.toLowerCase().includes(ql)) &&
                                         (!show || SHOW[show].test(t)));
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE)), cur = Math.min(page, pages);
  const shown = list.slice((cur - 1) * PER_PAGE, cur * PER_PAGE);

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
        <p>Each task is a batch of audio pushed from Upload &amp; Crop. Annotators complete its packages, quality inspectors
          pass or return them, and acceptors give the final acceptance.</p>
      </div>
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
          <span className="count-note">{list.length === (tasks || []).length ? `${list.length} tasks` : `${list.length} of ${(tasks || []).length} tasks`}</span>
          {can("audio.upload") && <button onClick={() => router.push("/upload")}><Icon name="plus" /> Upload audio</button>}
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
                    <span className="pill">To inspect {t.stages.inspecting}</span>
                    <span className="pill">To accept {t.stages.accepting}</span>
                    <span className="pill ok">Accepted {t.stages.accepted}</span>
                    {t.stages.returned > 0 && <span className="pill err">Returned {t.stages.returned}</span>}
                  </div>
                  <div className="tc-meta">Last saved {t.updated}</div>
                </div>
              </div>
            );
          })}
        </div>
        {tasks && !list.length && (
          <div className="empty">{error || (q || show ? "No task matches these filters."
            : can("audio.upload") ? "No tasks yet — upload and cut audio in “Upload & Crop”, then push it to a task."
            : "No task is assigned to you yet — ask your project manager to add you to one.")}</div>
        )}
        {list.length > PER_PAGE && <Pager page={cur} pages={pages} onPage={setPage} className="pager"
          label={`${(cur - 1) * PER_PAGE + 1}–${(cur - 1) * PER_PAGE + shown.length} of ${list.length}`} />}
      </div>
    </section>
  );
}
