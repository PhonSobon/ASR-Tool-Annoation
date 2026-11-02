"use client";
// Review of the open package: where it is (annotating -> inspection -> acceptance -> accepted), the note of a
// return, and the buttons of the inspector (Pass / Return) and the acceptor (Accept / Return).
// POST /api/tasks/<id>/review; the server checks the role, the step and that nobody reviews their own package.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useNotify } from "@/components/notify";
import { useSession } from "@/components/session";
import { api } from "@/lib/api";
import { cropStage, STAGE_TEXT } from "@/lib/review";
import type { Pkg, TaskStore } from "@/lib/task-store";

export function ReviewBar({ store, pkg, onDone, flush }: { store: TaskStore; pkg: Pkg; onDone: () => void; flush: () => Promise<void> }) {
  const { me } = useSession();
  const { notify } = useNotify();
  const [returning, setReturning] = useState(false);
  const s = pkg.seg, g = cropStage(s), a = store.access, own = s.annotator === me.username && me.role !== "admin";
  const inspect = g === "inspecting" && !!a?.inspect && !own, accept = g === "accepting" && !!a?.accept && !own;
  const step = inspect ? "inspection" : "acceptance";

  const who = [s.annotator && `annotated by ${s.annotator}`, s.inspection && `inspected by ${s.inspection.by} (${s.inspection.at})`,
               s.acceptance && `accepted by ${s.acceptance.by} (${s.acceptance.at})`].filter(Boolean).join(" · ")
            + ((g === "inspecting" && a?.inspect || g === "accepting" && a?.accept) && own ? " · you annotated it, so another person has to check it" : "");
  const note = g === "returned" ? s.returned : (s.inspection?.note ? { ...s.inspection, stage: "inspection" } : null);

  const decide = async (decision: "pass" | "accept" | "return", text = "") => {
    await flush();                        // an inspector's text fixes are saved before the decision
    try {
      const { crop } = await api(`/api/tasks/${store.task.id}/review`, { audio_id: pkg.audio.id,
        index: pkg.audio.segments.indexOf(pkg.seg), step, decision, note: text });
      for (const k of ["completed", "inspection", "acceptance", "returned", "history"]) pkg.seg[k] = crop[k] ?? null;
    } catch (e: any) { return notify("Not saved: " + e.message, "error"); }
    notify({ pass: "Passed inspection — it goes to acceptance.", accept: "Package accepted.", return: "Returned to the annotator with your note." }[decision], "success");
    store.emit();
    onDone();
  };

  return (
    <div className={"panel review-bar " + g}>
      <span className="rb-icon"><Icon name="shield" /></span>
      <div className="rb-text">
        <div><b>{STAGE_TEXT[g]}</b> <span className="muted">{who}</span></div>
        {note && <div className="rb-note"><Icon name={g === "returned" ? "alert" : "info"} /> <b>{note.by}</b> ({note.stage}, {note.at}): {note.note}</div>}
      </div>
      <span style={{ flex: 1 }} />
      {(inspect || accept) && <button className="sec" onClick={() => setReturning(true)}><Icon name="arrow-left" /> Return to annotator</button>}
      {inspect && <button onClick={() => decide("pass")}><Icon name="check" /> Pass inspection</button>}
      {accept && <button onClick={() => decide("accept")}><Icon name="check-circle" /> Accept</button>}
      {returning && <ReturnDialog onClose={() => setReturning(false)} onReturn={t => { setReturning(false); decide("return", t); }} />}
    </div>
  );
}

function ReturnDialog({ onClose, onReturn }: { onClose: () => void; onReturn: (note: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState(""), [err, setErr] = useState("");
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog className="confirm" ref={ref} onClose={onClose}>
      <h3>Return the package to the annotator</h3>
      <p className="muted">Say what has to be fixed. The package goes back to the annotator&apos;s Todo with this note.</p>
      <textarea id="returnNote" rows={4} lang="km" autoFocus placeholder="e.g. Segment 2: the last word is missing" value={note} onChange={e => setNote(e.target.value)} />
      <div className="errmsg">{err}</div>
      <div className="confirm-actions">
        <button type="button" className="sec" onClick={onClose}>Cancel</button>
        <button type="button" className="stop" onClick={() => note.trim() ? onReturn(note.trim()) : setErr("Write what the annotator has to fix.")}>Return</button>
      </div>
    </dialog>
  );
}
