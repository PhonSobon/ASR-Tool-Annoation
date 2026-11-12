"use client";
// One task: "Task Batch List" (packages = crops; tabs Todo / Review / Done, filters, duration
// stats, Recognize all, members, export, push to the Hub) and the package view of one package (PackageView).
// A task made by Load Data from a Hugging Face dataset shows its loading job and fills in while the clips arrive.
import { use, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { HubPushDialog } from "@/components/HubPushDialog";
import { Icon } from "@/components/Icon";
import { JobBox, useJob } from "@/components/JobBox";
import { MembersDialog } from "@/components/MembersDialog";
import { Pager } from "@/components/Pager";
import { PackageView } from "@/components/task/PackageView";
import { useNotify } from "@/components/notify";
import { useCrumbs, useSession } from "@/components/session";
import { api, download, getJson } from "@/lib/api";
import { fmtHms, fmtT } from "@/lib/format";
import {
  cropLabel, cropStage, cropState, handTyped, inTab, liveParts, reviewerOf, STATUS, syncCrop, TAB_LABEL, TABS, type Tab,
} from "@/lib/review";
import { TaskStore, type Pkg } from "@/lib/task-store";
import type { Members, Task, TaskSummary } from "@/lib/types";

/** member roles a task can be opened to for claiming */
const ROLE_GROUP: Record<string, string> = { annotator: "Annotators", inspector: "Reviewers" };
const INCLUDE_STAGES: Record<string, string[]> = { accepted: ["accepted"], done: ["inspecting", "accepted"] };

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me, can, setSave, nameOf } = useSession();
  const { notify } = useNotify();
  const router = useRouter();
  const [task, setTask] = useState<Task | null>(null);
  useCrumbs(task ? [["Workbench"], ["My Tasks", "/tasks"], [task.name]] : [["Workbench"], ["My Tasks", "/tasks"], ["…"]]);

  const reload = useCallback(() => getJson<Task>(`/api/tasks/${id}`).then(setTask), [id]);
  useEffect(() => {
    reload().catch(e => { notify("Cannot open this page: " + e.message, "error"); router.replace("/tasks"); });
  }, [reload, notify, router]);

  const store = useMemo(() => task && new TaskStore(task, me.username, setSave, m => notify(m, "error")), [task, me.username, setSave, notify]);
  if (!store) return null;
  return <TaskView key={store.task.id} store={store} can={can} nameOf={nameOf} reload={reload} />;
}

function TaskView({ store, can, nameOf, reload }: { store: TaskStore; can: (p: string) => boolean; nameOf: (u: string) => string; reload: () => Promise<void> }) {
  const { me } = useSession();
  const { notify } = useNotify();
  const router = useRouter();
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version);
  const task = store.task, acc = task.access!, crops = store.crops;
  const mine: Tab = me.role === "inspector" ? "review" : "todo";
  const [tab, setTab] = useState<Tab>(() => [mine, ...TABS].find(t => crops.some(c => inTab(c.seg, t))) || mine);
  const [f, setF] = useState({ audio: "", pkg: "", annotator: "", reviewer: "" });
  const [page, setPage] = useState(1), [per, setPer] = useState(10);
  const [cur, setCur] = useState(-1);
  const [taskStatus, setTaskStatus] = useState("");
  const [recRunning, setRecRunning] = useState(false);
  const recStop = useRef({ stop: false });
  const [members, setMembers] = useState(false), [pushing, setPushing] = useState(false), [sharing, setSharing] = useState(false);
  const [include, setInclude] = useState("accepted");
  const [dlAudio, setDlAudio] = useState("");                            // the audio "Download audio" saves

  useEffect(() => {                                       // save before leaving the page / logging out
    const flush = () => { store.flush(); };
    const warn = (e: BeforeUnloadEvent) => { if (store.unsaved.size) { flush(); e.preventDefault(); } };
    window.addEventListener("app:flush", flush);
    window.addEventListener("beforeunload", warn);
    return () => { flush(); window.removeEventListener("app:flush", flush); window.removeEventListener("beforeunload", warn); };
  }, [store]);

  const pushJob = useJob(`/api/tasks/${task.id}/job`, job => {
    if (job.kind === "load") { store.flush(); reload(); }               // the clips loaded from the Hub are all there
    if (job.error) notify((job.kind === "load" ? "Loading failed: " : "Push failed: ") + job.error, "error");
    else notify(job.message, "success", job.kind === "load" ? 5000 : 0);
  }, (job, tick) => { if (job.kind === "load" && tick % 4 === 0 && !store.unsaved.size) reload(); });   // packages appear while it loads

  // ---------- list ----------
  /** the filters except the tab (the tab counts use them too) */
  const matches = useCallback((c: Pkg) => {
    const qa = f.audio.trim().toLowerCase(), qp = f.pkg.trim().toLowerCase();
    return (!qa || c.audio.name.toLowerCase().includes(qa)) && (!qp || c.pkg.toLowerCase().includes(qp)) &&
           (!f.annotator || (c.seg.annotator || "") === f.annotator) &&
           (!f.reviewer || reviewerOf(c.seg) === f.reviewer);
  }, [f]);
  const filtered = useCallback(() => crops.map((_, i) => i).filter(i => inTab(crops[i].seg, tab) && matches(crops[i])),
                               [crops, tab, matches]);
  const filtering = Object.values(f).some(Boolean);
  const setFilter = (k: keyof typeof f, v: string) => { setF(x => ({ ...x, [k]: v })); setPage(1); };
  const list = filtered(), pages = Math.max(1, Math.ceil(list.length / per)), pg = Math.min(page, pages);
  const shown = list.slice((pg - 1) * per, pg * per);

  /** the packages Prev / Next walk through: the open tab with its filters (the open package always included) */
  const workList = () => { const l = filtered(); if (cur >= 0 && !l.includes(cur)) { l.push(cur); l.sort((a, b) => a - b); } return l; };
  const step = (d: number) => {
    const l = workList(), next = l[l.indexOf(cur) + d];
    if (next != null) setCur(next);
    else if (d > 0) { setCur(-1); setTaskStatus(`That was the last package in ${TAB_LABEL[tab]}.`); }
  };

  const handler = (c: Pkg) => {
    const m: Members = task.members, g = cropStage(c.seg);
    const names = g === "inspecting" ? m.inspector
                : ["annotating", "returned"].includes(g) ? (c.seg.annotator ? [c.seg.annotator] : m.annotator) : [];
    return names.map(nameOf).join(", ");
  };
  const openLabel = (c: Pkg) => {
    const g = cropStage(c.seg);
    if (g === "inspecting" && acc.review) return "Review";
    return ["annotating", "returned"].includes(g) && store.editable(c) ? "Annotate" : "View";
  };
  const claimTab: Tab = acc.edit && me.role !== "inspector" ? (tab === "done" ? "todo" : tab)
                      : me.role === "inspector" ? "review" : tab;

  // people to filter by: those found in the open tab (else picking one could only show "No data"), plus the chosen one
  const options = (of: (c: Pkg) => string | undefined, chosen: string) =>
    [...new Set([...crops.filter(c => inTab(c.seg, tab)).map(of), chosen].filter(Boolean) as string[])].sort();
  const live = crops.filter(c => cropState(c.seg) !== "skipped");
  const len = (c: Pkg) => liveParts(c.seg).reduce((a, p) => a + p.end - p.start, 0);
  const total = live.reduce((a, c) => a + len(c), 0), done = live.filter(c => cropState(c.seg) === "done").reduce((a, c) => a + len(c), 0);
  const passed = live.filter(c => cropStage(c.seg) === "accepted").reduce((a, c) => a + len(c), 0);

  // ---------- Recognize all (every segment without text in the task) ----------
  const recognizeAll = async () => {
    const stop = recStop.current = { stop: false };
    setRecRunning(true);
    const todo = crops.filter(c => !c.seg.deleted && store.editable(c)).flatMap(c =>
      liveParts(c.seg).filter(p => p.state !== "done" && !handTyped(p) && !(p.text || "").trim()).map(p => [c, p] as const));
    let k = 0, fatal = false;
    for (const [c, p] of todo) {
      if (stop.stop) break;
      setTaskStatus(`Recognizing ${++k} / ${todo.length}: ${c.pkg}…`);
      p.state = "running"; p.error = ""; store.emit();
      try {
        const j = await api(`/api/audios/${c.audio.id}/transcribe`, { start: p.start, end: p.end });
        p.text = p.wordsText = j.text; p.words = j.words || null; p.state = "done";
        if (!p.normEdited) p.norm = j.text.trim() ? (await api("/api/text/normalize", { text: j.text })).normalized : "";
      } catch (e: any) {
        p.state = "error"; p.error = e.message;
        if (e.fatal) fatal = true;
      }
      syncCrop(c.seg);
      store.markDirty(c);
      if (fatal) {
        setTaskStatus("Stopped — " + p.error);
        notify("Recognition stopped: " + p.error + "\nCheck the model files in backend/models/Omnilingual-ASR-Khm.", "error");
        break;
      }
    }
    setRecRunning(false);
    if (fatal) return;
    const err = crops.filter(c => cropState(c.seg) === "error").length;
    const msg = `${stop.stop ? "Stopped" : "Finished"}: ${k} segment(s) recognized${err ? `, ${err} package(s) with errors (open them and press Recognize)` : ""}.` +
                (todo.length ? "" : " Nothing to do — every segment already has text.") + " Check each package in Todo, then press Complete to send it to review.";
    setTaskStatus(msg);
    notify(msg, err ? "warn" : stop.stop ? "info" : "success");
  };

  const exportZip = async () => {
    await store.flush();
    download(`/api/tasks/${task.id}/export`);
    notify(`Exporting “${task.name}” — the ZIP will download in a moment.`, "info");
  };

  /** one package's audio (its start–end of the source audio) as a WAV, instead of the whole task ZIP */
  const downloadPkg = (c: Pkg) => {
    const q = new URLSearchParams({ start: String(c.seg.start), end: String(c.seg.end), name: c.pkg.replace(/\.[^.]+$/, "") });
    download(`/api/audios/${c.audio.id}/download?${q}`);
  };

  const pushed = !!task.open_roles?.includes("annotator");
  const pullers = (task.pulled || []).filter(p => p.role === "annotator");
  const share = async () => {
    setSharing(true);
    try { ({ open_roles: task.open_roles } = await api(`/api/tasks/${task.id}/share`, { annotator: !pushed }, "PUT")); }
    catch (e: any) { return notify("Cannot push: " + e.message, "error"); }
    finally { setSharing(false); }
    store.emit();
    notify(pushed ? "Taken back: annotators can no longer pull this task." : "Pushed: annotators can now pull this task in My Tasks.", "success");
  };

  const saveMembers = async (m: Record<string, string[]>, open: string[]) => {
    try { ({ members: task.members, open_roles: task.open_roles } = await api(`/api/tasks/${task.id}/members`, { ...m, open_roles: open }, "PUT")); }
    catch (e: any) { return notify("Members not saved: " + e.message, "error"); }
    setMembers(false); store.emit();
    notify("Members saved.", "success");
  };

  // segments that go to the Hub: [count, seconds] of the packages kept by `include` (as tasks.keep_crop)
  const kept = (inc: string) => crops.filter(c => cropState(c.seg) === "done" && INCLUDE_STAGES[inc].includes(cropStage(c.seg)));
  const pushCount = (inc: string) => { const parts = kept(inc).flatMap(c => liveParts(c.seg).filter(p => (p.text || "").trim()));
                                       return [parts.length, parts.reduce((a, p) => a + p.end - p.start, 0)] as const; };
  const openPush = async () => {
    await store.flush();
    setInclude(["accepted", "passed", "done"].find(inc => kept(inc).length) || "done");
    setPushing(true);
  };
  const [lastPush, setLastPush] = useState(task.last_push);
  useEffect(() => {                                      // tasks usually all go to one repo: offer the last one
    if (!lastPush) getJson<{ tasks: TaskSummary[] }>("/api/tasks").then(j => {
      const p = j.tasks.map(t => t.last_push).filter(x => x && !x.pr).sort((a, b) => (a!.at < b!.at ? 1 : -1))[0];
      if (p) setLastPush(p);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const m = task.members;
  const membersText = [["Annotators", m.annotator], ["Reviewers", m.inspector]]
    .filter(([, l]) => (l as string[]).length).map(([label, l]) => `${label}: ${(l as string[]).map(nameOf).join(", ")}`).join(" · ")
    || (acc.manage ? "Nobody is assigned yet — press Members." : "");
  const openText = task.open_roles?.length && acc.manage
    ? `Open for pulling: ${task.open_roles.map(r => ROLE_GROUP[r] || r).join(", ")}` : "";

  if (cur >= 0) {
    const l = workList();
    return <PackageView store={store} index={cur} position={[l.indexOf(cur), l.length]}
                        onStep={step} onBack={() => setCur(-1)} onAllDone={() => setCur(-1)} />;
  }

  return (
    <section>
      <div className="panel headcard">
        <div className="task-head">
          <div>
            <h2>{task.name}{acc.edit ? "" : <span className="pill" style={{ marginLeft: 10, verticalAlign: 3 }}>Read only</span>}</h2>
            <p>{membersText || "Packages of this task"}{openText && <span className="pill" style={{ marginLeft: 8 }}>{openText}</span>}
              {acc.manage && pullers.length > 0 && <span className="pill pulled" style={{ marginLeft: 8 }}
                title={pullers.map(p => `${nameOf(p.username)} pulled it ${p.at}`).join(" · ")}>
                <Icon name="users" /> Pulled by {pullers.map(p => nameOf(p.username)).join(", ")}</span>}</p>
            {task.source && <p className="muted">
              {task.source.kind === "hub" ? <>Loaded from <a href={`https://huggingface.co/datasets/${task.source.repo}`} target="_blank" rel="noopener">{task.source.repo}</a>
                {` · ${task.source.config} / ${task.source.split}`}{task.source.max_rows ? ` · rows ${task.source.start_row}–${(task.source.start_row || 0) + task.source.max_rows - 1}` : ""}</>
                : "Loaded from a local folder"}
              {" · every clip is one package with its text already filled in — check it against the audio, no recognition needed"}
              {task.source.failed ? ` · ${task.source.failed} files could not be read` : ""}</p>}
          </div>
          <button className="sec back" onClick={() => router.push("/tasks")}><Icon name="arrow-left" /> Back</button>
        </div>
      </div>

      <div className="panel">
        <div className="filter-bar">
          <div className="search sm"><input type="search" placeholder="Audio name" aria-label="Search by audio name" value={f.audio}
                                            onChange={e => setFilter("audio", e.target.value)} />
            <button type="button" tabIndex={-1} aria-hidden="true"><Icon name="search" /></button></div>
          <div className="search sm"><input type="search" placeholder="Package ID" aria-label="Search by package ID" value={f.pkg}
                                            onChange={e => setFilter("pkg", e.target.value)} />
            <button type="button" tabIndex={-1} aria-hidden="true"><Icon name="search" /></button></div>
          {([["annotator", "All annotators", (c: Pkg) => c.seg.annotator], ["reviewer", "All reviewers", (c: Pkg) => reviewerOf(c.seg)]] as const).map(([k, all, of]) => (
            <select key={k} aria-label={`Filter by ${k}`} value={f[k]} onChange={e => setFilter(k, e.target.value)}>
              <option value="">{all}</option>{options(of, f[k]).map(n => <option key={n} value={n}>{nameOf(n)}{nameOf(n) !== n ? ` (${n})` : ""}</option>)}
            </select>))}
          {filtering && <button type="button" className="sec" onClick={() => { setF({ audio: "", pkg: "", annotator: "", reviewer: "" }); setPage(1); }}>Clear</button>}
        </div>

        <div className="pkg-actions">
          {(acc.edit || acc.review) && <button className="sec" title={`Open the next package in ${TAB_LABEL[claimTab]}`}
            disabled={!crops.some(c => inTab(c.seg, claimTab))} onClick={() => { const i = crops.findIndex(c => inTab(c.seg, claimTab)); if (i >= 0) { setTab(claimTab); setCur(i); } }}>
            <Icon name="file" /> Claim Package</button>}
          {acc.edit && can("asr.run") && !task.source && <>   {/* loaded data has its text: nothing to recognize */}
            <button className="sec" title="Recognize every package that has no text yet" disabled={recRunning} onClick={recognizeAll}><Icon name="recognize" /> Recognize all</button>
            <button className="stop" disabled={!recRunning} onClick={() => { recStop.current.stop = true; setTaskStatus("Stopping after the current segment…"); }}><Icon name="stop" /> Stop</button>
          </>}
          {acc.manage && <button className={pushed ? "sec" : ""} disabled={sharing || (pushed && pullers.length > 0)}
            title={pushed && pullers.length ? "Someone already pulled this task — it cannot be taken back"
                   : pushed ? "Annotators can pull this task in My Tasks - take it back so only assigned people work on it"
                   : "Let annotators pull this task themselves from My Tasks"} onClick={share}>
            <Icon name={sharing ? "loader" : pushed ? "x" : "upload"} className={sharing ? "spin" : ""} /> {pushed ? "Take back from annotators" : "Push to annotators"}</button>}
          {acc.manage && <button className="sec" title="Choose who annotates and reviews this task" onClick={() => setMembers(true)}><Icon name="users" /> Members</button>}
          {can("data.export") && <button className="sec" title="Download every package of this task as one ZIP" onClick={exportZip}><Icon name="download" /> Export task ZIP</button>}
          {can("data.export") && task.audios.length > 0 && <span className="nowrap">
            <select aria-label="Audio to download" value={dlAudio || task.audios[0].id} onChange={e => setDlAudio(e.target.value)}
                    style={{ maxWidth: 220 }}>
              {task.audios.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>{" "}
            <button className="sec" title="Download the whole chosen audio of this task as one WAV file (no ZIP)"
              onClick={() => { const a = task.audios.find(x => x.id === (dlAudio || task.audios[0].id))!;
                               download(`/api/audios/${a.id}/download?name=${encodeURIComponent(a.name.replace(/\.[^.]+$/, ""))}`); }}>
              <Icon name="download" /> Download audio</button></span>}
          {can("hub.push") && (crops.some(c => cropState(c.seg) === "done") || pushJob.running) &&
            <button title="Upload the reviewed packages to a Hugging Face dataset repo" disabled={pushJob.running} onClick={openPush}><Icon name="upload" /> Push to Hugging Face</button>}
          <span className="muted">{taskStatus}</span>
        </div>
        {pushJob.visible && pushJob.job && <JobBox job={pushJob.job} stopUrl={`/api/tasks/${task.id}/stop`} canStop={acc.manage} />}

        <div className="crop-tabs" role="tablist" aria-label="Packages">
          {TABS.map(t => <button key={t} type="button" role="tab" className={t === tab ? "on" : ""} aria-selected={t === tab}
                                 onClick={() => { setTab(t); setPage(1); }}>{TAB_LABEL[t]}<span className="n">{crops.filter(c => inTab(c.seg, t) && matches(c)).length}</span></button>)}
        </div>

        <div className="info-box">
          <span className="info-i"><Icon name="info" /></span>
          <div>
            <div className="info-title">Duration Stats</div>
            <div className="info-stats">
              <span>Total Duration: <b>{fmtHms(total)}</b><span className="q" title="Length of all segments in this task (skipped ones not counted)"><Icon name="help" /></span></span>
              <span>Effective Duration: <b>{fmtHms(done)}</b><span className="q" title="Length of the completed packages (every segment has annotation text)"><Icon name="help" /></span></span>
              <span>Accepted Effective Duration: <b>{fmtHms(passed)}</b><span className="q" title="Completed packages that the reviewer accepted"><Icon name="help" /></span></span>
            </div>
          </div>
        </div>

        <div className="table-wrap">
          <table className="pkg-table">
            <thead><tr>
              <th>Package Name</th><th>Status</th><th>Annotator</th><th>Reviewer</th>
              <th>Current Handler</th><th>Last update</th><th>Action</th>
            </tr></thead>
            <tbody>
              {shown.map(i => {
                const c = crops[i], s = c.seg, st = cropLabel(s), n = liveParts(s).length, h = handler(c);
                return (
                  <tr key={i}>
                    <td><a className="open" onClick={() => setCur(i)}>{c.pkg}</a>
                      <div className="pkg-sub">{fmtT(s.start)} – {fmtT(s.end)} · {(s.end - s.start).toFixed(1)} s{n > 1 ? ` · ${n} segments` : ""}</div></td>
                    <td><span className={"st " + st}>{STATUS[st]}</span>
                      {s.returned && <div className="pkg-sub" title={s.returned.note}><Icon name="alert" /> {s.returned.note.slice(0, 40)}</div>}</td>
                    <td>{s.annotator ? <span className="who">{nameOf(s.annotator)}</span> : "-"}</td>
                    <td>{reviewerOf(s) ? <span className="who">{nameOf(reviewerOf(s))}</span> : "-"}</td>
                    <td>{h || "-"}</td>
                    <td className="nowrap">{s.updated || "-"}</td>
                    <td className="nowrap"><a className="open" onClick={() => setCur(i)}>{openLabel(c)}</a>
                      {can("data.export") && <> · <a className="open" title="Download the audio of this package (WAV)"
                        onClick={() => downloadPkg(c)}><Icon name="download" /> Audio</a></>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!list.length && <div className="pkg-empty"><div className="pkg-empty-icon"><Icon name="inbox" className="xl" /></div>
            {filtering ? `No package in ${TAB_LABEL[tab]} matches these filters.` : `No package in ${TAB_LABEL[tab]}.`}</div>}
        </div>
        {list.length > 0 && <Pager page={pg} pages={pages} onPage={setPage} perPage={per} perOptions={[10, 20, 50, 100]}
                                   onPer={n => { setPer(n); setPage(1); }}
                                   label={`${(pg - 1) * per + 1}–${(pg - 1) * per + shown.length} of ${list.length}`} />}
      </div>

      {members && <MembersDialog title={`Members of “${task.name}”`} current={task.members as any}
        text="Annotators and reviewers see only the tasks they are members of. Managers see every task."
        groups={[{ key: "annotator", label: "Annotators", roles: ["annotator", "manager", "admin"] },
                 { key: "inspector", label: "Reviewers", roles: ["inspector", "manager", "admin"] }]}
        claim={{ legend: "Open for pulling", text: "Users of the roles ticked see this task under “Available to pull” in My Tasks and can pull it themselves. Untick all to assign people only.",
                 options: Object.entries(ROLE_GROUP).map(([key, label]) => ({ key, label })), current: task.open_roles || [] }}
        onSave={saveMembers} onClose={() => setMembers(false)} />}

      {pushing && (
        <HubPushDialog title="Push task to Hugging Face" onClose={() => setPushing(false)} canPush={pushCount(include)[0] > 0}
          defaults={{ repo: lastPush && !lastPush.pr ? lastPush.repo : "", split: lastPush ? lastPush.split : "train" }}
          suggestRepo={u => `${u}/${task.name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "khmer_asr_dataset"}`}
          info={fp => { const [n, sec] = pushCount(include);
            return `${n} segments (${fmtHms(sec)}) of the ${{ accepted: "accepted packages", done: "completed packages" }[include]} are uploaded as parquet to data/${fp.split || "train"}-task-${task.id}-*.parquet ` +
              "with audio, text, text_normalized, role, speaker and audio information." +
              (fp.create_pr ? " A pull request is opened — the owner of the repo decides whether to merge it."
                            : " Only this task's earlier files are replaced: other tasks pushed to the same repo stay, and the dataset card's batch table gets a row for this task."); }}
          onPush={async fp => {
            await api(`/api/tasks/${task.id}/hub-push`, { ...fp, include });
            setPushing(false);
            setLastPush({ repo: fp.repo_id, split: fp.split, pr: fp.create_pr, url: "", at: "" });
            pushJob.start();
          }}>
          <label className="fld"><span>Packages</span><select value={include} onChange={e => setInclude(e.target.value)}>
            <option value="accepted">Accepted packages</option>
            <option value="done">Completed packages (with or without review)</option></select></label>
        </HubPushDialog>
      )}
    </section>
  );
}
