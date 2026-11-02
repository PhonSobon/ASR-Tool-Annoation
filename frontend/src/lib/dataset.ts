// Dataset cleaning: labels, clip helpers and the text / ASR diff.
import type { ClipItem } from "./types";

export const CAT_LABEL: Record<string, string> = { pass: "Passed", review: "Needs review", bad: "Likely bad", unchecked: "Not checked" };
export const STATUS_LABEL: Record<string, string> = { todo: "To review", accepted: "Accepted", rejected: "Rejected" };
export const FLAG_SHORT: Record<string, string> = {
  empty_text: "No text", no_speech: "No speech", too_short: "Too short", dup_audio: "Duplicate audio",
  asr_empty: "ASR heard nothing", too_long: "Too long", digits: "Digits", latin: "Latin letters", symbols: "Symbols",
  clipping: "Clipping", quiet: "Quiet", rate: "Speaking rate", long_silence: "Long silence", dup_text: "Same text",
};
export const REJECT_REASONS = ["Text does not match audio", "Text cut off", "Bad audio quality", "No speech / noise", "Duplicate", "Wrong language", "Other"];

export const clipTrim = (it: ClipItem): [number, number] => it.trim || [0, it.duration];
export const clipLen = (it: ClipItem) => { const [s, e] = clipTrim(it); return e - s; };
export const rowLabel = (it: ClipItem) => it.part ? `${it.idx} · ${it.part}` : `${it.idx}`;
export const fmtCer = (c: number | null) => c == null ? "–" : `${Math.round(c * 100)}%`;
export const cerClass = (c: number | null, pass: number) => c == null ? "" : c <= pass ? "cer-pass" : c <= 0.5 ? "cer-review" : "cer-bad";

// Grapheme diff that ignores spaces and punctuation: "del" = in the text but not heard, "ins" = heard but not in the text
export interface DiffRun { text: string; bad: boolean }
const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("km", { granularity: "grapheme" }) : null;
const graphemes = (t: string) => segmenter ? [...segmenter.segment(t || "")].map(x => x.segment) : [...(t || "")];
const isKeyUnit = (g: string) => /[\p{L}\p{M}\p{N}]/u.test(g);

export function diff(a: string, b: string): [DiffRun[], DiffRun[]] {
  const A = graphemes(a), B = graphemes(b);
  const ka = A.flatMap((g, i) => isKeyUnit(g) ? [i] : []), kb = B.flatMap((g, i) => isKeyUnit(g) ? [i] : []);
  const n = ka.length, m = kb.length, W = m + 1, dp = new Uint16Array((n + 1) * W);
  const same = (i: number, j: number) => A[ka[i]].toLowerCase() === B[kb[j]].toLowerCase();
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * W + j] = same(i, j) ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const okA = new Set<number>(), okB = new Set<number>();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (same(i, j)) { okA.add(ka[i++]); okB.add(kb[j++]); }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++; else j++;
  }
  const runs = (G: string[], ok: Set<number>) => {
    const out: DiffRun[] = [];
    let run = "", bad = false;
    const flush = () => { if (run) out.push({ text: run, bad }); run = ""; };
    G.forEach((g, i) => { const miss = isKeyUnit(g) && !ok.has(i); if (miss !== bad && isKeyUnit(g)) { flush(); bad = miss; } run += g; });
    flush();
    return out;
  };
  return [runs(A, okA), runs(B, okB)];
}
