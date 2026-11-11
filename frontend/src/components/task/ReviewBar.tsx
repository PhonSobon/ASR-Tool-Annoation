"use client";
// Review of the open package (one review step): where it is (annotating -> waiting for review -> accepted), the note
// of a return, and the reviewer's buttons (Accept / Return to annotator).
// POST /api/tasks/<id>/review {decision}; the server checks the role, the stage and that nobody reviews their own package.
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
  const canReview = g === "inspecting" && !!a?.review;
  const review = canReview && !own;

  const who = [s.annotator && `annotated by ${s.annotator}`, s.acceptance && `accepted by ${s.acceptance.by} (${s.acceptance.at})`]
    .filter(Boolean).join(" · ") + (canReview && own ? " · you annotated it, so another person has to review it" : "");
  const note = g === "returned" ? s.returned : null;

  const decide = async (decision: "accept" | "return", text = "") => {
    await flush();                        // a reviewer's text fixes are saved before the decision
    try {
      const { crop } = await api(`/api/tasks/${store.task.id}/review`, { audio_id: pkg.audio.id,
        index: pkg.audio.segments.indexOf(pkg.seg), decision, note: text });
      for (const k of ["completed", "inspection", "acceptance", "returned", "history"]) pkg.seg[k] = crop[k] ?? null;
    } catch (e: any) { return notify("Not saved: " + e.message, "error"); }
    notify(decision === "accept" ? "Package accepted." : "Returned to the annotator with your note.", "success");
    store.emit();
    onDone();
  };

  return (
    <div className={"panel review-bar " + g}>
      <span className="rb-icon"><Icon name="shield" /></span>
      <div className="rb-text">
        <div><b>{STAGE_TEXT[g]}</b> <span className="muted">{who}</span></div>
        {note && <div className="rb-note"><Icon name="alert" /> <b>{note.by}</b> ({note.at}): {note.note}</div>}
      </div>
      <span style={{ flex: 1 }} />
      {review && <button className="sec" onClick={() => setReturning(true)}><Icon name="arrow-left" /> Return to annotator</button>}
      {review && <button onClick={() => decide("accept")}><Icon name="check-circle" /> Accept</button>}
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
