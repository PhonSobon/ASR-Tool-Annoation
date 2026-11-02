// One open task: its packages (crops of its audio) and their saving. A package keeps its dialogue segments in
// crop.parts (times in the audio file); crop.text / norm / state follow them (syncCrop). Every change is saved per
// audio (PUT /api/audios/<id>/state) with only the packages changed, so people working on different packages of
// one audio do not overwrite each other. Components re-render on `version` (subscribe).
import { api } from "./api";
import { nowStamp } from "./format";
import { cropEditable, ensureParts, pkgName } from "./review";
import type { Crop, Task } from "./types";

export type TaskAudio = Task["audios"][number];
export interface Pkg { audio: TaskAudio; seg: Crop; no: number; pkg: string }

export class TaskStore {
  crops: Pkg[];
  version = 0;
  private listeners = new Set<() => void>();
  private timers = new Map<TaskAudio, ReturnType<typeof setTimeout>>();
  private changed = new Map<TaskAudio, Set<Crop>>();
  unsaved = new Set<TaskAudio>();
  readonly peaks = new Map<string, { peaks: Int8Array; rate: number }>();   // audio id -> waveform of the whole file

  constructor(public task: Task, private username: string,
              private onSave: (text: string, kind?: "ok" | "err" | "") => void,
              private onError: (message: string) => void) {
    this.crops = task.audios.flatMap(a => a.segments.map((seg, k) => {
      ensureParts(seg);
      return { audio: a, seg, no: k + 1, pkg: pkgName(a.name, k + 1) };
    }));
  }

  get access() { return this.task.access; }
  editable = (c: Pkg) => cropEditable(c.seg, this.task.access);

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  emit() { this.version++; this.listeners.forEach(f => f()); }

  /** touched = the annotator changed it (stamps annotator + update time); false for automatic updates */
  markDirty(c: Pkg, touched = true) {
    if (!this.editable(c)) return;              // read only for you: nothing is saved (the server would refuse it)
    if (touched) { c.seg.updated = nowStamp(); c.seg.annotator = this.username; }
    const a = c.audio;
    if (!this.changed.has(a)) this.changed.set(a, new Set());
    this.changed.get(a)!.add(c.seg);
    this.unsaved.add(a);
    clearTimeout(this.timers.get(a));
    this.timers.set(a, setTimeout(() => this.saveAudio(a), 800));
    this.onSave("Unsaved changes…");
    this.emit();
  }

  async saveAudio(a: TaskAudio) {
    clearTimeout(this.timers.get(a));
    if (!this.unsaved.delete(a)) return;
    const segments = JSON.parse(JSON.stringify(a.segments, (k, v) => k.startsWith("_") ? undefined : v))
      .map((s: Crop) => ({ ...s, parts: s.parts && s.parts.map(p => ({ ...p, state: p.state === "running" ? "pending" : p.state })) }));
    const changed = [...(this.changed.get(a) || [])];   // only these packages are saved: others may be edited elsewhere
    this.changed.delete(a);
    try {
      await api(`/api/audios/${a.id}/state`, { segments, changed: changed.map(s => a.segments.indexOf(s)) }, "PUT");
      if (!this.unsaved.size) this.onSave("All changes saved", "ok");
    } catch (e: any) {
      if (!this.unsaved.has(a)) this.onError(`Not saved (${a.name}): ${e.message}. It will be tried again with your next change.`);
      if (!this.changed.has(a)) this.changed.set(a, new Set());
      changed.forEach(s => this.changed.get(a)!.add(s));
      this.unsaved.add(a);
      this.onSave("Not saved: " + e.message, "err");
    }
    this.emit();
  }

  async flush() { for (const a of [...this.unsaved]) await this.saveAudio(a); }
}
