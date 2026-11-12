"use client";
// Load Data from a local folder: pick (or drop) a folder of audio files that already have their labels - a .txt / .json
// file per audio or a metadata file (json / csv / tsv / "file|text") - check how they were paired, then load them into
// a new task: one package per clip with its text filled in (no speech recognition needed). The files go up in parts
// (POST /api/tasks/<id>/files); a part that fails is sent again (the server skips the files it already has).
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { useNotify } from "@/components/notify";
import { api } from "@/lib/api";
import { fmtSize } from "@/lib/format";
import { AUDIO_EXTS, droppedFiles, scanFiles, type Pair, type Scan } from "@/lib/labels";
import type { TaskSummary } from "@/lib/types";

const PART_FILES = 25, PART_BYTES = 40e6, TRIES = 3, PREVIEW = 8;

async function sendPart(id: string, part: Pair[]) {
  const fd = new FormData();
  for (const p of part) fd.append("audio", p.file, p.name.split("/").pop());
  fd.append("names", JSON.stringify(part.map(p => p.name)));
  fd.append("texts", JSON.stringify(part.map(p => p.text || "")));
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(`/api/tasks/${id}/files`, { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { fatal: r.status < 500 });
      return j as { added: number; skipped: string[]; failed: { file: string; error: string }[]; duplicates?: number };
    } catch (e: any) {
      if (e.fatal || k >= TRIES) throw e;
      await new Promise(ok => setTimeout(ok, 1000 * k));
    }
  }
}

function parts(pairs: Pair[]) {
  const out: Pair[][] = [];
  let cur: Pair[] = [], bytes = 0;
  for (const p of pairs) {
    if (cur.length && (cur.length >= PART_FILES || bytes + p.file.size > PART_BYTES)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(p); bytes += p.file.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function FolderUploadPanel() {
  const { notify } = useNotify();
  const router = useRouter();
  const [scan, setScan] = useState<Scan | null>(null), [scanning, setScanning] = useState(false);
  const [name, setName] = useState(""), [withEmpty, setWithEmpty] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [over, setOver] = useState(false), [showAll, setShowAll] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null), filesInput = useRef<HTMLInputElement>(null);

  const read = async (files: File[]) => {
    if (!files.length) return;
    setScanning(true); setScan(null); setShowAll(false);
    try {
      const s = await scanFiles(files);
      if (!s.pairs.length) notify(`No audio file there (${AUDIO_EXTS.join(" ")}).`, "warn");
      else { setScan(s); setName(s.folder || ""); setWithEmpty(false); }
    } catch (e: any) { notify("Cannot read the folder: " + e.message, "error"); }
    finally { setScanning(false); }
  };

  const labelled = scan?.pairs.filter(p => p.text !== null) || [], missing = scan?.pairs.filter(p => p.text === null) || [];
  const empty = labelled.filter(p => !p.text).length;
  const send = scan ? (withEmpty ? scan.pairs : labelled) : [];
  const bytes = send.reduce((n, p) => n + p.file.size, 0);
  const fromTxt = labelled.filter(p => !scan?.metaFiles.includes(p.from)).length;

  const upload = async () => {
    if (!send.length) return;
    if (!name.trim()) return notify("Give the task a name.", "warn");
    setProgress({ done: 0, total: send.length });
    let ds: TaskSummary;
    try { ds = await api<TaskSummary>("/api/tasks/load/local", { name: name.trim() }); }
    catch (e: any) { setProgress(null); return notify("Loading failed: " + e.message, "error"); }
    const failed: { file: string; error: string }[] = [];
    let done = 0, added = 0, dups = 0;
    try {
      for (const part of parts(send)) {
        const r = await sendPart(ds.id, part);
        added += r.added + r.skipped.length; failed.push(...r.failed); dups += r.duplicates || 0;
        done += part.length; setProgress({ done, total: send.length });
      }
      await api(`/api/tasks/${ds.id}/finish`, {});
    } catch (e: any) {
      setProgress(null);
      return notify(`Loading stopped after ${done} of ${send.length} files: ${e.message}. The files already sent stay in the task “${ds.name}” — delete it in My Tasks and load again.`, "error", 0);
    }
    setProgress(null); setScan(null);
    notify(`Loaded ${added} clips into the task “${ds.name}” — each clip is a package with its text; assign the people in Members.`, "success");
    if (failed.length) notify(`${failed.length} file${failed.length > 1 ? "s" : ""} could not be read: ` +
                              failed.slice(0, 5).map(f => f.file).join(", ") + (failed.length > 5 ? ", …" : ""), "warn", 0);
    if (dups) notify(`${dups} clip${dups > 1 ? "s" : ""} look like audio already in the tool. Open Data → Duplicates to compare them and skip the copies before anyone annotates them.`, "warn", 0);
    router.push(`/tasks/${ds.id}`);
  };

  const rows = showAll ? scan?.pairs || [] : [...missing, ...labelled].slice(0, PREVIEW);
  return (
    <div className="panel">
      <b className="sec-title"><Icon name="upload" /> Load a local folder into a task</b>
      <p className="muted">Audio files that already have their labels: a text file with the same name next to each audio
        (<code>a.wav</code> + <code>a.txt</code> or <code>a.json</code>), or a metadata file such as <code>metadata.json</code>, <code>.jsonl</code>,
        <code>metadata.csv</code>, <code>.tsv</code> or <code>file|text</code> lines.</p>
      <input ref={folderInput} type="file" hidden multiple {...{ webkitdirectory: "", directory: "" } as any}
             onChange={e => { read([...(e.target.files || [])]); e.target.value = ""; }} />
      <input ref={filesInput} type="file" hidden multiple onChange={e => { read([...(e.target.files || [])]); e.target.value = ""; }} />
      <div className={`drop${over ? " over" : ""}`} role="button" tabIndex={0}
           onClick={() => folderInput.current?.click()} onKeyDown={e => { if (e.key === "Enter") folderInput.current?.click(); }}
           onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
           onDrop={async e => { e.preventDefault(); setOver(false); read(await droppedFiles(e.dataTransfer)); }}>
        <span>{scanning ? <><Icon name="loader" className="spin" /> Reading the labels…</>
                        : <><Icon name="inbox" /> Drop a folder here, or click to choose one</>}</span>
      </div>
      <div className="imp-row" style={{ marginTop: 6 }}>
        <button type="button" className="sec small" onClick={() => filesInput.current?.click()}>…or choose files (audio + labels)</button>
      </div>

      {scan && (
        <div>
          <div className="imp-summary">
            <span><b>{scan.pairs.length}</b> audio files</span>
            <span className="ok"><Icon name="check-circle" /> <b>{labelled.length}</b> with a label
              {labelled.length ? ` (${[fromTxt ? `${fromTxt} from text files` : "", ...scan.metaFiles.map(m => `${labelled.filter(p => p.from === m).length} from ${m}`)].filter(Boolean).join(", ")})` : ""}</span>
            {missing.length > 0 && <span className="bad"><Icon name="alert" /> <b>{missing.length}</b> without a label</span>}
            {empty > 0 && <span className="muted">{empty} labels are empty</span>}
            {scan.ignored > 0 && <span className="muted">{scan.ignored} other files ignored</span>}
          </div>
          <div className="pair-table-wrap">
            <table className="pair-table">
              <thead><tr><th>Audio file</th><th>Label</th></tr></thead>
              <tbody>{rows.map(p => (
                <tr key={p.name} className={p.text === null ? "missing" : ""}>
                  <td title={p.from ? `label from ${p.from}` : ""}>{p.name}</td>
                  <td>{p.text === null ? <i>no label found</i> : p.text || <i>empty</i>}</td>
                </tr>))}</tbody>
            </table>
          </div>
          {scan.pairs.length > PREVIEW && <button type="button" className="sec small" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer" : `Show all ${scan.pairs.length}`}</button>}
          <div className="form-grid imp-grid">
            <label className="fld"><span className="req">Task name</span><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. News recordings 2026" /></label>
            {missing.length > 0 && <label className="fld chk"><span>&nbsp;</span><span><input type="checkbox" checked={withEmpty} onChange={e => setWithEmpty(e.target.checked)} />
              Also upload the {missing.length} without a label (empty text)</span></label>}
          </div>
          <div className="imp-row">
            <span className="muted">{send.length} files · {fmtSize(bytes)} — converted to 16 kHz mono on the server</span>
            <span style={{ flex: 1 }} />
            {progress && <div className="up-progress"><div className="bar"><div style={{ width: `${100 * progress.done / progress.total}%` }} /></div>
              {progress.done} / {progress.total}</div>}
            <button type="button" className="sec" disabled={!!progress} onClick={() => setScan(null)}>Cancel</button>
            <button type="button" onClick={upload} disabled={!!progress || !send.length}>
              {progress ? <><Icon name="loader" className="spin" /> Loading…</> : <><Icon name="upload" /> Load {send.length} clips into a task</>}</button>
          </div>
        </div>
      )}
    </div>
  );
}
