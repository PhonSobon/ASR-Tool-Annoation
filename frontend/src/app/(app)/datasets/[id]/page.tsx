"use client";
// One imported dataset: quality overview, background jobs (checks, push), the review panel of one clip (waveform +
// trim, cut in parts / join, text vs ASR diff, normalized text, accept / use ASR text / reject) and the filtered,
// sorted clip list. Every decision is saved at once (PATCH /api/datasets/<id>/items/<n>); n = position of the clip
// in ds.items (cutting or joining a clip moves the ones after it, so the dataset is loaded again).
import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { HubPushDialog } from "@/components/HubPushDialog";
import { Icon } from "@/components/Icon";
import { JobBox, useJob } from "@/components/JobBox";
import { MembersDialog } from "@/components/MembersDialog";
import { Pager } from "@/components/Pager";
import { useNotify } from "@/components/notify";
import { useCrumbs, useSession } from "@/components/session";
import { api, download, getJson } from "@/lib/api";
import {
  CAT_LABEL, cerClass, clipLen, clipTrim, diff, FLAG_SHORT, fmtCer, REJECT_REASONS, rowLabel, STATUS_LABEL, type DiffRun,
} from "@/lib/dataset";
import { fmtHms, fmtT } from "@/lib/format";
import type { ClipItem, Dataset } from "@/lib/types";

type DsTab = "todo" | "accepted" | "rejected" | "all";
const TAB_TEXT: Record<DsTab, string> = { todo: "To review", accepted: "Accepted", rejected: "Rejected", all: "All" };

export default function DatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can, setSave, nameOf } = useSession();
  const { notify, askConfirm } = useNotify();
  const router = useRouter();
  const [ds, setDs] = useState<Dataset | null>(null);
  const dsRef = useRef<Dataset | null>(null);
  dsRef.current = ds;
  useCrumbs([["Dataset Cleaning"], ["Hugging Face Datasets", "/datasets"], [ds?.name || "…"]]);

  // list
  const [tab, setTab] = useState<DsTab>("todo");
  const [q, setQ] = useState(""), [cat, setCat] = useState(""), [flag, setFlag] = useState(""), [sort, setSort] = useState("cer");
  const [page, setPage] = useState(1), [per, setPer] = useState(20);
  // review panel
  const [rvN, setRvN] = useState(-1);
  const rvRef = useRef(-1);
  rvRef.current = rvN;
  const [text, setText] = useState(""), [norm, setNorm] = useState("");
  const [, bump] = useState(0);
  const pend = useRef({ text: false, norm: false });
  const timers = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({});
  const [cut, setCut] = useState<number | null>(null);
  const [wave, setWave] = useState<{ data: Float32Array; rate: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [checking, setChecking] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textBox = useRef<HTMLTextAreaElement>(null);
  // output
  const [include, setInclude] = useState("accepted"), [trimOut, setTrimOut] = useState(true), [passCer, setPassCer] = useState(10);
  const [pushing, setPushing] = useState(false), [members, setMembers] = useState(false);

  const a = ds?.access;
  const it = ds && rvN >= 0 ? ds.items[rvN] : null;

  // ---------- order of the list ----------
  /** the filters except the tab (the tab counts use them too). A number finds that row; text is searched in the
   *  reviewed text, the original text and what the ASR heard. */
  const matches = useCallback((x: ClipItem) => {
    const ql = q.trim().toLowerCase();
    return (!cat || x.category === cat) && (!flag || x.flags.includes(flag)) &&
           (!ql || String(x.idx) === ql || rowLabel(x) === ql || x.text.toLowerCase().includes(ql) ||
            (x.original_text || "").toLowerCase().includes(ql) || (x.asr_text || "").toLowerCase().includes(ql));
  }, [q, cat, flag]);
  const order = useCallback((d = dsRef.current) => {
    if (!d) return [];
    const list = d.items.map((_, n) => n).filter(n => (tab === "all" || d.items[n].status === tab) && matches(d.items[n]));
    const rank: Record<string, number> = { bad: 0, review: 1, unchecked: 2, pass: 3 }, I = (n: number) => d.items[n];
    const cmp: Record<string, (a: number, b: number) => number> = {
      row: (x, y) => I(x).idx - I(y).idx || (I(x).part || 0) - (I(y).part || 0),
      long: (x, y) => I(y).duration - I(x).duration, short: (x, y) => I(x).duration - I(y).duration,
      cer: (x, y) => rank[I(x).category] - rank[I(y).category] || (I(y).cer ?? -1) - (I(x).cer ?? -1) || I(x).idx - I(y).idx || (I(x).part || 0) - (I(y).part || 0),
    };
    return list.sort(cmp[sort]);
  }, [tab, matches, sort]);

  // ---------- load ----------
  useEffect(() => {
    audio.current = new Audio();
    const el = audio.current;
    el.onplay = () => setPlaying(true);
    el.onpause = () => setPlaying(false);
    getJson<Dataset>(`/api/datasets/${id}`).then(d => {
      setDs(d);
      setPassCer(Math.round(d.cer_pass * 100));
      const t: DsTab = d.status_counts.todo ? "todo" : "all";
      setTab(t);
    }).catch(e => { notify("Cannot open this page: " + e.message, "error"); router.replace("/datasets"); });
    return () => { el.pause(); el.removeAttribute("src"); };
  }, [id, notify, router]);

  useEffect(() => {                                           // the first clip once the dataset is there
    if (ds && rvRef.current < 0) { const first = order(ds)[0]; if (first !== undefined) showClip(first, false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds === null]);

  const reload = async () => {   // keep the open clip and the text being typed
    const fresh = await getJson<Dataset>(`/api/datasets/${id}`);
    const n = rvRef.current;
    if (n >= 0 && pend.current.text && fresh.items[n]) fresh.items[n].text = text;
    setDs(fresh);
  };

  // ---------- jobs: checks, push ----------
  const job = useJob(`/api/datasets/${id}/job`, async j => {
    await reload();
    if (j.error) notify(`${j.kind === "push" ? "Push" : "Job"} failed: ${j.error}`, "error");
    else notify(j.message, "success", j.kind === "push" ? 0 : 5000);
  }, (j, tick) => { if (j.kind === "check" && tick % 6 === 0) reload(); });   // CER appears while it runs

  // ---------- saving one clip ----------
  const patchItem = async (n: number, changes: Record<string, unknown>) => {
    if (!dsRef.current?.access?.review) throw new Error("You are not a reviewer of this dataset (read only)");
    const updated = await api<ClipItem>(`/api/datasets/${id}/items/${n}`, changes, "PATCH");
    setDs(d => d && { ...d, items: d.items.map((x, k) => k === n ? updated : x) });
    if (dsRef.current) dsRef.current.items[n] = updated;
    return updated;
  };

  const saveText = async () => {
    clearTimeout(timers.current.text);
    const n = rvRef.current;
    if (!pend.current.text || n < 0) return;
    pend.current.text = false;
    try { await patchItem(n, { text: textBox.current?.value ?? text }); setSave("All changes saved", "ok"); }
    catch (e: any) { pend.current.text = true; notify("Text not saved: " + e.message, "error"); setSave("Not saved: " + e.message, "err"); }
  };
  const saveNorm = async (value?: string) => {
    clearTimeout(timers.current.norm);
    const n = rvRef.current;
    if (!pend.current.norm || n < 0) return;
    pend.current.norm = false;
    try { const x = await patchItem(n, { norm: value ?? norm }); fillNorm(x); setSave("All changes saved", "ok"); }
    catch (e: any) { pend.current.norm = true; notify("Normalized text not saved: " + e.message, "error"); setSave("Not saved: " + e.message, "err"); }
  };
  const flush = async () => { await saveText(); await saveNorm(); };
  useEffect(() => {
    const f = () => { flush(); };
    window.addEventListener("app:flush", f);
    return () => { window.removeEventListener("app:flush", f); };
  });

  // normalized text: automatic (made from the final text) until a reviewer types it
  const fillNorm = (x: ClipItem) => {
    pend.current.norm = false;
    setNorm(x.norm ?? "");
    if (x.norm == null) autoNorm(x, x.text);
  };
  const autoNorm = async (x: ClipItem, t: string) => {
    if (x.norm != null || pend.current.norm) return;
    let v = "";
    if (t.trim()) { try { v = (await api("/api/text/normalize", { text: t })).normalized; } catch { return; } }
    if (dsRef.current?.items[rvRef.current] === x && !pend.current.norm) setNorm(v);
  };

  // ---------- open a clip ----------
  const showClip = async (n: number, play: boolean) => {
    await flush();
    const d = dsRef.current!;
    setRvN(n); rvRef.current = n; setCut(null); setWave(null);
    const x = d.items[n];
    setText(x.text); pend.current.text = false;
    fillNorm(x);
    const k = order(d).indexOf(n);
    if (k >= 0) setPage(Math.floor(k / per) + 1);
    const el = audio.current!;
    el.pause();
    try {
      const buf = await (await fetch(`/api/datasets/${id}/clips/${n}`)).arrayBuffer();
      if (rvRef.current !== n) return;
      el.src = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      el.currentTime = clipTrim(x)[0];
      audioCtx.current = audioCtx.current || new AudioContext();
      const decoded = await audioCtx.current.decodeAudioData(buf);
      if (rvRef.current !== n) return;
      setWave({ data: decoded.getChannelData(0), rate: decoded.sampleRate });
      if (play) playClip();
    } catch (e: any) { notify("Cannot load the clip: " + e.message, "error"); }
  };

  // ---------- waveform + playback ----------
  const draw = useCallback(() => {
    const cv = canvas.current, d = dsRef.current, n = rvRef.current;
    if (!cv) return;
    const w = cv.clientWidth || 600, h = cv.clientHeight || 72, dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!d || n < 0) return;
    const x0 = d.items[n], dur = x0.duration || 1, X = (t: number) => t / dur * w, [s, e] = clipTrim(x0);
    if (wave) {
      const data = wave.data, perPx = data.length / w;
      g.fillStyle = "#3b82f6";
      for (let px = 0; px < w; px++) {
        let lo = 0, hi = 0;
        for (let i = Math.floor(px * perPx), end = Math.min(data.length, Math.floor((px + 1) * perPx)); i < end; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        g.fillRect(px, h / 2 - hi * h / 2, 1, Math.max(1, (hi - lo) * h / 2));
      }
    } else { g.fillStyle = "#94a3b8"; g.font = "12px sans-serif"; g.fillText("Loading…", 10, h / 2 + 4); }
    g.fillStyle = "rgba(100,116,139,.35)";                // the parts that are cut off
    g.fillRect(0, 0, X(s), h); g.fillRect(X(e), 0, w - X(e), h);
    g.fillStyle = "#f59e0b";                              // where the other parts of the row are cut
    d.items.filter(o => o.idx === x0.idx && o !== x0).forEach(o => clipTrim(o).forEach(t => { if (t > 0 && t < dur) g.fillRect(X(t) - 1, 0, 2, h); }));
    if (cut != null) {                                    // where "Cut here" cuts
      g.strokeStyle = "#10b981"; g.lineWidth = 2; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(X(cut), 0); g.lineTo(X(cut), h); g.stroke(); g.setLineDash([]);
    }
    g.fillStyle = "#ef4444"; g.fillRect(X(audio.current?.currentTime || s) - 1, 0, 2, h);   // playhead
  }, [wave, cut]);

  const [, setClock] = useState(0);
  useEffect(() => { draw(); });
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    let raf = 0;
    const tick = () => { draw(); setClock(c => c + 1); if (!el.paused) raf = requestAnimationFrame(tick); };
    el.ontimeupdate = () => {
      const d = dsRef.current, n = rvRef.current;
      if (d && n >= 0 && el.currentTime >= clipTrim(d.items[n])[1]) el.pause();
    };
    if (playing) raf = requestAnimationFrame(tick);
    window.addEventListener("resize", draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", draw); };
  }, [playing, draw]);

  const playClip = () => {
    const d = dsRef.current, n = rvRef.current, el = audio.current!;
    if (!d || n < 0) return;
    const [s, e] = clipTrim(d.items[n]);
    if (el.currentTime < s || el.currentTime >= e - 0.02) el.currentTime = s;
    el.play().catch(() => {});
  };
  const canCut = (t: number) => { const [s, e] = clipTrim(dsRef.current!.items[rvRef.current]); return t >= s + 0.1 && t <= e - 0.1; };
  const toggleClip = () => {
    const el = audio.current!;
    if (el.paused) return playClip();
    el.pause();
    if (canCut(el.currentTime)) setCut(el.currentTime);   // paused where to cut
  };

  // ---------- decisions ----------
  const decide = async (status: "accepted" | "rejected", reason = "") => {
    const n = rvRef.current, d = dsRef.current;
    if (n < 0 || !d) return;
    const before = order(d), k = before.indexOf(n);
    audio.current?.pause();
    try {
      const typed = pend.current.text ? { text: textBox.current?.value ?? text } : {};
      await flush();
      await patchItem(n, { status, reason, ...typed });
    } catch (e: any) { return notify("Not saved: " + e.message, "error"); }
    const after = order(dsRef.current!), pos = after.indexOf(n);
    const next = pos >= 0 ? after[pos + 1] : after[Math.max(0, Math.min(k, after.length - 1))];
    if (next === undefined || (pos >= 0 && pos === after.length - 1)) return notify("That was the last clip in this list.", "success");
    showClip(next, true);
  };
  const step = (dlt: number) => {
    const o = order(), k = o.indexOf(rvRef.current), next = o[k < 0 ? 0 : k + dlt];
    if (next !== undefined) showClip(next, true);
  };
  const setTrim = async (trim: [number, number] | null) => {
    try { await patchItem(rvRef.current, { trim }); } catch (e: any) { notify("Trim not saved: " + e.message, "error"); }
  };
  const editText = (v: string) => {
    setText(v);
    pend.current.text = true;
    const x = dsRef.current!.items[rvRef.current];
    clearTimeout(timers.current.auto);
    timers.current.auto = setTimeout(() => autoNorm(x, v), 300);
    clearTimeout(timers.current.text);
    timers.current.text = setTimeout(saveText, 700);
    bump(b => b + 1);
  };
  const editNorm = (v: string) => {
    setNorm(v);
    pend.current.norm = true;
    clearTimeout(timers.current.norm);
    timers.current.norm = setTimeout(() => saveNorm(v), 700);
    bump(b => b + 1);
  };

  // ---------- cut in parts / join / check one clip ----------
  const reloadAt = async (n: number) => {
    const fresh = await getJson<Dataset>(`/api/datasets/${id}`);
    setDs(fresh); dsRef.current = fresh;
    await showClip(n, false);
    return fresh;
  };
  const recheck = async (ns: number[]) => {
    for (const n of ns) {
      try {
        const x = await api<ClipItem>(`/api/datasets/${id}/items/${n}/recognize`, {});
        const keepText = n === rvRef.current && pend.current.text ? (textBox.current?.value ?? x.text) : x.text;
        setDs(d => d && { ...d, items: d.items.map((y, k) => k === n ? { ...x, text: keepText } : y) });
      } catch (e: any) { return notify("Check failed: " + e.message, "error"); }
    }
  };
  const splitHere = async () => {
    const n = rvRef.current, at = cut ?? audio.current!.currentTime;   // the marker, not the playhead that moved on
    if (n < 0) return;
    if (!canCut(at)) return notify("Click the waveform (or play and pause) where the clip should be cut, then press “Cut here”.", "info");
    audio.current!.pause();
    try { await flush(); await api(`/api/datasets/${id}/items/${n}/split`, { at }); }
    catch (e: any) { return notify("Not cut: " + e.message, "error"); }
    const fresh = await reloadAt(n);
    notify(`Cut at ${at.toFixed(2)} s. The first part keeps the text — move the words that belong to the second part.`, "success");
    if (fresh.items.some(x => x.asr_text != null)) recheck([n, n + 1]);
  };
  const joinNext = async () => {
    const n = rvRef.current;
    audio.current!.pause();
    try { await flush(); await api(`/api/datasets/${id}/items/${n}/join`, {}); }
    catch (e: any) { return notify("Not joined: " + e.message, "error"); }
    const fresh = await reloadAt(n);
    if (fresh.items.some(x => x.asr_text != null)) recheck([n]);
  };

  // ---------- keyboard ----------
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (rvRef.current < 0 || document.querySelector("dialog[open]")) return;
      const t = e.target as HTMLElement;
      if (t.dataset?.rv) {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); decide("accepted"); }
        else if (e.key === "Escape") t.blur();
        return;
      }
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || e.ctrlKey || e.metaKey || e.altKey || !dsRef.current) return;
      const x = dsRef.current.items[rvRef.current], rv = !!dsRef.current.access?.review;
      const acts: Record<string, () => void> = {
        " ": toggleClip, j: () => step(1), arrowdown: () => step(1), k: () => step(-1), arrowup: () => step(-1),
        ...(rv ? { a: () => decide("accepted"), r: () => decide("rejected", reason || "Other"), u: useAsr, e: () => textBox.current?.focus(),
                   t: () => autoTrim(x), s: splitHere } : {}),
      };
      const act = acts[e.key.toLowerCase()];
      if (act) { e.preventDefault(); act(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });

  const [reason, setReason] = useState("");
  useEffect(() => { setReason(it?.status === "rejected" ? it.reason : ""); }, [it?.status, it?.reason, rvN]);
  const useAsr = () => {
    const x = dsRef.current?.items[rvRef.current];
    if (!x) return;
    if (x.asr_text == null) return notify("Run the checks first — there is no ASR text yet.", "info");
    editText(x.asr_text);
  };
  const autoTrim = (x: ClipItem) => {
    const au = x.audio || {};
    setTrim([Math.max(0, (au.speech_start ?? 0) - 0.2), Math.min(x.duration, (au.speech_end ?? x.duration) + 0.2)]);
  };

  // ---------- toolbar actions ----------
  const runChecks = async () => {
    const checked = ds!.items.filter(x => x.asr_text != null).length, redo = checked === ds!.items.length;
    if (redo && !await askConfirm("Every clip is already checked. Recognize all of them again?", { title: "Re-run checks", ok: "Re-run" })) return;
    try { await api(`/api/datasets/${id}/check`, { redo }); job.start(); }
    catch (e: any) { notify("Cannot start the checks: " + e.message, "error"); }
  };
  const acceptPassing = async () => {
    const max = (passCer || 0) / 100;
    const n = ds!.items.filter(x => x.status === "todo" && x.category === "pass" && x.cer != null && x.cer <= max).length;
    if (!n) return notify(ds!.items.some(x => x.asr_text != null) ? "No clip to review passed the checks with that CER." : "Run the checks first.", "info");
    if (!await askConfirm(`Accept ${n} clips that passed the checks (CER ≤ ${Math.round(max * 100)}% and no problems found)?`,
                          { title: "Accept passing clips", ok: `Accept ${n}` })) return;
    try { const r = await api(`/api/datasets/${id}/accept-passing`, { max_cer: max }); notify(`${r.accepted} clips accepted.`, "success"); await reload(); }
    catch (e: any) { notify(e.message, "error"); }
  };
  const saveMembers = async (m: Record<string, string[]>) => {
    try { const r = await api(`/api/datasets/${id}/members`, m, "PUT"); setDs(d => d && { ...d, members: r.members }); }
    catch (e: any) { return notify("Members not saved: " + e.message, "error"); }
    setMembers(false);
    notify("Reviewers saved.", "success");
  };
  const pushItems = () => ds!.items.filter(x => include === "all" || (include === "accepted" ? x.status === "accepted" : x.status !== "rejected"));

  if (!ds) return null;
  const its = ds.items, by = (k: "status" | "category", v: string) => its.filter(x => x[k] === v);
  const dur = (l: ClipItem[]) => l.reduce((s, x) => s + clipLen(x), 0);
  const checked = its.filter(x => x.asr_text != null).length, accd = by("status", "accepted"), fixed = accd.filter(x => x.text !== x.original_text).length;
  const list = order(ds), pages = Math.max(1, Math.ceil(list.length / per)), pg = Math.min(page, pages), shown = list.slice((pg - 1) * per, pg * per);
  const k = rvN >= 0 ? list.indexOf(rvN) : -1;
  const others = it ? its.filter(x => x.idx === it.idx && x !== it) : [];
  const [diffA, diffB]: [DiffRun[], DiffRun[]] = it && it.asr_text != null ? diff(text, it.asr_text) : [[{ text, bad: false }], []];
  const trim = it ? clipTrim(it) : [0, 0];
  const now = audio.current?.currentTime || trim[0];
  const ro = !a?.review;

  return (
    <section>
      <div className="panel headcard">
        <div className="task-head">
          <div>
            <h2>{ds.name}</h2>
            <p><a href={`https://huggingface.co/datasets/${ds.repo}`} target="_blank" rel="noopener">{ds.repo}</a>
              {" "}· {ds.config} / {ds.split} · text column <b>{ds.text_column}</b></p>
            <p>{ds.members?.length ? `Reviewers: ${ds.members.map(nameOf).join(", ")}` : a?.manage ? "Nobody is assigned yet — press Members." : ""}
              {ro && !a?.manage ? " · read only" : ""}</p>
          </div>
          <button className="sec back" onClick={() => router.push("/datasets")}><Icon name="arrow-left" /> Back</button>
        </div>
      </div>

      <div className="panel">
        <div className="info-box">
          <span className="info-i"><Icon name="info" /></span>
          <div className="grow">
            <div className="info-title">Quality overview</div>
            <div className="info-stats">
              <span>Clips: <b>{its.length}</b> ({fmtHms(dur(its))})</span>
              <span>Checked by ASR: <b>{checked}</b> / {its.length}</span>
              {(["pass", "review", "bad", "unchecked"] as const).map(c => <span key={c}><span className={`dot c-${c}`} />{CAT_LABEL[c]}: <b>{by("category", c).length}</b></span>)}
              <span><span className="dot c-accepted" />Accepted: <b>{accd.length}</b> ({fmtHms(dur(accd))}{fixed ? `, ${fixed} text fixed` : ""})</span>
              <span><span className="dot c-rejected" />Rejected: <b>{by("status", "rejected").length}</b></span>
              <span>To review: <b>{by("status", "todo").length}</b></span>
            </div>
            <div className="cat-bar">{(["pass", "review", "bad", "unchecked"] as const).map(c =>
              <div key={c} className={`c-${c}`} style={{ width: `${100 * by("category", c).length / (its.length || 1)}%` }} title={CAT_LABEL[c]} />)}</div>
          </div>
        </div>

        <div className="pkg-actions">
          {a?.manage && <button className="sec" title="Choose who reviews the clips of this dataset" onClick={() => setMembers(true)}><Icon name="users" /> Members</button>}
          {a?.manage && <button className="sec" disabled={job.running} onClick={runChecks} title="Recognize every clip with the local ASR and compare it with its text">
            <Icon name="recognize" />{checked && checked === its.length ? " Re-run checks" : checked ? ` Check the other ${its.length - checked}` : " Run checks"}</button>}
          {a?.bulk_accept && <>
            <button className="sec" onClick={acceptPassing} title="Accept every clip to review that passed the checks"><Icon name="check-circle" /> Accept passing clips</button>
            <label className="muted inline">CER ≤ <input type="number" min="0" max="100" step="1" className="num" value={passCer} onChange={e => setPassCer(+e.target.value)} /> %</label>
          </>}
          {(can("data.export") || can("hub.push")) && <>
            <span className="sep" />
            <label className="muted inline">Output{" "}
              <select value={include} onChange={e => setInclude(e.target.value)}>
                <option value="accepted">Accepted clips only</option>
                <option value="not_rejected">Everything except rejected</option>
                <option value="all">All clips (with review status)</option>
              </select></label>
            <label className="muted inline"><input type="checkbox" checked={trimOut} onChange={e => setTrimOut(e.target.checked)} /> Trim long silence</label>
          </>}
          {can("data.export") && <button className="sec" onClick={async () => { await flush(); download(`/api/datasets/${id}/export?include=${include}&trim=${trimOut ? 1 : 0}`);
                                                                   notify("Preparing the ZIP — it downloads in a moment.", "info"); }}><Icon name="download" /> Export ZIP</button>}
          {can("hub.push") && <button disabled={job.running} onClick={async () => { await flush(); setPushing(true); }}><Icon name="upload" /> Push to Hugging Face</button>}
        </div>
        {job.visible && job.job && <JobBox job={job.job} stopUrl={`/api/datasets/${id}/stop`} canStop={!!a?.manage} />}

        {it && (
          <div className="rv">
            <div className="rv-head">
              <b>{`Row ${it.idx}` + (it.part ? ` · part ${it.part} of ${others.length + 1}` : "") + ` · ${clipLen(it).toFixed(2)} s` + (it.source_file ? ` · ${it.source_file}` : "")}</b>
              <span className={`badge ${it.category}`}>{CAT_LABEL[it.category]}</span>
              <span className={`badge ${it.status}`}>{STATUS_LABEL[it.status] + (it.status === "rejected" && it.reason ? `: ${it.reason}` : "")}</span>
              <span style={{ flex: 1 }} />
              <span className="pkg-nav">
                <button className="sec small" title="Previous clip (K or ↑)" aria-label="Previous clip" disabled={k <= 0} onClick={() => step(-1)}><Icon name="chevron-left" /></button>
                <span>{k >= 0 ? `${k + 1} / ${list.length}` : "–"}</span>
                <button className="sec small" title="Next clip (J or ↓)" aria-label="Next clip" disabled={k < 0 || k >= list.length - 1} onClick={() => step(1)}><Icon name="chevron-right" /></button>
              </span>
            </div>
            <div className="rv-wave">
              <button className="play" title="Play / pause (Space)" aria-label="Play / pause" onClick={toggleClip}><Icon name={playing ? "pause" : "play"} /></button>
              <canvas ref={canvas} height={72} onClick={e => {
                const r = (e.target as HTMLCanvasElement).getBoundingClientRect(), [s, en] = trim;
                const t = Math.max(s, Math.min(en - 0.05, (e.clientX - r.left) / r.width * it.duration));
                setCut(canCut(t) ? t : null);
                audio.current!.currentTime = t;
                playClip();
              }} />
            </div>
            <div className="rv-trim muted">
              <span>{`${fmtT(Math.max(0, now - trim[0]))} / ${fmtT(trim[1] - trim[0])}`}</span>
              <span style={{ flex: 1 }} />
              Keep <input type="number" step="0.05" min="0" max={it.duration} className="num" readOnly={ro} key={`s${rvN}-${trim[0]}`} defaultValue={trim[0].toFixed(2)}
                          onBlur={e => +e.target.value !== trim[0] && setTrim([+e.target.value, trim[1]])} /> –
              <input type="number" step="0.05" min="0" max={it.duration} className="num" readOnly={ro} key={`e${rvN}-${trim[1]}`} defaultValue={trim[1].toFixed(2)}
                     onBlur={e => +e.target.value !== trim[1] && setTrim([trim[0], +e.target.value])} /> s
              {!ro && <>
                <button className="link" title="Cut the silence at both ends (T)" onClick={() => autoTrim(it)}>Trim silence</button>
                <button className="link" onClick={() => setTrim(null)}>Keep whole clip</button>
                <span className="sep" />
                <button className="sec small" title="Cut the clip in two at the green marker (S) - click the waveform (or pause) where to cut" onClick={splitHere}><Icon name="scissors" /> Cut here</button>
                {others.some(x => clipTrim(x)[0] > trim[0]) && <button className="sec small" title="Join this part with the next part of the same row" onClick={joinNext}>Join next part</button>}
              </>}
              <button className="sec small" title="Download this clip as WAV (its trim applied)" onClick={() => download(`/api/datasets/${id}/items/${rvN}/audio`)}><Icon name="download" /> Download</button>
            </div>
            <div className="rv-texts">
              <div><div className="rv-lab">Dataset text</div><div className="rv-diff">{diffA.map((r, i) => r.bad ? <span key={i} className="del">{r.text}</span> : r.text)}</div></div>
              <div><div className="rv-lab">ASR heard <span className={`pill ${cerClass(it.cer, ds.cer_pass)}`}>{it.asr_text == null ? "–" : "CER " + fmtCer(it.cer)}</span>
                {!ro && can("asr.run") && <button className="link" disabled={checking} title="Recognize this clip again (its trim applied)"
                  onClick={async () => { setChecking(true); await flush(); await recheck([rvN]); setChecking(false); }}>Check this clip</button>}</div>
                <div className="rv-diff">{checking ? <span className="muted"><Icon name="loader" className="spin" /> Recognizing…</span>
                  : it.asr_text == null ? <span className="muted">Not checked yet — press “Run checks”.</span>
                  : diffB.map((r, i) => r.bad ? <span key={i} className="ins">{r.text}</span> : r.text)}</div></div>
            </div>
            <label className="rv-lab" htmlFor="rvText">Final text <span className="muted">{pend.current.text ? "(saving…)" : it.text !== it.original_text ? "(edited)" : ""}</span></label>
            <textarea id="rvText" data-rv="1" ref={textBox} rows={2} lang="km" readOnly={ro} value={text} onChange={e => editText(e.target.value)} />
            <div className="rv-lab rv-lab-row">
              <label htmlFor="rvNorm">Normalized text <span className="muted">{pend.current.norm ? "(saving…)" : it.norm != null ? "(edited)" : "(automatic)"}</span></label>
              {it.norm != null && !ro && <button className="link" title="Make it again from the final text" onClick={() => { pend.current.norm = true; saveNorm(""); }}><Icon name="restore" /> Auto-normalize</button>}
            </div>
            <textarea id="rvNorm" data-rv="1" rows={2} lang="km" readOnly={ro} value={norm} onChange={e => editNorm(e.target.value)}
                      title="Zero-width spaces removed, Khmer digits written 0-9, words separated by spaces" />
            <div className="rv-flags">{it.flags.map(f => <span key={f} className={`flag ${ds.flag_info[f]?.severity}`}>{ds.flag_info[f]?.text || f}</span>)}</div>
            {!ro && <div className="rv-actions">
              <button title="Accept (A, or Ctrl+Enter while typing)" onClick={() => decide("accepted")}><Icon name="check" /> Accept</button>
              <button className="sec" title="Use the ASR text (U)" onClick={useAsr}>Use ASR text</button>
              <button className="sec" title="Back to the dataset text" onClick={() => editText(it.original_text)}><Icon name="restore" /> Original text</button>
              <span style={{ flex: 1 }} />
              <select aria-label="Reject reason" value={reason} onChange={e => setReason(e.target.value)}>
                <option value="">Reject reason…</option>{REJECT_REASONS.map(r => <option key={r}>{r}</option>)}
              </select>
              <button className="stop" title="Reject (R)" onClick={() => decide("rejected", reason || "Other")}><Icon name="x" /> Reject</button>
            </div>}
            <div className="muted rv-keys">Keys: <b>Space</b> play · <b>A</b> accept · <b>U</b> use ASR text · <b>R</b> reject · <b>T</b> trim silence · <b>S</b> cut at the green marker · <b>J/K</b> next/previous · <b>E</b> edit text · <b>Ctrl+Enter</b> accept while typing</div>
          </div>
        )}

        <div className="crop-tabs" role="tablist" aria-label="Clips">
          {(Object.keys(TAB_TEXT) as DsTab[]).map(t => (
            <button key={t} type="button" role="tab" className={t === tab ? "on" : ""} aria-selected={t === tab} onClick={() => { setTab(t); setPage(1); }}>
              {TAB_TEXT[t]}<span className="n">{its.filter(x => (t === "all" || x.status === t) && matches(x)).length}</span></button>))}
        </div>
        <div className="filter-bar">
          <div className="search sm"><input type="search" placeholder="Text or row number" aria-label="Search text or row number" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />
            <button type="button" tabIndex={-1} aria-hidden="true"><Icon name="search" /></button></div>
          <select aria-label="Filter by check result" value={cat} onChange={e => { setCat(e.target.value); setPage(1); }}>
            <option value="">Every check result</option><option value="bad">Likely bad</option><option value="review">Needs review</option>
            <option value="pass">Passed</option><option value="unchecked">Not checked yet</option></select>
          <select aria-label="Filter by problem" value={flag} onChange={e => { setFlag(e.target.value); setPage(1); }}>
            <option value="">Every problem</option>{Object.keys(ds.flag_info).map(f2 => [f2, its.filter(x => x.flags.includes(f2)).length] as const)
              .filter(([f2, n]) => n || f2 === flag).map(([f2, n]) => <option key={f2} value={f2}>{FLAG_SHORT[f2] || f2} ({n})</option>)}</select>
          <select aria-label="Sort" value={sort} onChange={e => { setSort(e.target.value); setPage(1); }}>
            <option value="cer">Worst first (CER)</option><option value="row">Row order</option>
            <option value="long">Longest first</option><option value="short">Shortest first</option></select>
          {(q || cat || flag) && <button type="button" className="sec" onClick={() => { setQ(""); setCat(""); setFlag(""); setPage(1); }}>Clear</button>}
        </div>
        <div className="table-wrap">
          <table className="pkg-table ds-table">
            <thead><tr><th>Row</th><th>Duration</th><th>Text</th><th>ASR heard</th><th>CER</th><th>Problems</th><th>Status</th></tr></thead>
            <tbody>
              {shown.map(n => {
                const x = its[n];
                return (
                  <tr key={n} className={n === rvN ? "on" : ""} onClick={() => showClip(n, true)}>
                    <td>{rowLabel(x)}</td><td>{clipLen(x).toFixed(1)} s</td>
                    <td className="t" lang="km" title={x.text}>{x.text || <span className="muted">(empty)</span>}</td>
                    <td className="t" lang="km" title={x.asr_text || ""}>{x.asr_text ?? "–"}</td>
                    <td><span className={`pill ${cerClass(x.cer, ds.cer_pass)}`}>{fmtCer(x.cer)}</span></td>
                    <td><div className="flags">{x.flags.map(f2 => <span key={f2} className={`flag ${ds.flag_info[f2]?.severity || "info"}`} title={ds.flag_info[f2]?.text || f2}>{FLAG_SHORT[f2] || f2}</span>)}</div></td>
                    <td><span className={`badge ${x.status}`}>{STATUS_LABEL[x.status]}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!list.length && <div className="pkg-empty"><div className="pkg-empty-icon"><Icon name="inbox" className="xl" /></div>
            {q || cat || flag ? `No clip in ${TAB_TEXT[tab]} matches these filters.` : `No clip in ${TAB_TEXT[tab]}.`}</div>}
        </div>
        {list.length > 0 && <Pager page={pg} pages={pages} onPage={setPage} numberBox perPage={per} perOptions={[20, 50, 100]} onPer={n => { setPer(n); setPage(1); }}
                                   label={`${(pg - 1) * per + 1}–${(pg - 1) * per + shown.length} of ${list.length}`} />}
      </div>

      {members && <MembersDialog title={`Reviewers of “${ds.name}”`} current={{ members: ds.members }}
        text="They see this dataset and accept, fix or reject its clips. Managers and viewers see every dataset."
        groups={[{ key: "members", label: "Reviewers", roles: ["annotator", "inspector", "acceptor", "manager"] }]}
        onSave={saveMembers} onClose={() => setMembers(false)} />}

      {pushing && (() => {
        const prev = [ds.last_push, ds.sibling_push].find(p => p && !p.pr);   // the batches of a source go to one repo
        const sel = pushItems(), secs = sel.reduce((s, x) => s + clipLen(x), 0);
        return (
          <HubPushDialog title="Push to Hugging Face" onClose={() => setPushing(false)} canPush={sel.length > 0} prRepo={ds.repo}
            defaults={{ repo: prev ? prev.repo : "", split: prev ? prev.split : ds.split }}
            suggestRepo={u => `${u}/${ds.repo.split("/")[1]}_clean`}
            info={fp => {
              const split = fp.split || ds.split, file = `data/${split}${ds.batch ? "-" + ds.batch.prefix : ""}-*.parquet`;
              return `${sel.length} clips (${fmtHms(secs)}, ${{ accepted: "accepted clips only", not_rejected: "everything except rejected", all: "all clips" }[include]}) are uploaded as parquet ` +
                `to ${file}, with the normalized text in “${ds.text_column}_normalized”` + (fp.create_pr ? " in a pull request — the owner of the repo decides whether to merge it." :
                ds.batch ? `. Only this batch's earlier files are replaced: the other batches in the repo stay, and the dataset card's batch table gets a row for ${ds.batch.name}.`
                         : ". Older files of that split in the repo are replaced; the dataset card gets a cleaning report.");
            }}
            onPush={async fp => {
              await api(`/api/datasets/${id}/push`, { ...fp, include, trim: trimOut });
              setPushing(false);
              job.start();
            }} />
        );
      })()}
    </section>
  );
}
