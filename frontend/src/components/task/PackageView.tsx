"use client";
// One package of a task: the crop in the cut editor (cut it into dialogue segments), the Dialogue Segments table
// (role, annotation text, normalized text, recognize), Role Information, Overall Audio Information and its review
// (the review). In the editor, times are relative to the crop; they are stored in audio-file time.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { CutEditorPanel } from "@/components/CutEditorPanel";
import { Icon } from "@/components/Icon";
import { useNotify } from "@/components/notify";
import { useSession } from "@/components/session";
import { api, decodePeaks, download, getJson } from "@/lib/api";
import type { CutEditor, EditorHooks } from "@/lib/cut-editor";
import { fmtT, r3 } from "@/lib/format";
import { cropState, handTyped, inTab, liveParts, STATUS, syncCrop } from "@/lib/review";
import type { Pkg, TaskStore } from "@/lib/task-store";
import type { Seg } from "@/lib/types";
import { ReviewBar } from "./ReviewBar";
import { SpecDialog } from "./SpecDialog";

const CHALLENGES = ["Emotional speech", "Fast speech", "Whispering", "Shouting", "Accented speech", "Low volume",
                    "Reverb / echo", "Overlapping speech", "Laughter", "Singing"];
const DEFAULT_INFO = { language: "Khmer", overlap: "Solo monologue", codeSwitch: "No", challenges: [] as string[] };
const REQUIRED_INFO: Record<string, string> = { language: "Primary Language", accent: "Accent / Dialect", domain: "Industry Domain",
                                                style: "Speech Style", overlap: "Speaker Overlap Type", codeSwitch: "Code Switching Present" };
const ROLES = ["Narrator", "Speaker 1", "Speaker 2", "Speaker 3", "Interviewer", "Guest"];
const SELECTS: Record<string, string[]> = {
  language: ["Khmer", "English", "Khmer-English mixed", "Other"],
  domain: ["EDU_GOV", "NEWS_MEDIA", "HEALTH", "FINANCE", "AGRICULTURE", "TECHNOLOGY", "ENTERTAINMENT", "RELIGION", "DAILY_LIFE", "OTHER"],
  style: ["Read", "Spontaneous", "Conversational", "Broadcast", "Interview", "Lecture"],
  overlap: ["Solo monologue", "Multi-speaker, no overlap", "Multi-speaker, with overlap"],
  background: ["None (clean)", "Background instrumental", "Background music with vocals", "Ambient noise", "Crowd / people talking", "Traffic / street", "Other"],
  codeSwitch: ["No", "Yes"],
};

export function PackageView({ store, index, position, onStep, onBack, onAllDone }: {
  store: TaskStore; index: number; position: [number, number];
  onStep: (d: number) => void; onBack: () => void; onAllDone: () => void;
}) {
  const { can } = useSession();
  const { notify, askConfirm } = useNotify();
  const c = store.crops[index];
  const editable = store.editable(c);
  const editor = useRef<CutEditor | null>(null);
  const hooks = useRef<Partial<EditorHooks>>({});
  const [, render] = useReducer((x: number) => x + 1, 0);
  const [status, setStatus] = useState("");
  const [running, setRunning] = useState(false);
  const [spec, setSpec] = useState(false);
  const [fontSize, setFontSize] = useState("16px");
  const normTimers = useRef(new Map<Seg, ReturnType<typeof setTimeout>>());
  const ed = editor.current;
  const segs = ed?.segs || [];
  const sel = ed?.sel || null;

  useEffect(() => { const fs = localStorage.getItem("fontSize"); if (fs) setFontSize(fs); }, []);
  useEffect(() => { document.documentElement.style.setProperty("--tfs", fontSize); }, [fontSize]);

  // autosave of the editor: its segments become the package's parts (audio-file time)
  hooks.current = {
    save: async segments => {
      const off = c.seg.start, abs = (t: number) => r3(t + off);
      c.seg.parts = segments.map(s => ({ ...s, start: abs(s.start), end: abs(s.end),
        words: s.words && s.words.map(w => ({ ...w, start: abs(w.start), end: abs(w.end) })) }));
      syncCrop(c.seg);
      store.markDirty(c);
      await store.saveAudio(c.audio);
    },
    structure: render,
    select: s => { render(); if (s) document.getElementById("seg-" + s.id)?.scrollIntoView({ block: "nearest" }); },
  };
  const dirty = () => { editor.current?.dirty(); render(); };

  // ---------- open this package in the editor ----------
  useEffect(() => {
    const e = editor.current;
    if (!e) return;
    let live = true;
    (async () => {
      await e.saveNow().catch(() => {});
      const a = c.audio, off = c.seg.start;
      if (!store.peaks.has(a.id)) {
        try {
          const p = await getJson<{ peaks: string; rate: number }>(`/api/audios/${a.id}/peaks`);
          store.peaks.set(a.id, { peaks: decodePeaks(p.peaks), rate: p.rate });
        } catch (x: any) { notify("Cannot open the package: " + x.message, "error"); return onBack(); }
      }
      if (!live) return;
      const pk = store.peaks.get(a.id)!, rel = (t: number) => r3(t - off);
      e.readOnly = !store.editable(c);
      e.load({ id: a.id, name: c.pkg, duration: c.seg.end - off, offset: off }, (c.seg.parts || []).map(p => ({ ...p,
        start: rel(p.start), end: rel(p.end), words: p.words && p.words.map(w => ({ ...w, start: rel(w.start), end: rel(w.end) })) })),
        pk.peaks, pk.rate);
      prefillInfo(c);
      setStatus("Listen, then cut the package where the speaker changes (S at the playhead, or drag across the waveform). Fill in the table and the forms below.");
      window.scrollTo(0, 0);
      render();
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, editor.current]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || document.querySelector("dialog[open]")) return;
      if (e.key === "ArrowDown") { e.preventDefault(); leave(() => onStep(1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); leave(() => onStep(-1)); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });

  const leave = async (go: () => void) => {
    if (running) return notify("Wait until recognition of this package finishes.", "warn");
    await editor.current?.saveNow().catch(() => {});
    go();
  };

  /** New packages start from the previous package of the same audio (or the task), so you only confirm */
  function prefillInfo(p: Pkg) {
    let changed = false;
    if (!p.seg.info) {
      const same = store.crops.filter(x => x !== p && x.seg.info);
      const near = same.filter(x => x.audio === p.audio && x.no < p.no).pop() || same.find(x => x.audio === p.audio) || same[0];
      p.seg.info = JSON.parse(JSON.stringify(near ? near.seg.info : DEFAULT_INFO));
      changed = true;
    }
    const speakers = p.seg.speakers || {};
    for (const part of liveParts(p.seg)) {                 // a role already described in another package
      const role = (part.role || "").trim(), from = store.crops.find(x => x !== p && (x.seg.speakers || {})[role]);
      if (role && !speakers[role] && from) { speakers[role] = { ...from.seg.speakers![role] }; changed = true; }
    }
    p.seg.speakers = speakers;
    if (changed) store.markDirty(p, false);
  }

  // ---------- normalized text: made on the server from the annotation text, until edited by hand ----------
  const scheduleNorm = useCallback((s: Seg, delay = 500) => {
    clearTimeout(normTimers.current.get(s));
    normTimers.current.set(s, setTimeout(async () => {
      if (s.normEdited) return;
      const text = s.text || "";
      let norm = "";
      if (text.trim()) { try { norm = (await api("/api/text/normalize", { text })).normalized; } catch { return; } }
      if (s.text !== text || s.normEdited) return;
      s.norm = norm; dirty();
    }, delay));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- recognition ----------
  async function recognizeSeg(s: Seg, manual: boolean) {
    const e = editor.current;
    if (!e?.session || s.deleted || s.state === "running") return "skip";
    if (manual && handTyped(s) && !await askConfirm(`Segment ${segs.indexOf(s) + 1}: replace your edited text with a new recognition?`,
                                                    { title: "Recognize again", ok: "Replace text" })) return "skip";
    const ses = e.session, off = ses.offset;
    s.state = "running"; s.error = "";
    setRunning(true); render();
    let result = "done";
    try {
      const j = await api(`/api/audios/${ses.id}/transcribe`, { start: s.start + off, end: s.end + off });
      if (e.session !== ses || !e.segs.includes(s)) return "skip";      // left the package meanwhile
      s.text = s.wordsText = j.text; s.state = "done";
      s.words = (j.words || []).map((w: any) => ({ ...w, start: r3(w.start - off), end: r3(w.end - off) }));
      if (!s.normEdited) scheduleNorm(s, 0);
    } catch (x: any) {
      s.state = "error"; s.error = x.message;
      result = x.fatal ? "fatal" : "error";
    } finally { setRunning(false); }
    dirty(); e.requestDraw();
    return result;
  }

  const recognizeAll = async () => {
    const todo = segs.filter(s => !s.deleted && !(s.text || "").trim());
    if (!todo.length) return setStatus("Every segment already has text. Use the Recognize button on a row to recognize it again.");
    const ses = editor.current?.session;
    for (const [k, s] of todo.entries()) {
      if (editor.current?.session !== ses) return;
      setStatus(`Recognizing segment ${segs.indexOf(s) + 1} (${k + 1} / ${todo.length})…`);
      if (await recognizeSeg(s, false) === "fatal") return notify("Recognition stopped: " + s.error + "\nCheck the model files in models/Omnilingual-ASR-Khm.", "error");
    }
    setStatus("Done. Check every segment's text, then fill in the forms below.");
    notify(`${todo.length} segment(s) recognized. Check the text, then fill in the forms.`, "success");
  };

  // ---------- complete / skip ----------
  const complete = async () => {
    await editor.current?.saveNow().catch(() => {});
    if (cropState(c.seg) === "done") {
      c.seg.completed = false;
      c.seg.inspection = c.seg.acceptance = null;
      store.markDirty(c);
      return setStatus("Moved back to Todo.");
    }
    if (cropState(c.seg) !== "review") return notify("Every segment needs annotation text before the package can be completed.", "warn");
    const miss = missingFields();
    if (miss.length && !await askConfirm(`Still missing: ${miss.slice(0, 6).join(" · ")}${miss.length > 6 ? ` · +${miss.length - 6} more` : ""}. Complete the package anyway?`,
                                         { title: "Complete package", ok: "Complete anyway" })) return;
    c.seg.completed = true;
    if (c.seg.returned) { c.seg.resubmit = c.seg.returned.at; delete c.seg.returned; }
    store.markDirty(c);
    if (!store.crops.some(x => inTab(x.seg, "todo"))) {
      await store.flush();
      notify("Every package is completed — they wait for review now.", "success");
      return onAllDone();
    }
    onStep(1);
  };

  const toggleSkip = () => { c.seg.deleted = !c.seg.deleted; store.markDirty(c); render(); };

  // ---------- role information (per role, for the selected segment's role) ----------
  const role = (sel?.role || "").trim(), sp = (c.seg.speakers || {})[role] || {};
  const setSpeaker = (k: "age" | "gender" | "native", v: string) => {
    if (!role) return setStatus("Give the segment a role first.");
    c.seg.speakers = { ...(c.seg.speakers || {}), [role]: { ...sp, [k]: v } };
    store.markDirty(c); render();
  };
  const info = c.seg.info || {};
  const setInfo = (k: string, v: any) => { c.seg.info = { ...(c.seg.info || {}), [k]: v }; store.markDirty(c); render(); };

  function missingFields() {
    const miss: string[] = [], live = segs.filter(s => !s.deleted);
    live.forEach(s => {
      const n = segs.indexOf(s) + 1;
      if (!(s.role || "").trim()) miss.push(`role of segment ${n}`);
      if (!(s.text || "").trim()) miss.push(`text of segment ${n}`);
    });
    for (const r of new Set(live.map(s => (s.role || "").trim()).filter(Boolean))) {
      const spk = (c.seg.speakers || {})[r] || {};
      const gaps = ([["age", "age group"], ["gender", "gender"], ["native", "native speaker"]] as const).filter(([k]) => !spk[k]).map(([, l]) => l);
      if (gaps.length) miss.push(`${r}: ${gaps.join(", ")}`);
    }
    Object.entries(REQUIRED_INFO).forEach(([k, label]) => { if (!(info[k] || "").trim()) miss.push(label); });
    return miss;
  }

  const st = cropState(c.seg), miss = missingFields();
  const segState = (s: Seg) => s.deleted ? "skipped" : s.state === "running" ? "running" : (s.text || "").trim() ? "done" : s.state === "error" ? "error" : "pending";
  const completeBtn = editable && (
    <button className={"pkg-complete" + (st === "done" ? " sec" : "")} disabled={c.seg.deleted} onClick={complete}
            title={st === "done" ? "Move this package back to Todo to work on it again (its review starts over)"
                                 : "You checked every segment: send this package to review and open the next one"}>
      {st === "done" ? <><Icon name="restore" />Back to Todo</> : <><Icon name="check" />{c.seg.returned ? "Complete again" : "Complete"}</>}
    </button>);

  return (
    <div className={editable ? "" : "readonly"} id="pkgWorkView">
      <div className="panel pkg-bar">
        <div className="pkg-bar-row">
          <button className="sec back" onClick={() => leave(onBack)}><Icon name="arrow-left" /> Back</button>
          <button className="sec back" onClick={() => setSpec(true)}><Icon name="file" /> Annotation Specification</button>
          <span className="pkg-id">Package ID: <b>{c.pkg}</b></span>
          <span className={"badge " + st}>{STATUS[st]}</span>
          {can("data.export") && <button className="sec back" title="Download the audio of this package as one WAV file"
            onClick={() => download(`/api/audios/${c.audio.id}/download?` + new URLSearchParams(
              { start: String(c.seg.start), end: String(c.seg.end), name: c.pkg.replace(/\.[^.]+$/, "") }))}>
            <Icon name="download" /> Download audio</button>}
          <span style={{ flex: 1 }} />
          <span className="muted">Task ID: {store.task.id}</span>
          {completeBtn}
        </div>
        <div className="pkg-bar-row">
          <span className="muted">{store.task.name} · {c.audio.name} · Crop {c.no} · {fmtT(c.seg.start)} – {fmtT(c.seg.end)}{editable ? "" : " · read only"}</span>
          <span style={{ flex: 1 }} />
          <span className="pkg-nav">
            <button className="sec small" title="Previous package (Ctrl+Up)" aria-label="Previous package" disabled={position[0] <= 0} onClick={() => leave(() => onStep(-1))}><Icon name="chevron-left" /></button>
            <span>{position[0] + 1} / {position[1]}</span>
            <button className="sec small" title="Next package (Ctrl+Down)" aria-label="Next package" disabled={position[0] >= position[1] - 1} onClick={() => leave(() => onStep(1))}><Icon name="chevron-right" /></button>
          </span>
        </div>
      </div>

      <ReviewBar store={store} pkg={c} onDone={() => { render(); onStep(1); }} flush={async () => { await editor.current?.saveNow().catch(() => {}); await store.flush(); }} />

      <CutEditorPanel title={c.pkg} duration={c.seg.end - c.seg.start} info={`${c.audio.name} · ${fmtT(c.seg.start)} – ${fmtT(c.seg.end)} in the original audio`}
                      hooks={hooks} status={status} setStatus={setStatus} onReady={e => { editor.current = e; render(); }} />

      <div className="panel">
        <div className="seg-head">
          <b className="sec-title">Dialogue Segments</b>
          <span className="muted">Please select a segment first, then cut the audio</span>
          <select title="Text size" aria-label="Text size" value={fontSize} onChange={e => { setFontSize(e.target.value); localStorage.setItem("fontSize", e.target.value); }}>
            {["14px", "16px", "18px", "20px", "24px"].map(f => <option key={f}>{f}</option>)}
          </select>
          <span style={{ flex: 1 }} />
          {can("asr.run") && !c.seg.imported && <button className="sec" disabled={running || c.seg.deleted || !editable} onClick={recognizeAll}
                                     title="Recognize every segment of this package that has no text yet"><Icon name="recognize" /> Recognize all segments</button>}
          {editable && <button className="sec" onClick={toggleSkip}
                               title={c.seg.deleted ? "Put this package back into the export" : "Leave the whole package out of the export (noise, music, no speech…)"}>
            {c.seg.deleted ? <><Icon name="restore" />Restore package</> : <><Icon name="trash" />Skip package</>}</button>}
        </div>
        <div className="table-wrap seg-wrap">
          <table className="seg-table">
            <colgroup><col style={{ width: 80 }} /><col style={{ width: 105 }} /><col style={{ width: 105 }} /><col style={{ width: 90 }} />
              <col style={{ width: 140 }} /><col /><col /><col style={{ width: 160 }} /></colgroup>
            <thead><tr>
              <th className="c">Segment No.</th><th className="c">Start Position</th><th className="c">End Position</th><th className="c">Duration (s)</th>
              <th className="req">Role</th><th className="req">Annotation Text</th><th className="req">Normalized Text</th><th className="c">Action</th>
            </tr></thead>
            <tbody>
              {segs.map((s, k) => {
                const ss = segState(s);
                return (
                  <tr key={s.id} id={"seg-" + s.id} className={ss + (s === sel ? " selected" : "")}
                      onFocus={() => { if (ed && ed.sel !== s) ed.select(s, { seek: true }); }}
                      onMouseDown={e => { if (!(e.target as Element).closest("button, input, textarea")) ed?.select(s, { seek: true }); }}>
                    <td className="c"><b className="no">{k + 1}</b><span className={"badge " + ss}>{STATUS[ss] || ss}</span></td>
                    <td className="num">{fmtT(s.start)}</td><td className="num">{fmtT(s.end)}</td><td className="num">{(s.end - s.start).toFixed(3)}</td>
                    <td><input className="role" list="roles" aria-label="Role" value={s.role} readOnly={!editable}
                               onChange={e => { s.role = e.target.value; dirty(); }} /></td>
                    <td><AutoText className="ann" placeholder="Annotation text…" value={s.text} readOnly={!editable}
                                  onChange={v => { s.text = v; if (!s.normEdited) scheduleNorm(s); dirty(); }} />
                      <div className="errmsg">{s.error}</div></td>
                    <td><AutoText className="norm" placeholder="Normalized text…" value={s.norm} readOnly={!editable}
                                  onChange={v => { s.norm = v; s.normEdited = !!v.trim(); dirty(); }} />
                      {s.normEdited && editable && <button className="link reauto" title="Make it again from the annotation text"
                                                           onClick={() => { s.normEdited = false; scheduleNorm(s, 0); render(); }}><Icon name="restore" /> Auto-normalize</button>}</td>
                    <td><div className="acts">
                      <button className="icon" title="Play this segment" aria-label="Play this segment" onClick={() => { ed?.select(s); ed?.playFrom(s.start, s.end); }}><Icon name="play" /></button>
                      {can("asr.run") && editable && !c.seg.imported && <button className="icon" title="Recognize this segment" aria-label="Recognize this segment"
                                                             disabled={s.deleted || s.state === "running"} onClick={() => recognizeSeg(s, true)}><Icon name="recognize" /></button>}
                      {editable && <button className="icon" title="Cut this segment: then click the waveform where to cut it"
                                           aria-label="Cut this segment" disabled={s.deleted}
                                           onClick={() => {
                                             if (!ed) return;
                                             ed.select(s);
                                             ed.setCutMode(true);
                                             ed.setStatus(`Click the waveform inside segment ${k + 1} (${fmtT(s.start)} – ${fmtT(s.end)}) where you want to cut it.`);
                                             document.querySelector(".wavepanel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                                           }}><Icon name="scissors" /></button>}
                      {editable && <button className="icon" title={s.deleted ? "Restore this segment" : "Leave this segment out of the export (can be restored)"}
                                           aria-label={s.deleted ? "Restore this segment" : "Leave this segment out"} onClick={() => ed?.toggleDelete(s)}>
                        <Icon name={s.deleted ? "restore" : "trash"} /></button>}
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <b className="sec-title">Role Information</b>
        <span className="muted">{sel ? `for segment ${segs.indexOf(sel) + 1}` + (role ? ` — everyone with the role “${role}” in this package` : "") : ""}</span>
        <div className="form-grid role-grid">
          <label className="fld"><span className="req">Role</span>
            <input list="roles" aria-label="Role of the selected segment" value={sel?.role || ""} readOnly={!editable}
                   onChange={e => { if (sel) { sel.role = e.target.value; dirty(); } }} /></label>
          <label className="fld"><span className="req">Age Group</span>
            <select value={sp.age || ""} disabled={!editable} onChange={e => setSpeaker("age", e.target.value)}>
              <option value="">Select…</option>{["Under 18", "18-35", "36-50", "51-65", "Over 65"].map(o => <option key={o}>{o}</option>)}</select></label>
          <div className="fld"><span className="req">Gender</span>
            <div className="radios">{["Male", "Female"].map(v => <label key={v}><input type="radio" name="riGender" checked={sp.gender === v} disabled={!editable}
                                                                                       onChange={() => setSpeaker("gender", v)} /> {v}</label>)}</div></div>
          <div className="fld"><span className="req">Native Speaker</span>
            <div className="radios">{["Yes", "No"].map(v => <label key={v}><input type="radio" name="riNative" checked={sp.native === v} disabled={!editable}
                                                                                  onChange={() => setSpeaker("native", v)} /> {v}</label>)}</div></div>
        </div>
      </div>

      <div className="panel">
        <b className="sec-title">Overall Audio Information</b>
        <span className="muted">Please confirm or modify based on the audio content</span>
        <div className="form-grid">
          <InfoSelect k="language" label="Primary Language" req info={info} set={setInfo} disabled={!editable} />
          <label className="fld"><span className="req">Accent / Dialect</span>
            <input placeholder="e.g. Phnom Penh" value={info.accent || ""} readOnly={!editable} onChange={e => setInfo("accent", e.target.value)} /></label>
          <InfoSelect k="domain" label="Industry Domain" req info={info} set={setInfo} disabled={!editable} />
          <label className="fld"><span>Sub Domain</span><input value={info.subdomain || ""} readOnly={!editable} onChange={e => setInfo("subdomain", e.target.value)} /></label>
          <InfoSelect k="style" label="Speech Style" req info={info} set={setInfo} disabled={!editable} />
          <InfoSelect k="overlap" label="Speaker Overlap Type" req info={info} set={setInfo} disabled={!editable} />
        </div>
        <div className="sub-title">Audio Environment and Quality</div>
        <div className="form-grid"><InfoSelect k="background" label="Background Sound Type" info={info} set={setInfo} disabled={!editable} /></div>
        <div className="sub-title">Special Attributes</div>
        <div className="form-grid">
          <div className="fld"><span>Special Challenges</span>
            <div className="chips">{CHALLENGES.map(ch => {
              const on = (info.challenges || []).includes(ch);
              return <button key={ch} type="button" className={"chip" + (on ? " on" : "")} disabled={!editable}
                             onClick={() => setInfo("challenges", on ? info.challenges.filter((x: string) => x !== ch) : [...(info.challenges || []), ch])}>{ch}</button>;
            })}</div></div>
          <InfoSelect k="codeSwitch" label="Code Switching Present" req info={info} set={setInfo} disabled={!editable} />
        </div>
      </div>

      <div className="panel pkg-foot">
        <span className={"muted" + (miss.length && !c.seg.deleted ? " errmsg" : "")}>
          {c.seg.deleted ? <><Icon name="info" />This package is skipped — it is left out of the export.</>
            : miss.length ? <><Icon name="alert" />{`Missing: ${miss.slice(0, 6).join(" · ")}${miss.length > 6 ? ` · +${miss.length - 6} more` : ""}`}</>
            : <><Icon name="check-circle" />All required fields are filled.</>}
        </span>
        <span style={{ flex: 1 }} />
        <button className="sec" onClick={() => leave(() => onStep(1))}>Next package <Icon name="arrow-right" /></button>
        {completeBtn}
      </div>

      <datalist id="roles">{ROLES.map(r => <option key={r} value={r} />)}</datalist>
      {spec && <SpecDialog onClose={() => setSpec(false)} />}
    </div>
  );
}

function InfoSelect({ k, label, req, info, set, disabled }: { k: string; label: string; req?: boolean; info: Record<string, any>; set: (k: string, v: string) => void; disabled: boolean }) {
  return (
    <label className="fld"><span className={req ? "req" : ""}>{label}</span>
      <select value={info[k] || ""} disabled={disabled} onChange={e => set(k, e.target.value)}>
        <option value="">Select…</option>{SELECTS[k].map(o => <option key={o}>{o}</option>)}
      </select></label>
  );
}

/** A textarea that grows with its text. */
function AutoText({ value, onChange, className, placeholder, readOnly }: { value: string; onChange: (v: string) => void; className: string; placeholder: string; readOnly: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const t = ref.current; if (t) { t.style.height = "auto"; t.style.height = t.scrollHeight + 2 + "px"; } }, [value]);
  return <textarea ref={ref} rows={1} className={className} placeholder={placeholder} value={value || ""} readOnly={readOnly}
                   onChange={e => onChange(e.target.value)} />;
}
