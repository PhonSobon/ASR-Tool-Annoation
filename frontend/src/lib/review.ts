// Packages of a task and their review: same rules as backend/annotation/review.py and tasks.py.
import type { Crop, Seg, TaskAccess } from "./types";

export const liveParts = (c: Crop) => (c.parts || []).filter(p => !p.deleted);

/** Annotator's state of a package. */
export type CropState = "pending" | "running" | "error" | "review" | "done" | "skipped";
export function cropState(c: Crop): CropState {
  const parts = liveParts(c);
  if (c.deleted || !parts.length) return "skipped";
  if (parts.some(p => p.state === "running")) return "running";
  if (parts.every(p => (p.text || "").trim())) return c.completed ? "done" : "review";
  return parts.some(p => p.state === "error") ? "error" : "pending";
}

/** one review step: annotating -> inspecting (waiting for review) -> accepted (or returned to the annotator) */
export type Stage = "annotating" | "returned" | "inspecting" | "accepted" | "skipped";
export function cropStage(c: Crop): Stage {
  const st = cropState(c);
  if (st === "skipped") return "skipped";
  if (st !== "done") return c.returned ? "returned" : "annotating";
  if (c.acceptance?.status === "accepted") return "accepted";
  return "inspecting";
}

export type Tab = "todo" | "review" | "done";
export const TABS: Tab[] = ["todo", "review", "done"];
export const TAB_OF: Record<Stage, Tab> = { annotating: "todo", returned: "todo", inspecting: "review", accepted: "done", skipped: "done" };
export const TAB_LABEL: Record<Tab, string> = { todo: "Todo", review: "Review", done: "Done" };
export const STATUS: Record<string, string> = {
  pending: "Pending", running: "Recognizing", error: "Error", review: "To check", done: "Completed", skipped: "Skipped",
  returned: "Returned", inspecting: "Waiting for review", accepted: "Accepted",
};
export const STAGE_TEXT: Record<Stage, string> = {
  annotating: "Being annotated", returned: "Returned to the annotator", inspecting: "Waiting for review",
  accepted: "Accepted", skipped: "Skipped",
};
export const inTab = (c: Crop, tab: Tab) => TAB_OF[cropStage(c)] === tab;
/** what the Status column shows: annotator state in Todo, else the review stage */
export const cropLabel = (c: Crop) => { const g = cropStage(c); return g === "annotating" ? cropState(c) : g; };

export const mayReview = (a: TaskAccess | null | undefined) => !!a && (a.review || a.manage);
/** may the user change this package? (once it is accepted only reviewers / managers may) */
export const cropEditable = (c: Crop, a: TaskAccess | null | undefined) =>
  !!a?.edit && (mayReview(a) || cropStage(c) !== "accepted");

/** who reviewed the package: who accepted it, or who returned it (or who passed it before the one review step) */
export const reviewerOf = (c: Crop) => c.acceptance?.by || c.returned?.by || c.inspection?.by || "";

export const handTyped = (s: Seg) => !!s.text && s.text !== s.wordsText;   // never overwrite in a batch
export const pkgName = (audioName: string, no: number) =>
  `${audioName.replace(/[^\p{L}\p{M}\p{N}_-]+/gu, "_")}_${String(no).padStart(4, "0")}`;   // = exported file name

/** Crops saved before dialogue segments existed get one part = the whole crop */
export function ensureParts(c: Crop) {
  if (!c.parts || !c.parts.length)
    c.parts = [{ id: 1, start: c.start, end: c.end, role: c.role || "Narrator", text: c.text || "", norm: c.norm || "",
                 normEdited: !!c.normEdited, words: c.words || null, wordsText: c.wordsText ?? null,
                 state: c.state === "running" ? "pending" : ((c.state as Seg["state"]) || "pending"), error: c.error || "", deleted: false }];
  c.parts.forEach(p => { if (p.state === "running") p.state = "pending"; });
  syncCrop(c);
}

/** c.text / norm / role / state summarize the parts (what My Tasks counts and older exports read) */
export function syncCrop(c: Crop) {
  const parts = liveParts(c);
  c.text = parts.map(p => (p.text || "").trim()).filter(Boolean).join(" ");
  c.norm = parts.map(p => (p.norm || "").trim()).filter(Boolean).join(" ");
  c.role = (parts[0] || {}).role || c.role || "Narrator";
  c.state = parts.length && parts.every(p => (p.text || "").trim()) ? "done" : parts.some(p => p.state === "error") ? "error" : "pending";
  if (c.state !== "done") c.completed = false;   // a segment lost its text (or a new one was cut): back to Todo
}
