"use client";
// Upload & Crop: upload several audio files, cut them (one or all), fix the cuts on the waveform, push the ticked
// ones to a new task.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CutEditorPanel } from "@/components/CutEditorPanel";
import { Icon } from "@/components/Icon";
import { useNotify } from "@/components/notify";
import { useCrumbs, useSession } from "@/components/session";
import { api, decodePeaks, del, getJson, uploadFile } from "@/lib/api";
import type { CutEditor, EditorHooks } from "@/lib/cut-editor";
import { fmtDur } from "@/lib/format";
import type { AudioSummary } from "@/lib/types";

type Item = Partial<AudioSummary> & { key: string; name: string; pick?: boolean; uploading?: boolean; progress?: number; error?: string; file?: File };

const THUMB_BUCKETS = 220;
const thumbs = new Map<string, Int8Array>();   // audio id -> min/max pairs
const isCut = (it: Item) => (it.count || 0) > 1 || !!it.chunk_seconds;
const ready = (it: Item) => !it.uploading && !it.error && !!it.id;
const isPicked = (it: Item) => ready(it) && (it.pick ?? isCut(it));   // what the user chose, else "is it cut yet"
let keySeq = 0;

export default function UploadPage() {
  useCrumbs([["Audio Annotation"], ["Upload & Crop"]]);
  const { can } = useSession();
  const { notify, askConfirm } = useNotify();
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const [openId, setOpenId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [chunk, setChunk] = useState("30");
  const [taskName, setTaskName] = useState("");
  const [pushed, setPushed] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const editor = useRef<CutEditor | null>(null);
  const hooks = useRef<Partial<EditorHooks>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const loadToken = useRef(0);
  const uploading = useRef(false);
  const queue = useRef<Item[]>([]);

  const cutSec = () => Math.max(1, Math.round(+chunk) || 30);
  const update = (fn: (list: Item[]) => Item[]) => setItems(list => fn(list));

  // the editor saves into the open audio and keeps its row's crop count in step
  hooks.current = {
    save: async segs => { if (editor.current?.session) await api(`/api/audios/${editor.current.session.id}/state`, { segments: segs }, "PUT"); },
    structure: () => {
      const ed = editor.current;
      if (ed?.session) update(l => l.map(it => it.id === ed.session!.id ? { ...it, count: ed.segs.filter(s => !s.deleted).length } : it));
    },
  };

  const openAudio = useCallback(async (it: Item) => {
    const ed = editor.current;
    if (!ed || !it.id || ed.session?.id === it.id) return;
    const token = ++loadToken.current;
    await ed.saveNow().catch(() => {});
    try {
      const [j, p] = await Promise.all([getJson<AudioSummary & { segments: any[] }>(`/api/audios/${it.id}`),
                                        getJson<{ peaks: string; rate: number }>(`/api/audios/${it.id}/peaks`)]);
      if (token !== loadToken.current) return;
      ed.load({ id: j.id, name: j.name, duration: j.duration, offset: 0 }, j.segments, decodePeaks(p.peaks), p.rate);
      setOpenId(j.id);
      setStatus("Fix the cuts: drag across the waveform to crop, drag a dark line to move a cut, double-click a line to merge, S to cut at the playhead.");
    } catch (e: any) { setStatus("Cannot open audio: " + e.message); }
  }, []);

  const closeAudio = () => { loadToken.current++; editor.current?.close(); setOpenId(null); };

  useEffect(() => {
    if (!can("audio.upload")) { router.replace("/tasks"); return; }
    getJson<{ audios: AudioSummary[] }>("/api/audios")
      .then(j => { const list = j.audios.map(a => ({ ...a, key: a.id })); setItems(list); if (list.length) setTimeout(() => openAudio(list[0]), 0); })
      .catch(e => setStatus("Cannot load audio: " + e.message));
  }, [can, router, openAudio]);

  useEffect(() => {                                       // save before leaving the page / logging out
    const flush = () => { editor.current?.saveNow().catch(() => {}); };
    const warn = (e: BeforeUnloadEvent) => { if (editor.current?.savePending) { flush(); e.preventDefault(); } };
    window.addEventListener("app:flush", flush);
    window.addEventListener("beforeunload", warn);
    return () => { flush(); window.removeEventListener("app:flush", flush); window.removeEventListener("beforeunload", warn); };
  }, []);

  // ---------- step 1: upload (one request per file, with progress) ----------
  const addFiles = async (files: FileList | File[]) => {
    const rows: Item[] = [...files].map(f => ({ key: `up${keySeq++}`, file: f, name: f.name, uploading: true, progress: 0 }));
    if (!rows.length) return;
    update(l => [...l, ...rows]);
    queue.current.push(...rows);
    if (uploading.current) return;                       // the running loop picks up the new rows
    uploading.current = true;
    let failed = 0;
    while (queue.current.length) {
      const row = queue.current.shift()!;
      try {
        const j = await uploadFile(row.file!, p => update(l => l.map(x => x.key === row.key ? { ...x, progress: p } : x)));
        update(l => l.map(x => x.key === row.key ? { ...j, key: row.key } : x));
        if (!editor.current?.session) await openAudio({ ...j, key: row.key });
      } catch (e: any) {
        failed++;
        update(l => l.map(x => x.key === row.key ? { ...x, uploading: false, error: `${row.name}: ${e.message}` } : x));
      }
    }
    uploading.current = false;
    setStatus(failed ? `${failed} file(s) could not be read — remove them and try another format.`
                     : "Upload finished. Choose a cut length, then “Cut selected audio” or “Cut all audio”.");
    notify(failed ? `${failed} file(s) could not be read. Remove them and try another format.` : "Upload finished. Choose a cut length, then cut the audio.",
           failed ? "error" : "success");
  };

  const removeItem = async (it: Item) => {
    if (it.error) return update(l => l.filter(x => x.key !== it.key));       // failed upload: just the row
    if (!await askConfirm(`Remove “${it.name}” from Upload & Crop? Its audio and cuts will be deleted.`, { title: "Remove audio", ok: "Remove", danger: true })) return;
    try { await del(`/api/audios/${it.id}`); } catch (e: any) { return notify("Delete failed: " + e.message, "error"); }
    notify(`“${it.name}” removed.`, "success");
    thumbs.delete(it.id!);
    const rest = itemsRef.current.filter(x => x.key !== it.key);
    setItems(rest);
    if (openId === it.id) { closeAudio(); const next = rest.find(ready); if (next) openAudio(next); }
  };

  // ---------- step 3: cut length ----------
  const recut = async (it: Item, sec: number) => {
    const j = await api(`/api/audios/${it.id}/recut`, { chunk_seconds: sec });
    update(l => l.map(x => x.key === it.key ? { ...x, count: j.segments.length, done: 0, todo: j.segments.length, chunk_seconds: sec, pick: undefined } : x));
    const ed = editor.current;
    if (ed && ed.session?.id === it.id) {                 // the open audio: show the new cuts (Ctrl+Z brings the old ones back)
      loadToken.current++;
      ed.pushUndo();
      ed.setSegments(j.segments);
      ed.savePending = false;                              // the server already saved them
      ed.updateUndo(); ed.requestDraw(); ed.seek(0);
    }
    return j.segments.length as number;
  };

  const cutOpen = async () => {
    const it = items.find(a => a.id === openId), ed = editor.current;
    if (!it || !ed) return;
    const sec = cutSec();
    if (ed.segs.length > 1 && !await askConfirm(`Cut “${it.name}” again into ${sec} s crops? Your current cuts are replaced (Ctrl+Z undoes it).`,
                                                { title: "Cut again", ok: "Cut" })) return;
    setBusy(true);
    try {
      await ed.saveNow();
      const n = await recut(it, sec);
      setStatus(`Cut “${it.name}” into ${n} crops of ${sec} s. Now check every cut on the waveform and fix the wrong ones.`);
      notify(`“${it.name}” cut into ${n} crops.`, "success");
    } catch (e: any) { notify("Cut failed: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  const cutAll = async () => {
    const list = items.filter(ready), sec = cutSec(), edited = list.filter(a => (a.count || 0) > 1).length;
    if (!await askConfirm(`Cut all ${list.length} audio into ${sec} s crops?` + (edited ? `\n\n${edited} of them are already cut — their cuts will be replaced.` : ""),
                          { title: "Cut all audio", ok: "Cut all" })) return;
    setBusy(true);
    try {
      await editor.current?.saveNow();
      for (const [k, it] of list.entries()) { setStatus(`Cutting ${k + 1} / ${list.length}: ${it.name}…`); await recut(it, sec); }
      setStatus(`Cut ${list.length} audio into ${sec} s crops. Click each audio to check and fix its cuts.`);
      notify(`${list.length} audio cut into ${sec} s crops.`, "success");
    } catch (e: any) { notify("Cut failed: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  // ---------- step 4: push the ticked audio to a new task ----------
  const placeholder = `Batch ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const push = async () => {
    const picked = items.filter(isPicked);
    if (!picked.length) return notify("Tick the audio you want to push.", "warn");
    if (uploading.current) return notify("Wait until all files are uploaded.", "warn");
    const uncut = picked.filter(a => !isCut(a));
    if (uncut.length && !await askConfirm(`${uncut.length} ticked audio are not cut yet (each is one long crop):\n` +
        uncut.slice(0, 5).map(a => "• " + a.name).join("\n") + (uncut.length > 5 ? "\n…" : "") + "\n\nPush anyway?", { title: "Push to task", ok: "Push anyway" })) return;
    setBusy(true);
    try {
      await editor.current?.saveNow();
      const task = await api("/api/tasks", { name: taskName.trim() || placeholder, audio_ids: picked.map(a => a.id) });
      setTaskName("");
      const rest = items.filter(a => !picked.includes(a));
      picked.forEach(a => thumbs.delete(a.id!));
      setItems(rest);
      notify(`Pushed ${picked.length} audio to “${task.name}”.`, "success");
      if (!rest.some(ready)) return router.push(`/tasks/${task.id}`);
      if (picked.some(a => a.id === openId)) { closeAudio(); const next = rest.find(ready); if (next) openAudio(next); }
      setPushed({ id: task.id, name: task.name });
      setStatus(`Pushed ${picked.length} audio to “${task.name}”. The other ${rest.length} audio stay here.`);
    } catch (e: any) { notify("Push failed: " + e.message, "error"); }
    finally { setBusy(false); }
  };

  const readyItems = items.filter(ready), picked = readyItems.filter(isPicked), uncut = picked.filter(a => !isCut(a)).length;
  const open = items.find(a => a.id === openId);
  const est = open ? Math.ceil((open.duration || 0) / cutSec()) : 0;

  return (
    <section>
      <div className="panel headcard">
        <h2>Upload &amp; Crop Audio</h2>
        <p>Upload one or more audio files, cut each one into crops and fix the cuts on the waveform, then tick the audio that are ready and push them to a task. The others stay here.</p>
      </div>

      <div className="panel">
        <div className="step"><span className="num">1</span> Upload audio</div>
        <label className={`drop${over ? " over" : ""}`}
               onDragEnter={e => { e.preventDefault(); setOver(true); }} onDragOver={e => { e.preventDefault(); setOver(true); }}
               onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files); }}>
          <input type="file" ref={fileInput} accept="audio/*,video/*" multiple hidden
                 onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
          <span><Icon name="upload" className="lg" /> Drop one or more audio files here, or <u>click to browse</u></span>
        </label>

        <div className="step"><span className="num">2</span> Audio files <span className="muted">{readyItems.length ? `(${readyItems.length})` : ""}</span></div>
        <div className="audio-list">
          {items.map(it => (
            <div key={it.key} tabIndex={ready(it) ? 0 : -1}
                 className={`audio-row${it.uploading ? " uploading" : ""}${it.error ? " failed" : ""}${it.id && it.id === openId ? " on" : ""}`}
                 onClick={e => { if (ready(it) && !(e.target as Element).closest(".ar-del, .ar-pick")) openAudio(it); }}
                 onKeyDown={e => { if (e.key === "Enter" && ready(it)) openAudio(it); }}>
              <input type="checkbox" className="ar-pick" title="Push this audio to the task" aria-label="Push this audio" disabled={!ready(it)}
                     checked={isPicked(it)} onChange={e => update(l => l.map(x => x.key === it.key ? { ...x, pick: e.target.checked } : x))} />
              <Thumb id={ready(it) ? it.id! : null} />
              <div className="ar-main"><div className="ar-name" title={it.name}>{it.name}</div>
                <div className="ar-info">
                  {it.uploading ? <><span>Uploading… {Math.round((it.progress || 0) * 100)}%</span>
                    <span className="bar"><div style={{ width: `${(it.progress || 0) * 100}%` }} /></span></>
                  : it.error ? <span className="errmsg">{it.error}</span>
                  : <><span className="pill dur"><Icon name="clock" />{fmtDur(it.duration || 0)}</span>
                      <span className={`pill ${isCut(it) ? "ok" : "warn"}`}>{isCut(it) ? <><Icon name="scissors" />{it.count} crops</> : "Not cut yet"}</span></>}
                </div></div>
              {!it.uploading && <button className="ar-del" title="Remove this audio" aria-label="Remove this audio" onClick={() => removeItem(it)}><Icon name="trash" /></button>}
            </div>
          ))}
        </div>
        {!items.length && <div className="list-empty">No audio yet — upload files above. Click a file to show its waveform.</div>}

        <div className="step"><span className="num">3</span> Cut length</div>
        <div className="row">
          <div className="presets" role="group" aria-label="Quick cut lengths">
            {[10, 20, 30].map(s => <button key={s} type="button" className={`sec preset${+chunk === s ? " on" : ""}`} onClick={() => setChunk(String(s))}>{s} s</button>)}
          </div>
          <label className="secs">
            <input type="number" value={chunk} min="1" step="1" aria-label="Cut length in seconds" onChange={e => setChunk(e.target.value)}
                   onBlur={() => setChunk(String(cutSec()))} onKeyDown={e => { if (e.key === "Enter" && open) cutOpen(); }} />
            <span>seconds</span>
          </label>
          <button disabled={!open || busy} title="Cut the audio shown on the waveform" onClick={cutOpen}><Icon name="scissors" /> Cut selected audio</button>
          <button className="sec" disabled={!readyItems.length || busy} title="Cut every audio in the list with this length" onClick={cutAll}><Icon name="scissors" /> Cut all audio</button>
          <span className="muted">{open ? `About ${est} crop${est === 1 ? "" : "s"} of ${cutSec()} s for “${open.name}”` : ""}</span>
        </div>
      </div>

      <CutEditorPanel hidden={!openId} title={open?.name || ""} duration={open?.duration || 0}
                      info={open?.created ? "Uploaded " + open.created : ""} hooks={hooks} status={status} setStatus={setStatus}
                      onReady={ed => { editor.current = ed; }} />

      {readyItems.length > 0 && (
        <div className="panel pushbar">
          <div className="step"><span className="num">4</span> Push to task
            <span className="pick-links">— tick the audio to push:{" "}
              <button type="button" className="link" onClick={() => update(l => l.map(a => ({ ...a, pick: true })))}>all</button>·
              <button type="button" className="link" onClick={() => update(l => l.map(a => ({ ...a, pick: isCut(a) })))}>cut only</button>·
              <button type="button" className="link" onClick={() => update(l => l.map(a => ({ ...a, pick: false })))}>none</button></span></div>
          <div className="row">
            <label className="secs">Task name <input size={28} aria-label="Task name" placeholder={placeholder} value={taskName} onChange={e => setTaskName(e.target.value)} /></label>
            <button disabled={!picked.length || busy} onClick={push}>Push {picked.length} selected audio to task <Icon name="arrow-right" /></button>
            <span className="muted">
              {pushed && <><Icon name="check" />Pushed to <Link href={`/tasks/${pushed.id}`}>{pushed.name}</Link> · </>}
              {picked.length} of {readyItems.length} audio ticked{picked.length < readyItems.length ? " — the others stay here" : ""}{uncut ? ` · ${uncut} ticked audio not cut yet` : ""}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

/** Waveform thumbnail of one audio (GET /api/audios/<id>/peaks?buckets=220, cached). */
function Thumb({ id }: { id: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    (async () => {
      if (!thumbs.has(id)) {
        try { thumbs.set(id, decodePeaks((await getJson<{ peaks: string }>(`/api/audios/${id}/peaks?buckets=${THUMB_BUCKETS}`)).peaks)); }
        catch { return; }
      }
      const cv = ref.current, a = thumbs.get(id)!;
      if (!live || !cv) return;
      const g = cv.getContext("2d")!, w = cv.width, h = cv.height, n = a.length / 2;
      let max = 1;
      for (let k = 0; k < a.length; k++) max = Math.max(max, Math.abs(a[k]));
      g.clearRect(0, 0, w, h);
      g.fillStyle = "#5f8a6a";
      for (let x = 0; x < w; x++) {
        const b = Math.floor(x / w * n), lo = a[2 * b], hi = a[2 * b + 1];
        const y1 = h / 2 - hi / max * (h / 2 - 2), y2 = h / 2 - lo / max * (h / 2 - 2);
        g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
    })();
    return () => { live = false; };
  }, [id]);
  return <canvas className="ar-thumb" width={220} height={44} ref={ref} />;
}
