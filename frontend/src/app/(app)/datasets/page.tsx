"use client";
// Dataset Cleaning: import a Hugging Face dataset (Load -> pick config / split / columns -> Import), whole or in
// batches of rows (a big split is cleaned e.g. 200 rows at a time, every batch pushed to the same repo), and the
// cards of imported datasets (search, filter, pages; progress while importing; delete).
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Pager } from "@/components/Pager";
import { useNotify } from "@/components/notify";
import { useCrumbs, useSession } from "@/components/session";
import { api, del, getJson } from "@/lib/api";
import { CAT_LABEL } from "@/lib/dataset";
import { fmtDur, fmtSize } from "@/lib/format";
import type { DatasetSummary } from "@/lib/types";

const PER_PAGE = 12;

interface HubSplit { name: string; rows: number | null; files: number; bytes: number | null; next_row: number; partial?: boolean }
interface HubConfig { name: string; splits: HubSplit[]; columns: { name: string; type: string }[] }
interface HubInfo { repo: string; configs: HubConfig[]; partial: boolean }

export default function DatasetsPage() {
  useCrumbs([["Dataset Cleaning"], ["Hugging Face Datasets"]]);
  const { can } = useSession();
  const { notify, askConfirm } = useNotify();
  const router = useRouter();
  const [cards, setCards] = useState<DatasetSummary[]>([]);
  const [q, setQ] = useState("");
  const [show, setShow] = useState("");
  const [page, setPage] = useState(1);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    let list: DatasetSummary[] = [];
    try { list = (await getJson<{ datasets: DatasetSummary[] }>("/api/datasets")).datasets; }
    catch (e: any) { notify("Cannot load datasets: " + e.message, "error"); }
    setCards(list);
    if (list.some(d => d.job?.running)) timer.current = setTimeout(load, 1500);
  }, [notify]);
  useEffect(() => { load(); return () => clearTimeout(timer.current); }, [load]);

  const list = cards.filter(d => {
    const b = d.batch, ql = q.trim().toLowerCase(), row = /^\d+$/.test(ql) ? +ql : null;
    // a number finds the batch holding that row, and also names / repos containing it
    const inRows = row != null && !!b && row >= b.start && (b.end == null || row <= b.end);
    if (ql && !inRows && !`${d.name} ${d.repo} ${d.split}`.toLowerCase().includes(ql)) return false;
    if (show === "todo") return d.status_counts.todo > 0;
    if (show === "unpushed") return d.status_counts.todo === 0 && !d.last_push;
    if (show === "pushed") return !!d.last_push;
    return true;
  });
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE)), cur = Math.min(page, pages);
  const pushed = cards.filter(d => d.last_push).length;

  const remove = async (d: DatasetSummary) => {
    if (!await askConfirm(`Delete “${d.name}”? Its ${d.count} clips and every review decision are removed from this computer (nothing changes on Hugging Face).`,
                          { title: "Delete dataset", ok: "Delete", danger: true })) return;
    try { await del(`/api/datasets/${d.id}`); } catch (e: any) { return notify("Delete failed: " + e.message, "error"); }
    notify(`“${d.name}” deleted.`, "success");
    load();
  };

  return (
    <section>
      <div className="panel headcard">
        <h2>Dataset Cleaning</h2>
        <p>Import a speech dataset from Hugging Face, let the local ASR check every clip, review the doubtful ones, then export it or push the cleaned dataset back to the Hub.</p>
      </div>

      {can("dataset.manage") && <ImportPanel onImported={() => { setPage(1); load(); }} />}

      <div className="panel">
        <div className="toolbar"><b className="sec-title"><Icon name="database" /> Imported datasets</b>
          <div className="search"><input type="search" placeholder="Search name, repo or row" aria-label="Search datasets" value={q}
                                         onChange={e => { setQ(e.target.value); setPage(1); }} />
            <button type="button" tabIndex={-1} aria-hidden="true"><Icon name="search" /></button></div>
          <select aria-label="Show" value={show} onChange={e => { setShow(e.target.value); setPage(1); }}>
            <option value="">All batches</option><option value="todo">Still to review</option>
            <option value="unpushed">Reviewed, not pushed</option><option value="pushed">Pushed</option>
          </select>
          {(q || show) && <button type="button" className="sec" onClick={() => { setQ(""); setShow(""); setPage(1); }}>Clear</button>}
          <span className="spacer" />
          <span className="count-note">{list.length === cards.length ? `${cards.length} batches` : `${list.length} of ${cards.length} batches`}
            {pushed ? ` · ${pushed} pushed` : ""}</span></div>
        <div className="cards">
          {list.slice((cur - 1) * PER_PAGE, cur * PER_PAGE).map(d => {
            const job = d.job?.running ? d.job : null, sc = d.status_counts, cc = d.category_counts, n = d.count || 1;
            const reviewed = sc.accepted + sc.rejected;
            return (
              <div className="task-card ds-card" key={d.id} tabIndex={0} onClick={() => router.push(`/datasets/${d.id}`)}
                   onKeyDown={e => { if (e.key === "Enter") router.push(`/datasets/${d.id}`); }}>
                <div className="tc-tags"><span className="tag hub">Hugging Face</span><span className="tag">{d.split}</span>
                  {d.batch && <span className="tag rows">{d.batch.name}</span>}
                  {d.access?.manage && <button className="tc-del" title="Delete this dataset" aria-label="Delete this dataset"
                                              onClick={e => { e.stopPropagation(); remove(d); }}><Icon name="trash" /></button>}</div>
                <div className="tc-body">
                  <h3>{d.name}</h3>
                  <div className="tc-desc">{d.repo}{d.config !== "default" ? ` · ${d.config}` : ""}<br />
                    {d.count} clips · {fmtDur(d.duration)}{d.failed ? ` · ${d.failed} unreadable` : ""}</div>
                  {job ? <>
                    <div className="tc-counts"><span><Icon name="loader" className="spin" /> {job.message}</span></div>
                    <div className="bar"><div style={{ width: `${job.total ? 100 * job.done / job.total : 0}%`, background: "var(--primary)" }} /></div>
                  </> : <>
                    <div className="tc-counts"><span>Accepted <b>{sc.accepted}</b></span><span>Rejected <b>{sc.rejected}</b></span><span>To review <b>{sc.todo}</b></span></div>
                    <div className="bar"><div style={{ width: `${100 * reviewed / n}%` }} /></div>
                    <div className="tc-meta">Checked by ASR: {d.checked} / {d.count}</div>
                    <div className="bar cat" title="Check results">
                      {(["pass", "review", "bad", "unchecked"] as const).map(c =>
                        <div key={c} className={`c-${c}`} style={{ width: `${100 * cc[c] / n}%` }} title={`${CAT_LABEL[c]}: ${cc[c]}`} />)}
                    </div>
                  </>}
                  <div className="tc-meta">Imported: {d.created}</div>
                  {d.last_push && <div className="tc-meta">Pushed: <a href={d.last_push.url} target="_blank" rel="noopener"
                                        onClick={e => e.stopPropagation()}>{d.last_push.repo}</a> · {d.last_push.at}</div>}
                </div>
              </div>
            );
          })}
        </div>
        {!cards.length ? <div className="empty">{can("dataset.manage") ? "No dataset yet — load one from Hugging Face above."
                                                  : "No dataset is assigned to you yet — ask your project manager."}</div>
          : !list.length && <div className="empty">No dataset matches these filters.</div>}
        {pages > 1 && <Pager className="pager" page={cur} pages={pages} onPage={setPage} />}
      </div>
    </section>
  );
}

function ImportPanel({ onImported }: { onImported: () => void }) {
  const { notify } = useNotify();
  const [repo, setRepo] = useState(""), [token, setToken] = useState("");
  const [info, setInfo] = useState<HubInfo | null>(null);
  const [err, setErr] = useState(""), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [config, setConfig] = useState(""), [split, setSplit] = useState("");
  const [audioCol, setAudioCol] = useState(""), [textCol, setTextCol] = useState(""), [name, setName] = useState("");
  const [start, setStart] = useState("0"), [max, setMax] = useState(""), [batches, setBatches] = useState("1"), [check, setCheck] = useState(true);

  const cfg = info?.configs.find(c => c.name === config) || info?.configs[0];
  const sp = cfg?.splits.find(s => s.name === split) || cfg?.splits[0];

  const pickConfig = (i: HubInfo, c: HubConfig) => {
    setConfig(c.name);
    const audio = c.columns.filter(x => x.type === "audio"), text = c.columns.filter(x => /string/.test(x.type));
    setAudioCol((audio[0] || c.columns[0])?.name || "");
    // the usual names for the transcript, the normalized one first
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
    sp.next_row ? `rows 0–${(sp.next_row - 1).toLocaleString()} already imported` : "",
    per ? `this import: rows ${s0.toLocaleString()}–${last != null ? last.toLocaleString() : "end"} in ${n} batch${n > 1 ? "es" : ""} of ${per}`
        : sp.bytes ? `the whole split (${fmtSize(sp.bytes)} to download)` : "the whole split",
    sp.partial ? "⚠ the Hub has parquet for only the first part of this split (about 5 GB): later rows cannot be imported" : ""].filter(Boolean).join(" · ") : "";

  const doImport = async () => {
    if (!info || !cfg || !sp) return;
    setBusy(true);
    try {
      const r = await api<{ datasets: DatasetSummary[]; warning?: string }>("/api/datasets", {
        repo: info.repo, config: cfg.name, split: sp.name, rows: sp.rows, columns: cfg.columns, token,
        audio_column: audioCol, text_column: textCol, name, start_row: start, max_rows: max, batches: max ? batches : 1, check });
      if (r.warning) notify(r.warning, "warn", 0);
      const k = r.datasets.length;
      notify((k > 1 ? `Importing ${k} batches of “${name}”` : `Importing “${r.datasets[0].name}”`) +
             " — the clips are downloaded and converted to 16 kHz in the background" + (check ? ", then checked by the ASR." : "."), "info");
      sp.next_row = Math.max(sp.next_row || 0, ...r.datasets.filter(d => d.batch && d.batch.end != null).map(d => d.batch!.end! + 1));
      if (max) setStart(String(sp.next_row)); else setInfo(null);   // ready for the next batches
      onImported();
    } catch (e: any) { notify("Import failed: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  const opts = (cols: { name: string; type: string }[]) => cols.map(x => <option key={x.name} value={x.name}>{x.name} ({x.type})</option>);
  return (
    <div className="panel">
      <b className="sec-title"><Icon name="download" /> Import from Hugging Face</b>
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
            <label className="fld"><span>Name</span><input value={name} onChange={e => setName(e.target.value)} /></label>
          </div>
          <div className="form-grid imp-grid">
            <label className="fld"><span>Start at row</span><input type="number" min="0" value={start} onChange={e => setStart(e.target.value)}
                                                                  title="The next row not imported yet is filled in" /></label>
            <label className="fld"><span>Rows per batch</span><input type="number" min="1" placeholder="All rows (one dataset)" value={max}
                     onChange={e => setMax(e.target.value)} title="A big dataset is cleaned in batches of e.g. 200 rows; each batch reads only its rows from the Hub" /></label>
            <label className="fld"><span>Batches</span><input type="number" min="1" max="100" value={batches} onChange={e => setBatches(e.target.value)} /></label>
            <label className="fld chk"><span>&nbsp;</span><span><input type="checkbox" checked={check} onChange={e => setCheck(e.target.checked)} /> Check with the ASR after import</span></label>
          </div>
          <div className="imp-row">
            <span className="muted">{summary}</span>
            <span style={{ flex: 1 }} />
            <button onClick={doImport} disabled={busy}><Icon name="download" /> Import</button>
          </div>
        </div>
      )}
    </div>
  );
}
