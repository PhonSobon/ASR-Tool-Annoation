"use client";
// The cut editor's panel: waveform canvas, playback and cut tools. The CutEditor (lib/cut-editor.ts) draws into it;
// the page gets the editor through onReady and passes its hooks in `hooks` (read at call time, so they can change).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CutEditor, type EditorHooks } from "@/lib/cut-editor";
import { fmtDur } from "@/lib/format";
import { Icon } from "./Icon";
import { useSession } from "./session";

export function CutEditorPanel({ title, duration, info, hooks, onReady, status, setStatus, hidden }: {
  title: string; duration: number; info: ReactNode; hidden?: boolean;
  hooks: React.RefObject<Partial<EditorHooks>>;
  onReady: (ed: CutEditor | null) => void;
  status: string; setStatus: (t: string) => void;
}) {
  const { setSave } = useSession();
  const canvas = useRef<HTMLCanvasElement>(null), box = useRef<HTMLDivElement>(null), hbar = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null), clock = useRef<HTMLSpanElement>(null);
  const zoom = useRef<HTMLInputElement>(null), gain = useRef<HTMLInputElement>(null), speed = useRef<HTMLSelectElement>(null);
  const [ed, setEd] = useState<CutEditor | null>(null);
  const [playing, setPlaying] = useState(false);
  const [undo, setUndo] = useState([false, false]);
  const [gainOut, setGainOut] = useState(1);

  useEffect(() => {
    const editor = new CutEditor(
      { canvas: canvas.current!, box: box.current!, hbar: hbar.current!, spacer: spacer.current!, clock: clock.current!,
        zoom: zoom.current!, gain: gain.current!, speed: speed.current! },
      {
        save: segs => hooks.current?.save ? hooks.current.save(segs) : Promise.resolve(),
        structure: () => hooks.current?.structure?.(),
        select: s => hooks.current?.select?.(s),
        status: t => setStatus(t),
        saveState: (t, k) => setSave(t, k || ""),
        playing: p => setPlaying(p),
        undoState: (u, r) => setUndo([u, r]),
      });
    setEd(editor);
    onReady(editor);
    return () => { editor.destroy(); onReady(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div hidden={hidden}>
      <div className="panel wavepanel">
        <div className="wave-head">
          <b>{title}</b>
          <span className="pill dur"><Icon name="clock" />{fmtDur(duration)}</span>
          <span className="muted">{info}</span>
        </div>
        <div className="wavebox" ref={box}><canvas ref={canvas} /></div>
        <div className="hbar" ref={hbar}><div ref={spacer} /></div>
        <div className="controls">
          <span className="clock" ref={clock}>00:00.000/00:00.000</span>
          <button className="icon" title="Previous segment (Up arrow)" aria-label="Previous segment" onClick={() => ed?.stepSeg(-1)}><Icon name="skip-back" /></button>
          <button className="icon" title="Play / pause (Space, or Ctrl+Enter while typing)" aria-label="Play / pause" onClick={() => ed?.togglePlay()}>
            <Icon name={playing ? "pause" : "play"} /></button>
          <button className="icon" title="Next segment (Down arrow)" aria-label="Next segment" onClick={() => ed?.stepSeg(1)}><Icon name="skip-forward" /></button>
          <button className="icon" title="Undo cut / merge / move (Ctrl+Z)" aria-label="Undo" disabled={!undo[0]} onClick={() => ed?.undo()}><Icon name="undo" /></button>
          <button className="icon" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!undo[1]} onClick={() => ed?.redo()}><Icon name="redo" /></button>
          <span className="sep" />
          <button className="small" title="Cut the selected segment at the playhead (S)" onClick={() => ed?.cutHere()}><Icon name="scissors" /> Cut at playhead</button>
          <span className="sep" />
          <label>Speed:{" "}
            <select ref={speed} defaultValue="1">
              {["0.5", "0.75", "1", "1.25", "1.5", "2"].map(v => <option key={v} value={v}>{v}x</option>)}
            </select>
          </label>
          <label>Timeline zoom: <input type="range" ref={zoom} min="0" max="100" defaultValue="0" /></label>
          <label>Waveform height: <input type="range" ref={gain} min="0.5" max="6" step="0.25" defaultValue="1"
                                         onInput={e => setGainOut(+(e.target as HTMLInputElement).value)} /><output>{gainOut}x</output></label>
        </div>
        <div className="status">{status}</div>
        <div className="hint">Click = select segment &amp; move playhead · <b>drag across the waveform = crop that range into its own segment</b> ·
          drag a dark line to move a boundary (snaps to word gaps, Alt = free) · double-click a line to merge ·
          <kbd>Space</kbd> play/pause · <kbd>S</kbd> cut · <kbd>Del</kbd> delete / restore segment · <kbd>Left</kbd> <kbd>Right</kbd> 0.1 s (Shift 1 s) ·
          <kbd>Up</kbd> <kbd>Down</kbd> segment · <kbd>Ctrl</kbd>+wheel zoom</div>
      </div>
    </div>
  );
}
