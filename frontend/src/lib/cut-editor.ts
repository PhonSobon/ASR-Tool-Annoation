// The waveform cut editor (Upload & Crop, and one package of a task): a canvas timeline with zoom, playback,
// selection, cut / crop / merge / delete with undo, word timings and autosave. Plain TypeScript around the DOM
// elements of <CutEditorPanel>: drawing 60 times a second is faster outside React. Pages follow it through the
// hooks (structure changed, selection changed, status, save state) and call its methods.
import { fmtT, r3 } from "./format";
import type { Seg, Word } from "./types";

const RULER = 24, WAVE_H = 170, MAX_PPS = 400;

export interface EditorElements {
  canvas: HTMLCanvasElement; box: HTMLElement; hbar: HTMLElement; spacer: HTMLElement; clock: HTMLElement;
  zoom: HTMLInputElement; gain: HTMLInputElement; speed: HTMLSelectElement;
}

export interface EditorHooks {
  /** autosave: the segments (times relative to the editor) */
  save: (segments: Seg[]) => Promise<void>;
  /** segments added / removed / moved / texts changed by a cut */
  structure?: () => void;
  select?: (s: Seg | null) => void;
  status?: (text: string) => void;
  saveState?: (text: string, kind?: "ok" | "err" | "") => void;
  playing?: (playing: boolean) => void;
  undoState?: (canUndo: boolean, canRedo: boolean) => void;
  /** the cut tool was turned on / off */
  cutMode?: (on: boolean) => void;
}

export interface EditorSession {
  id: string;          // audio id
  name: string;
  duration: number;    // seconds shown (a package: its crop)
  offset: number;      // where 0 is in the audio file
}

let nextId = 1;
export const newSeg = (o: Partial<Seg>): Seg => ({ id: nextId++, start: 0, end: 0, text: "", norm: "", normEdited: false,
  role: "Narrator", words: null, wordsText: null, state: "pending", error: "", deleted: false, ...o });
export const untouched = (s: Seg) => !!s.words && s.text === s.wordsText;   // text still matches the word timings
const wordsToText = (ws: Word[]) => ws.map((w, j) => (j && w.sp ? " " : "") + w.text).join("");
const gapTimes = (ws: Word[]) => ws.slice(1).map((w, j) => (ws[j].end + w.start) / 2);

export class CutEditor {
  session: EditorSession | null = null;
  segs: Seg[] = [];
  sel: Seg | null = null;
  readonly player = new Audio();
  private peaks: Int8Array | null = null;
  private peakRate = 200;
  private peakMax = 1;
  private pps = 50;
  private gain = 1;
  pos = 0;
  private hover: number | null = null;
  private playEnd: number | null = null;
  private ticking = false;
  /** The user scrolled the timeline away from the playhead: do not pull the view back while playing, until the
   *  playhead comes into view again, or they play / click / use the arrow keys. */
  private looking = false;
  /** Cut tool: a click on the waveform cuts the segment there (no need to play or move the playhead first). */
  cutMode = false;
  private dragRange: [number, number] | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private drawQueued = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  savePending = false;
  readOnly = false;
  private off: (() => void)[] = [];

  constructor(private el: EditorElements, public hooks: EditorHooks) {
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window | Document, ev: K | string, fn: (e: any) => void, opt?: AddEventListenerOptions) => {
      t.addEventListener(ev, fn, opt);
      this.off.push(() => t.removeEventListener(ev, fn, opt));
    };
    on(el.hbar, "scroll", () => this.requestDraw());
    // the user takes the scrollbar (drag, click, wheel, touch): stop following the playhead
    for (const ev of ["pointerdown", "wheel", "touchstart"]) on(el.hbar, ev, () => this.lookAround(), { passive: true });
    on(el.zoom, "input", () => this.applyZoom(this.pos, Math.min(this.viewW(), Math.max(0, this.X(this.pos)))));
    on(el.gain, "input", () => { this.gain = +el.gain.value; this.draw(); });
    on(el.speed, "change", () => { this.player.playbackRate = +el.speed.value; });
    // the box changes width with the window and with the page layout: keep the waveform fitting it
    let width = 0;
    const ro = new ResizeObserver(() => {
      const w = el.box.clientWidth;
      if (w && w !== width) { width = w; if (this.session) this.applyZoom(this.pos, Math.min(w, Math.max(0, this.X(this.pos)))); }
    });
    ro.observe(el.box);
    this.off.push(() => ro.disconnect());
    on(el.canvas, "mousedown", (e: MouseEvent) => { this.looking = false; this.mouseDown(e); });
    on(el.canvas, "mousemove", (e: MouseEvent) => {
      if (!this.session) return;
      this.hover = this.tAt(e);
      el.canvas.style.cursor = this.cutMode && !this.readOnly ? "col-resize"
                             : this.boundaryNear(e) > 0 && !this.readOnly ? "ew-resize" : "crosshair";
      this.requestDraw();
    });
    on(el.canvas, "mouseleave", () => { this.hover = null; this.requestDraw(); });
    on(el.canvas, "dblclick", (e: MouseEvent) => { const k = this.boundaryNear(e); if (k > 0) this.merge(k); });
    on(el.canvas, "wheel", (e: WheelEvent) => {
      if (!this.session) return;
      if (!e.ctrlKey) {   // zoomed in: the mouse wheel / a trackpad swipe over the waveform scrolls it left and right
        const dx = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!dx || el.hbar.scrollWidth <= el.hbar.clientWidth) return;   // nothing to scroll: the page scrolls
        e.preventDefault();
        this.lookAround();
        el.hbar.scrollLeft += dx * (e.deltaMode === 1 ? 16 : 1);
        return;
      }
      e.preventDefault();
      const t = this.tAt(e), atX = e.clientX - el.canvas.getBoundingClientRect().left;
      el.zoom.value = String(Math.min(100, Math.max(0, +el.zoom.value + (e.deltaY < 0 ? 8 : -8))));
      this.applyZoom(t, atX);
    }, { passive: false });
    on(document, "keydown", (e: KeyboardEvent) => this.keydown(e));
    this.player.onpause = () => this.hooks.playing?.(false);
    this.player.onplay = () => this.hooks.playing?.(true);
  }

  destroy() {
    clearTimeout(this.saveTimer);
    this.player.pause();
    this.player.removeAttribute("src");
    this.off.forEach(f => f());
  }

  // ---------- open / close ----------
  /** peaks: interleaved min/max int8 pairs of the whole audio file at peakRate per second (sliced to the session). */
  load(session: EditorSession, segments: Partial<Seg>[], peaks: Int8Array, peakRate: number) {
    this.session = session;
    this.peaks = peaks.subarray(2 * Math.floor(session.offset * peakRate), 2 * Math.ceil((session.offset + session.duration) * peakRate));
    this.peakRate = peakRate;
    let max = 1;
    for (let b = 0; b < this.peaks.length; b += Math.max(1, Math.floor(this.peaks.length / 4096) * 2)) max = Math.max(max, Math.abs(this.peaks[b]), Math.abs(this.peaks[b + 1] ?? 0));
    this.peakMax = max;
    this.setSegments(segments);
    this.pos = 0; this.playEnd = null; this.hover = null; this.dragRange = null;
    this.undoStack.length = this.redoStack.length = 0;
    this.savePending = false;
    this.player.pause();
    const src = `/api/audios/${session.id}/audio`;
    if (!this.player.src.endsWith(src)) this.player.src = src;
    this.el.zoom.value = "0";
    this.updateUndo(); this.showClock();
    this.el.hbar.scrollLeft = 0; this.looking = false;   // a package opens at its start
    requestAnimationFrame(() => { this.applyZoom(); this.el.hbar.scrollLeft = 0; this.draw(); });
  }

  /** Replace all segments (open, or a new cut length) and select the first one */
  setSegments(list: Partial<Seg>[]) {
    nextId = Math.max(nextId, ...list.map(s => (s.id || 0) + 1));   // saved segments keep their ids
    this.segs = list.map(s => newSeg({ ...s, state: s.state === "running" ? "pending" : (s.state || "pending") }));
    this.sel = this.segs[0] || null;
    this.hooks.structure?.();
    this.hooks.select?.(this.sel);
  }

  close() {
    this.session = null; this.segs = []; this.sel = null; this.peaks = null; this.savePending = false;
    this.player.pause(); this.player.removeAttribute("src");
    clearTimeout(this.saveTimer);
  }

  // ---------- autosave ----------
  dirty() {
    if (!this.session || this.readOnly) return;
    this.savePending = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
    this.hooks.saveState?.("Unsaved changes…");
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    if (!this.session || !this.savePending) return;
    this.savePending = false;
    const segments = JSON.parse(JSON.stringify(this.segs, (k, v) => k.startsWith("_") ? undefined : v))
      .map((s: Seg) => ({ ...s, state: s.state === "running" ? "pending" : s.state }));
    this.hooks.saveState?.("Saving…");
    try {
      await this.hooks.save(segments);
      if (!this.savePending) this.hooks.saveState?.("All changes saved", "ok");
    } catch (e: any) {
      this.savePending = true;
      this.hooks.saveState?.("Not saved: " + e.message, "err");
      throw e;
    }
  }

  // ---------- helpers ----------
  setStatus(t: string) { this.hooks.status?.(t); }
  segAt = (t: number) => this.segs.find(s => t >= s.start && t < s.end) || this.segs[this.segs.length - 1];
  private viewW = () => this.el.box.clientWidth;
  private x0 = () => this.el.hbar.scrollLeft;
  private X = (t: number) => t * this.pps - this.x0();
  private tAt = (e: MouseEvent) => Math.min(this.session!.duration, Math.max(0, (this.x0() + e.clientX - this.el.canvas.getBoundingClientRect().left) / this.pps));

  // ---------- selection ----------
  select(s: Seg | null, { seek = false } = {}) {
    if (!s) return;
    this.sel = s;
    this.hooks.select?.(s);
    if (seek && !(this.pos >= s.start && this.pos < s.end)) this.seek(s.start);
    const a = this.X(s.start), b = this.X(s.end), w = this.viewW();   // bring the segment into view
    if (b < 0 || a > w) this.el.hbar.scrollLeft = s.start * this.pps - w * 0.1;
    this.requestDraw();
  }

  stepSeg(d: number) {
    if (!this.segs.length) return;
    const k = Math.min(this.segs.length - 1, Math.max(0, (this.sel ? this.segs.indexOf(this.sel) : -1) + d));
    this.select(this.segs[k]);
    this.seek(this.segs[k].start);
  }

  // ---------- cut / merge / delete (all undoable) ----------
  private splitAt(a: Seg, t: number) {   // a -> a + b at time t; returns b
    t = r3(t);
    const b = newSeg({ start: t, end: a.end, role: a.role, deleted: a.deleted });
    if (untouched(a)) {      // split the recognized text by word timings
      b.words = a.words!.filter(w => (w.start + w.end) / 2 >= t);
      a.words = a.words!.filter(w => (w.start + w.end) / 2 < t);
      [a, b].forEach(s => { s.text = s.wordsText = wordsToText(s.words!); s.state = "done"; s.normEdited = false; });
    } else if (a.text) {
      a.words = null;
      this.setStatus(`The text stays in segment ${this.segs.indexOf(a) + 1} (it was edited or has no word timings) — fix it in the table.`);
    }
    a.end = t;
    this.segs.splice(this.segs.indexOf(a) + 1, 0, b);
    [a, b].forEach(staleNorm);
    return b;
  }

  /** Turn the cut tool on / off (toggle when `on` is left out). */
  setCutMode(on = !this.cutMode) {
    if (this.readOnly) on = false;
    if (on === this.cutMode) return;
    this.cutMode = on;
    this.hooks.cutMode?.(on);
    this.setStatus(on ? "Cut tool on: click the waveform where you want to cut — each click cuts there. Press C or Esc to stop."
                      : "Cut tool off: click selects a segment again, drag crops a range.");
    this.requestDraw();
  }

  /** Cut the segment under time t at t. */
  cutAt(t: number) {
    if (this.readOnly || !this.session) return;
    t = r3(t);
    const s = this.segs.find(x => t >= x.start && t < x.end);
    if (!s) return this.setStatus("There is no segment there to cut.");
    if (t <= s.start + 0.1 || t >= s.end - 0.1)
      return this.setStatus(`Too close to the edge of segment ${this.segs.indexOf(s) + 1} — cut at least 0.1 s from its start and end.`);
    this.pushUndo();
    const b = this.splitAt(s, t);
    this.select(s);
    this.afterStructure();
    this.setStatus(`Cut at ${fmtT(t)}: segment ${this.segs.indexOf(s) + 1} and ${this.segs.indexOf(b) + 1}.` +
                   (this.cutMode ? " Click again to cut more, C or Esc to stop." : ""));
  }

  cutHere() {
    if (this.readOnly) return;
    const sel = this.sel;
    if (!sel) return this.setStatus("Select a segment first (click it on the waveform), then cut.");
    if (this.pos <= sel.start + 0.1 || this.pos >= sel.end - 0.1)
      return this.setStatus(`Move the playhead inside segment ${this.segs.indexOf(sel) + 1} (${fmtT(sel.start)} – ${fmtT(sel.end)}) to cut it.`);
    this.pushUndo();
    this.splitAt(sel, this.pos);
    this.afterStructure();
  }

  merge(k: number) {   // join segs[k] into segs[k-1]
    if (this.readOnly) return;
    this.pushUndo();
    this.joinSegs(k);
    this.afterStructure();
    this.setStatus(`Merged segments ${k} and ${k + 1}.`);
  }

  /** Crop [t0, t1] out of the timeline: cut at both ends, and join whatever lies between into one segment */
  cropRange(t0: number, t1: number) {
    t0 = r3(t0); t1 = r3(t1);
    if (t1 - t0 < 0.1) return this.setStatus("Drag a longer range (at least 0.1 s) to crop.");
    this.pushUndo();
    [t0, t1].forEach(t => {
      const s = this.segAt(t);
      if (t > s.start + 0.05 && t < s.end - 0.05) this.splitAt(s, t);
    });
    const inside = () => this.segs.findIndex((s, k) => k && s.start >= t0 - 0.05 && s.end <= t1 + 0.05 && this.segs[k - 1].start >= t0 - 0.05);
    for (let k = inside(); k > 0; k = inside()) this.joinSegs(k);
    const c = this.segAt((t0 + t1) / 2);
    c.deleted = false;
    this.sel = c;
    this.afterStructure();
    this.select(c);
    this.seek(c.start);
    this.setStatus(`Cropped ${fmtT(c.start)} – ${fmtT(c.end)} into segment ${this.segs.indexOf(c) + 1}. Space to listen, Del to leave it out.`);
  }

  private joinSegs(k: number) {
    const a = this.segs[k - 1], b = this.segs[k];
    if (untouched(a) && untouched(b)) {
      a.words = [...a.words!, ...b.words!.map((w, j) => j ? w : { ...w, sp: true })];
      a.text = a.wordsText = wordsToText(a.words);
    } else {
      a.text = [a.text, b.text].filter(Boolean).join(" ");
      a.words = null;
    }
    if (a.normEdited || b.normEdited) { a.norm = [a.norm, b.norm].filter(Boolean).join(" "); a.normEdited = true; }
    else staleNorm(a);
    a.state = a.text ? "done" : "pending";
    a.error = "";
    a.deleted = a.deleted && b.deleted;
    a.end = b.end;
    this.segs.splice(k, 1);
    if (this.sel === b) this.sel = a;
  }

  toggleDelete(s: Seg) {
    if (this.readOnly) return;
    this.pushUndo();
    s.deleted = !s.deleted;
    this.afterStructure();
    const n = this.segs.filter(x => x.deleted).length;
    this.setStatus(`Segment ${this.segs.indexOf(s) + 1} ${s.deleted ? "deleted" : "restored"}.` + (n ? ` ${n} deleted segment(s) will be left out of the export.` : ""));
  }

  private afterStructure() { this.dirty(); this.updateUndo(); this.requestDraw(); this.hooks.structure?.(); }

  // ---------- undo / redo (cuts, merges, boundary moves, deletes) ----------
  private snap = () => JSON.stringify({ segs: this.segs, sel: this.sel && this.sel.id }, (k, v) => k.startsWith("_") ? undefined : v);
  private restore(str: string) {
    const o = JSON.parse(str);
    this.segs = o.segs.map((s: Seg) => ({ ...s, state: s.state === "running" ? "pending" : s.state }));
    this.sel = this.segs.find(s => s.id === o.sel) || null;
  }
  pushUndo(state = this.snap()) { this.undoStack.push(state); if (this.undoStack.length > 200) this.undoStack.shift(); this.redoStack.length = 0; this.updateUndo(); }
  undo() { if (!this.undoStack.length || this.readOnly) return; this.redoStack.push(this.snap()); this.restore(this.undoStack.pop()!); this.afterStructure(); }
  redo() { if (!this.redoStack.length || this.readOnly) return; this.undoStack.push(this.snap()); this.restore(this.redoStack.pop()!); this.afterStructure(); }
  updateUndo() { this.hooks.undoState?.(this.undoStack.length > 0, this.redoStack.length > 0); }

  // ---------- timeline: zoom / scroll / draw ----------
  applyZoom(keepT?: number, atX?: number) {
    if (!this.session) return;
    const fit = this.viewW() / Math.max(this.session.duration, 0.1), v = +this.el.zoom.value / 100;
    this.pps = fit >= MAX_PPS ? fit : fit * Math.pow(MAX_PPS / fit, v);
    this.el.spacer.style.width = Math.ceil(this.session.duration * this.pps) + "px";
    if (keepT != null) this.el.hbar.scrollLeft = keepT * this.pps - (atX != null ? atX : this.viewW() / 2);
    this.draw();
  }

  requestDraw() { if (!this.drawQueued) { this.drawQueued = true; requestAnimationFrame(() => { this.drawQueued = false; this.draw(); }); } }

  draw() {
    const { session, peaks } = this;
    if (!session || !peaks) return;
    const cv = this.el.canvas, w = this.viewW(), H = RULER + WAVE_H, dpr = window.devicePixelRatio || 1, pps = this.pps;
    if (!w) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + "px";
    }
    const g = cv.getContext("2d")!, X = this.X;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, H);
    const t0 = this.x0() / pps, t1 = (this.x0() + w) / pps, top = RULER, bot = H, mid = top + WAVE_H / 2;

    // segment regions (selected = blue, deleted = red, others alternate greens) + numbers
    g.font = "600 11px system-ui, sans-serif";
    this.segs.forEach((s, k) => {
      if (s.end < t0 || s.start > t1) return;
      const a = X(s.start), b = X(s.end);
      g.fillStyle = s.deleted ? "rgba(220,38,38,.10)" : s === this.sel ? "rgba(37,99,235,.24)" : k % 2 ? "rgba(37,99,235,.06)" : "rgba(37,99,235,.13)";
      g.fillRect(a, top, b - a, WAVE_H);
      if (b - a > 24) { g.fillStyle = s === this.sel ? "#1d4ed8" : s.deleted ? "#b91c1c" : "#4b5563"; g.fillText(String(k + 1), Math.max(a, 0) + 5, top + 14); }
    });

    // waveform
    const amp = (WAVE_H / 2 - 4) / this.peakMax * this.gain, nb = peaks.length / 2, ox = this.x0();
    g.fillStyle = "#64748b";
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor((ox + x) / pps * this.peakRate);
      if (b0 >= nb) break;
      const b1 = Math.min(nb, Math.max(b0 + 1, Math.floor((ox + x + 1) / pps * this.peakRate)));
      let lo = 0, hi = 0;
      for (let b = b0; b < b1; b++) { const l = peaks[2 * b], h = peaks[2 * b + 1]; if (l < lo) lo = l; if (h > hi) hi = h; }
      const y1 = Math.max(top, mid - hi * amp), y2 = Math.min(bot, mid - lo * amp);
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }

    // recognized words along the bottom
    this.segs.forEach(s => {
      if (!s.words || s.end < t0 || s.start > t1) return;
      s.words.forEach((wd, j) => { g.fillStyle = j % 2 ? "#93c5fd" : "#3b82f6"; g.fillRect(X(wd.start), bot - 5, Math.max(2, X(wd.end) - X(wd.start)), 4); });
    });

    // boundaries (draggable) and the selected segment's edges
    this.segs.forEach((s, k) => {
      if (!k || s.start < t0 - 1 || s.start > t1 + 1) return;
      const x = Math.round(X(s.start));
      g.fillStyle = "#1f2937"; g.fillRect(x - 1, top, 2, WAVE_H);
      g.fillRect(x - 4, top, 8, 4);
    });
    if (this.sel) [this.sel.start, this.sel.end].forEach(t => { const x = Math.round(X(t)); g.fillStyle = "#2563eb"; g.fillRect(x - 1, top, 2, WAVE_H); });

    // range being dragged for cropping
    if (this.dragRange) {
      const a = X(this.dragRange[0]), b = X(this.dragRange[1]);
      g.fillStyle = "rgba(30,58,138,.18)"; g.fillRect(a, top, b - a, WAVE_H);
      g.fillStyle = "#1e3a8a"; g.fillRect(Math.round(a) - 1, top, 2, WAVE_H); g.fillRect(Math.round(b) - 1, top, 2, WAVE_H);
      g.font = "600 11px system-ui, sans-serif";
      const label = `Crop ${(this.dragRange[1] - this.dragRange[0]).toFixed(2)} s`;
      if (b - a > g.measureText(label).width + 10) g.fillText(label, a + 5, bot - 10);
    }

    // time ruler
    g.fillStyle = "#fff"; g.fillRect(0, 0, w, RULER);
    g.fillStyle = "#e5e7eb"; g.fillRect(0, RULER - 1, w, 1);
    const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200].find(s => s * pps >= 90) || 3600;
    g.font = "10px system-ui, sans-serif";
    for (let n = Math.floor(t0 / step); n * step <= t1; n++) {
      const t = n * step, x = Math.round(X(t)) + 0.5;
      g.fillStyle = "#9ca3af"; g.fillRect(x, RULER - 10, 1, 9);
      for (let m = 1; m < 5; m++) g.fillRect(Math.round(X(t + m * step / 5)), RULER - 5, 1, 4);
      g.fillStyle = "#4b5563"; g.fillText(fmtT(t).slice(0, step < 1 ? -2 : -4), x + 3, 11);
    }

    // hover line (the cut tool shows where a click cuts)
    if (this.hover != null) {
      const x = Math.round(X(this.hover));
      if (this.cutMode && !this.readOnly) {
        g.fillStyle = "#dc2626"; g.fillRect(x - 1, top, 2, WAVE_H);
        const label = "✂ " + fmtT(this.hover); g.font = "600 11px system-ui, sans-serif";
        const tw = g.measureText(label).width + 8, lx = x + 4 + tw > w ? x - tw - 4 : x + 4;
        g.fillStyle = "#dc2626"; g.fillRect(lx, top + 4, tw, 18);
        g.fillStyle = "#fff"; g.fillText(label, lx + 4, top + 17);
      } else { g.fillStyle = "rgba(15,23,42,.3)"; g.fillRect(x, top, 1, WAVE_H); }
    }

    // playhead with time label
    const px = Math.round(X(this.pos));
    if (px >= -60 && px <= w + 2) {
      g.fillStyle = "#111827"; g.fillRect(px - 1, 0, 2, H);
      g.beginPath(); g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px, 7); g.fill();
      const label = fmtT(this.pos); g.font = "11px system-ui, sans-serif";
      const tw = g.measureText(label).width + 8, lx = px + 4 + tw > w ? px - tw - 4 : px + 4;
      g.fillStyle = "rgba(255,255,255,.85)"; g.fillRect(lx, mid - 9, tw, 18);
      g.fillStyle = "#111827"; g.fillText(label, lx + 4, mid + 4);
    }
  }

  // ---------- timeline mouse ----------
  private boundaryNear(e: MouseEvent) {   // index k of the segment whose start line is within 6 px, or -1
    const x = this.x0() + e.clientX - this.el.canvas.getBoundingClientRect().left;
    let best = -1, bd = 6;
    this.segs.forEach((s, k) => { if (!k) return; const d = Math.abs(s.start * this.pps - x); if (d < bd) { bd = d; best = k; } });
    return best;
  }

  private mouseDown(e: MouseEvent) {
    if (!this.session || e.button !== 0) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (this.cutMode && !this.readOnly) {   // cut tool: the click is the cut
      const t = this.tAt(e);
      this.looking = false;
      this.seek(t);
      this.cutAt(t);
      return;
    }
    const k = this.readOnly ? -1 : this.boundaryNear(e);
    const listen = (move: (ev: MouseEvent) => void, up: () => void) => {
      const done = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", done); up(); };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", done);
    };
    if (k < 0) {   // click = select + seek; drag = mark a range and crop it into its own segment
      const t0 = this.tAt(e), cx = e.clientX;
      this.seek(t0); this.select(this.segAt(t0));
      listen(ev => {
        if (this.readOnly || (Math.abs(ev.clientX - cx) < 4 && !this.dragRange)) return;
        const t = this.tAt(ev);
        this.dragRange = [Math.min(t0, t), Math.max(t0, t)];
        this.hover = t;
        this.setStatus(`Crop ${fmtT(this.dragRange[0])} – ${fmtT(this.dragRange[1])} (${(this.dragRange[1] - this.dragRange[0]).toFixed(2)} s) — release to cut`);
        this.requestDraw();
      }, () => {
        const r = this.dragRange;
        this.dragRange = null;
        if (r) this.cropRange(r[0], r[1]); else this.requestDraw();
      });
      return;
    }
    const a = this.segs[k - 1], b = this.segs[k];
    const before = this.snap(), old = b.start;
    const gaps = gapTimes([...(a.words || []), ...(b.words || [])]);   // word gaps the line snaps to
    listen(ev => {
      let t = this.tAt(ev);
      if (!ev.altKey) { const tol = 8 / this.pps; gaps.forEach(gp => { if (Math.abs(gp - t) < tol) t = gp; }); }
      a.end = b.start = r3(Math.min(b.end - 0.1, Math.max(a.start + 0.1, t)));
      this.hover = b.start; this.requestDraw();
    }, () => {
      if (b.start === old) return;
      this.pushUndo(before);
      if (untouched(a) && untouched(b)) {   // words follow the boundary, so the text stays in sync
        const all = [...a.words!, ...b.words!];
        a.words = all.filter(w => (w.start + w.end) / 2 < b.start);
        b.words = all.filter(w => (w.start + w.end) / 2 >= b.start);
        [a, b].forEach(s => { s.text = s.wordsText = wordsToText(s.words!); staleNorm(s); });
      }
      this.dirty();
      this.requestDraw();
      this.hooks.structure?.();
    });
  }

  // ---------- playback ----------
  private showClock() { if (this.session) this.el.clock.textContent = `${fmtT(this.pos)}/${fmtT(this.session.duration)}`; }

  seek(t: number) {
    if (!this.session) return;
    this.pos = Math.min(this.session.duration, Math.max(0, t));
    if (!this.player.paused) { this.player.currentTime = this.pos + this.session.offset; this.playEnd = null; }
    this.showClock(); this.requestDraw();
  }

  private follow(force = false) {   // keep the playhead on screen while playing
    const x = this.X(this.pos), w = this.viewW(), inView = x >= 0 && x <= w - 30;
    if (force) this.looking = false;
    if (this.looking) {                // the user is looking elsewhere: follow again once playback reaches the view
      if (inView) this.looking = false;
      return;
    }
    if (!inView) this.el.hbar.scrollLeft = this.pos * this.pps - w * 0.1;
  }

  private lookAround() {
    if (this.looking || !this.session) return;
    this.looking = true;
    if (!this.player.paused) this.setStatus("Scrolling freely — the view follows the playhead again when it gets there, or press play / click the waveform.");
  }

  async playFrom(t: number, end: number | null = null) {
    if (!this.session) return;
    this.pos = t; this.playEnd = end; this.looking = false;
    this.player.playbackRate = +this.el.speed.value;
    try { this.player.currentTime = t + this.session.offset; await this.player.play(); }
    catch (e: any) { return this.setStatus("Cannot play: " + e.message); }
    if (!this.ticking) { this.ticking = true; requestAnimationFrame(this.tick); }
  }

  private tick = () => {
    if (!this.session) { this.ticking = false; return; }
    if (!this.player.paused) {
      this.pos = this.player.currentTime - this.session.offset;
      if (this.playEnd != null && this.pos >= this.playEnd) { this.player.pause(); this.pos = this.playEnd; this.playEnd = null; }
      else if (this.pos >= this.session.duration) { this.player.pause(); this.pos = this.session.duration; }   // end of the crop
      else this.follow();
    }
    this.showClock(); this.draw();
    if (this.player.paused) { this.ticking = false; return; }
    requestAnimationFrame(this.tick);
  };

  togglePlay() {
    if (!this.session) return;
    if (!this.player.paused) return this.player.pause();
    this.playFrom(this.pos >= this.session.duration - 0.02 ? 0 : this.pos);
  }

  // ---------- keyboard ----------
  private keydown(e: KeyboardEvent) {
    if (!this.session || !this.el.canvas.offsetParent || document.querySelector("dialog[open]")) return;   // not on screen
    if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); return this.togglePlay(); }                   // works while typing
    const target = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) { if (e.key === "Escape") target.blur(); return; }
    const k = e.key.toLowerCase();
    if (k === "c" && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); return this.setCutMode(); }
    if (e.key === "Escape" && this.cutMode) { e.preventDefault(); return this.setCutMode(false); }
    if (e.code === "Space") { e.preventDefault(); this.togglePlay(); }
    else if (k === "s" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); this.cutHere(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && this.sel) { e.preventDefault(); this.toggleDelete(this.sel); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); this.seek(this.pos + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1)); this.follow(true); }
    else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.ctrlKey) { e.preventDefault(); this.stepSeg(e.key === "ArrowUp" ? -1 : 1); }
    else if ((e.ctrlKey || e.metaKey) && k === "z" && !e.shiftKey) { e.preventDefault(); this.undo(); }
    else if ((e.ctrlKey || e.metaKey) && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); this.redo(); }
  }
}

/** Text moved by a cut: drop the auto-normalized text; the package page makes it again from the annotation text */
function staleNorm(s: Seg) { if (!s.normEdited) s.norm = ""; }
