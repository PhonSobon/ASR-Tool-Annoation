"use client";
// In-app notifications (top-right toasts) and the confirm box, instead of the browser's alert / confirm popups.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export type NoteType = "success" | "error" | "warn" | "info";
interface Note { id: number; message: string; type: NoteType; out?: boolean }
interface ConfirmOpts { title?: string; ok?: string; danger?: boolean }
interface ConfirmState extends ConfirmOpts { message: string; resolve: (ok: boolean) => void }

interface NotifyApi {
  /** Errors stay until closed; the others go away by themselves (ms = 0: stays). */
  notify: (message: string, type?: NoteType, ms?: number) => void;
  /** Resolves true (OK) or false (Cancel / Esc). */
  askConfirm: (message: string, opts?: ConfirmOpts) => Promise<boolean>;
}

const Ctx = createContext<NotifyApi | null>(null);
export const useNotify = () => useContext(Ctx)!;
const ICONS = { success: "check", error: "x", warn: "alert", info: "info" } as const;

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);
  const nextId = useRef(1);

  const close = useCallback((id: number) => {
    setNotes(n => n.map(x => x.id === id ? { ...x, out: true } : x));
    setTimeout(() => setNotes(n => n.filter(x => x.id !== id)), 200);
  }, []);

  const notify = useCallback((message: string, type: NoteType = "info", ms = type === "error" ? 0 : 4000) => {
    const id = nextId.current++;
    setNotes(n => [...n, { id, message, type }].slice(-5));
    if (ms) setTimeout(() => close(id), ms);
  }, [close]);

  const askConfirm = useCallback((message: string, opts: ConfirmOpts = {}) =>
    new Promise<boolean>(resolve => setConfirm({ message, ...opts, resolve })), []);

  useEffect(() => { if (confirm && dlg.current && !dlg.current.open) dlg.current.showModal(); }, [confirm]);
  const answer = (ok: boolean) => {
    if (!confirm) return;
    confirm.resolve(ok);
    setConfirm(null);
    if (dlg.current?.open) dlg.current.close();
  };

  return (
    <Ctx.Provider value={{ notify, askConfirm }}>
      {children}
      <div className="notes" aria-live="polite">
        {notes.map(n => (
          <div key={n.id} className={`note ${n.type}${n.out ? " out" : ""}`} role={n.type === "error" ? "alert" : "status"}>
            <span className="note-icon"><Icon name={ICONS[n.type]} /></span>
            <div className="note-text">{n.message}</div>
            <button className="note-x" type="button" title="Close" aria-label="Close" onClick={() => close(n.id)}><Icon name="x" /></button>
          </div>
        ))}
      </div>
      <dialog className="confirm" ref={dlg} onClose={() => answer(false)}>
        <h3>{confirm?.title || "Please confirm"}</h3>
        <p>{confirm?.message}</p>
        <div className="confirm-actions">
          <button type="button" className="sec" onClick={() => answer(false)}>Cancel</button>
          <button type="button" className={confirm?.danger ? "stop" : ""} autoFocus onClick={() => answer(true)}>{confirm?.ok || "OK"}</button>
        </div>
      </dialog>
    </Ctx.Provider>
  );
}
