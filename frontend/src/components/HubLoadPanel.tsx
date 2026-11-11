"use client";
// Load Data from Hugging Face: Load a dataset (configs, splits, columns), pick the audio and text columns, and load it
// into tasks - the whole split as one task, or a big split in batches of rows (one task per batch; each reads only its
// rows from the Hub). Every clip becomes a package with its text filled in (no speech recognition needed).
import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { useNotify } from "@/components/notify";
import { api } from "@/lib/api";
import { fmtSize } from "@/lib/format";
import type { TaskSummary } from "@/lib/types";

interface HubSplit { name: string; rows: number | null; files: number; bytes: number | null; next_row: number; partial?: boolean }
interface HubConfig { name: string; splits: HubSplit[]; columns: { name: string; type: string }[] }
interface HubInfo { repo: string; configs: HubConfig[]; partial: boolean }

export function HubLoadPanel() {
  const { notify } = useNotify();
  const [repo, setRepo] = useState(""), [token, setToken] = useState("");
  const [info, setInfo] = useState<HubInfo | null>(null);
  const [err, setErr] = useState(""), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [config, setConfig] = useState(""), [split, setSplit] = useState("");
  const [audioCol, setAudioCol] = useState(""), [textCol, setTextCol] = useState(""), [name, setName] = useState("");
  const [start, setStart] = useState("0"), [max, setMax] = useState(""), [batches, setBatches] = useState("1");
  const [made, setMade] = useState<TaskSummary[]>([]);

  const cfg = info?.configs.find(c => c.name === config) || info?.configs[0];
  const sp = cfg?.splits.find(s => s.name === split) || cfg?.splits[0];

  const pickConfig = (i: HubInfo, c: HubConfig) => {
    setConfig(c.name);
    const audio = c.columns.filter(x => x.type === "audio"), text = c.columns.filter(x => /string/.test(x.type));
    setAudioCol((audio[0] || c.columns[0])?.name || "");
    // the usual names for the transcript
    const pick = ["transcription", "sentence", "text", "transcript", "normalized_text", "raw_transcription"].find(n => text.some(x => x.name === n));
    setTextCol(pick || (text[0] || c.columns[0])?.name || "");
    pickSplit(i, c.splits[0]);
  };
  const pickSplit = (i: HubInfo, s: HubSplit) => {
    const big = s.rows == null || s.rows > 2000;
    setSplit(s.name);
    setName(`${i.repo.split("/")[1]} (${s.name})`);
    setStart(String(s.next_row || 0));
    setMax(big || s.next_row ? "200" : "");          // a big split goes in batches
    setBatches("1");
  };

  const inspect = async () => {
    setErr(""); setInfo(null); setLoading(true);
    try {
      const i = await api<HubInfo>("/api/hub/inspect", { repo, token });
      setInfo(i); pickConfig(i, i.configs[0]);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const per = +max || 0, n = per ? Math.max(1, +batches || 1) : 1, s0 = +start || 0;
  const end = per ? s0 + per * n - 1 : null, last = sp?.rows != null && end != null ? Math.min(end, sp.rows - 1) : end;
  const summary = info && sp ? [info.repo, sp.rows != null ? `${sp.rows.toLocaleString()} rows` : "",
    sp.next_row ? `rows 0–${(sp.next_row - 1).toLocaleString()} already loaded` : "",
    per ? `this load: rows ${s0.toLocaleString()}–${last != null ? last.toLocaleString() : "end"} in ${n} task${n > 1 ? "s" : ""} of ${per} clips`
        : sp.bytes ? `the whole split as one task (${fmtSize(sp.bytes)} to download)` : "the whole split as one task",
    sp.partial ? "⚠ the Hub has parquet for only the first part of this split (about 5 GB): later rows cannot be loaded" : ""].filter(Boolean).join(" · ") : "";

  const load = async () => {
    if (!info || !cfg || !sp) return;
    setBusy(true);
    try {
      const r = await api<{ tasks: TaskSummary[]; warning?: string }>("/api/tasks/load/hub", {
        repo: info.repo, config: cfg.name, split: sp.name, rows: sp.rows, token,
        audio_column: audioCol, text_column: textCol, name, start_row: start, max_rows: max, batches: max ? batches : 1 });
      if (r.warning) notify(r.warning, "warn", 0);
      setMade(m => [...r.tasks, ...m]);
      notify((r.tasks.length > 1 ? `Loading ${r.tasks.length} tasks` : `Loading the task “${r.tasks[0].name}”`) +
             " — the clips are downloaded in the background; each one becomes a package with its text.", "info");
      const ends = r.tasks.map(t => (t.source?.start_row || 0) + (t.source?.max_rows || 0)).filter(Boolean);
      sp.next_row = Math.max(sp.next_row || 0, ...ends);
      if (max) setStart(String(sp.next_row)); else setInfo(null);   // ready for the next batches
    } catch (e: any) { notify("Loading failed: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  const opts = (cols: { name: string; type: string }[]) => cols.map(x => <option key={x.name} value={x.name}>{x.name} ({x.type})</option>);
  return (
    <div className="panel">
      <b className="sec-title"><Icon name="download" /> Load a Hugging Face dataset into tasks</b>
      <p className="muted">For speech that already has its text: every clip becomes a package of a task with the text filled in.
        Annotators check it (no recognition needed), then the review as usual.</p>
      <div className="imp-row">
        <label className="fld grow"><span className="req">Dataset</span>
          <input placeholder="e.g. seanghay/khmer_mpwt_speech or its URL" autoComplete="off" value={repo}
                 onChange={e => setRepo(e.target.value)} onKeyDown={e => { if (e.key === "Enter") inspect(); }} /></label>
        <label className="fld"><span>Access token</span>
          <input type="password" placeholder="Only for private / gated datasets" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} /></label>
        <button onClick={inspect} disabled={loading}>{loading ? <><Icon name="loader" className="spin" /> Loading…</> : <><Icon name="search" /> Load</>}</button>
      </div>
      <div className="errmsg">{err}</div>
      {info && cfg && sp && (
        <div>
          <div className="form-grid imp-grid">
            <label className="fld"><span>Config</span>
              <select value={cfg.name} onChange={e => pickConfig(info, info.configs.find(c => c.name === e.target.value)!)}>
                {info.configs.map(c => <option key={c.name}>{c.name}</option>)}</select></label>
            <label className="fld"><span>Split</span>
              <select value={sp.name} onChange={e => pickSplit(info, cfg.splits.find(s => s.name === e.target.value)!)}>
                {cfg.splits.map(s => <option key={s.name} value={s.name}>{s.name}{s.rows != null ? ` — ${s.rows.toLocaleString()} rows` : ""}</option>)}</select></label>
            <label className="fld"><span className="req">Audio column</span>
              <select value={audioCol} onChange={e => setAudioCol(e.target.value)}>
                {opts(cfg.columns.some(x => x.type === "audio") ? cfg.columns.filter(x => x.type === "audio") : cfg.columns)}</select></label>
            <label className="fld"><span className="req">Text column</span>
              <select value={textCol} onChange={e => setTextCol(e.target.value)}>
                {opts(cfg.columns.some(x => /string/.test(x.type)) ? cfg.columns.filter(x => /string/.test(x.type)) : cfg.columns)}</select></label>
            <label className="fld"><span>Task name</span><input value={name} onChange={e => setName(e.target.value)} /></label>
          </div>
          <div className="form-grid imp-grid">
            <label className="fld"><span>Start at row</span><input type="number" min="0" value={start} onChange={e => setStart(e.target.value)}
                                                                  title="The next row not loaded yet is filled in" /></label>
            <label className="fld"><span>Clips per task</span><input type="number" min="1" placeholder="All rows (one task)" value={max}
                     onChange={e => setMax(e.target.value)} title="A big dataset is loaded in batches of e.g. 200 rows: one task per batch, each reads only its rows from the Hub" /></label>
            <label className="fld"><span>Tasks</span><input type="number" min="1" max="100" value={batches} onChange={e => setBatches(e.target.value)} /></label>
          </div>
          <div className="imp-row">
            <span className="muted">{summary}</span>
            <span style={{ flex: 1 }} />
            <button onClick={load} disabled={busy}><Icon name="download" /> Load into task{n > 1 ? "s" : ""}</button>
          </div>
        </div>
      )}
      {made.length > 0 && <div className="made-tasks">
        <b>Loaded into:</b>
        {made.map(t => <Link key={t.id} href={`/tasks/${t.id}`}><Icon name="file" /> {t.name}</Link>)}
      </div>}
    </div>
  );
}
