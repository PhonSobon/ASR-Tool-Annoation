// Pair the audio files of a folder with their labels, in the browser (before anything is uploaded). A label is
//  - a text file next to the audio with the same name: wavs/a.wav + wavs/a.txt (or .lab, or a.json with {"text": ...}),
//    or such a file in another folder when no other audio is called "a", or
//  - a line of a metadata file: metadata.csv / .tsv / .txt / .list with "file<sep>text" lines - separators "|"
//    (LJSpeech: id|text|normalized), tab, comma, or a space after the id (Kaldi "text": utt_id words...). A header
//    row names the columns (file / path / audio / id ... and transcription / text / sentence ...), or
//  - an entry of a JSON file: metadata.json as this tool exports it ([{"file": "wavs/a.wav", "text": ...}, ...]),
//    {"data": [...]}, {"a.wav": "text", ...}, or JSON Lines / NeMo manifests ({"audio_filepath": ..., "text": ...}
//    on each line, .jsonl). The same column names as above are looked for, in any letter case.
export const AUDIO_EXTS = [".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".wma", ".webm", ".mp4"];
const LABEL_EXTS = [".txt", ".lab", ".json"];
const JSON_EXTS = [".json", ".jsonl", ".ndjson"];
const META_EXTS = [".csv", ".tsv", ".txt", ".list", ".lst", ".trans", ...JSON_EXTS];
const FILE_COLS = ["file_name", "filename", "file", "path", "audio_filepath", "audio_file_path", "file_path", "audio", "audio_path",
                   "audio_file", "wav", "wav_path", "id", "utt_id", "name"];
const TEXT_COLS = ["transcription", "text", "sentence", "transcript", "label", "raw_transcription", "normalized_text"];

export interface Pair { file: File; name: string; text: string | null; from: string }   // from: the label file, "" = none
// metaFiles: the metadata files that gave labels; ignored: the other files that are neither audio nor a label
export interface Scan { pairs: Pair[]; metaFiles: string[]; ignored: number; folder: string }

const ext = (p: string) => { const m = /\.[^./]+$/.exec(p); return m ? m[0].toLowerCase() : ""; };
const noExt = (p: string) => p.replace(/\.[^./]+$/, "");
const stem = (p: string) => noExt(p.split("/").pop() || "").toLowerCase();
const relPath = (f: File) => ((f as any).webkitRelativePath || (f as any).relPath || f.name).replace(/\\/g, "/");
const hidden = (p: string) => p.split("/").some(s => s.startsWith(".") || s === "__MACOSX") || /^(thumbs\.db|desktop\.ini)$/i.test(p.split("/").pop() || "");
const clean = (t: string) => t.replace(/^﻿/, "").replace(/\s+/g, " ").trim();

/** Rows of a delimited text (quotes as in CSV: "a, b" and "" inside quotes). */
export function parseRows(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (q) {
      if (c === '"' && text[k + 1] === '"') { cell += '"'; k++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === "") q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[k + 1] === "\n") k++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

// ---------- JSON ----------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
/** The value of the first of `keys` the object has (letter case ignored). */
const field = (o: Obj, keys: string[]) => {
  const lower = new Map(Object.keys(o).map(k => [k.toLowerCase(), k]));
  for (const k of keys) if (lower.has(k) && o[lower.get(k)!] != null) return o[lower.get(k)!];
  return undefined;
};
/** A label in JSON: a string, or an object with a text field. */
export function jsonText(v: unknown): string | null {
  if (typeof v === "string") return clean(v);
  if (!isObj(v)) return null;
  const t = field(v, TEXT_COLS);
  return typeof t === "string" ? clean(t) : null;
}
/** The audio file named by a JSON record: a string, or {path} as in a Hugging Face audio column. */
function jsonFile(o: Obj): string | null {
  const f = field(o, FILE_COLS);
  if (typeof f === "string" || typeof f === "number") return String(f);
  if (isObj(f) && typeof f.path === "string") return f.path;
  return null;
}
/** The JSON of a file: one document, or JSON Lines (one per line). null when it is not JSON. */
function readJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* maybe JSON Lines */ }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  try { return lines.length ? lines.map(l => JSON.parse(l)) : null; } catch { return null; }
}
/** "file -> text" entries of a JSON metadata file. */
export function parseJson(text: string): [string, string][] {
  let doc = readJson(text.replace(/^﻿/, ""));
  if (isObj(doc)) {   // {"data": [...]}, one record, or {"a.wav": "text" | {...}}
    const list = Object.values(doc).find(v => Array.isArray(v) && v.some(isObj));
    doc = list ?? (jsonFile(doc) && jsonText(doc) != null ? [doc]
                   : Object.entries(doc).map(([k, v]) => isObj(v) && jsonFile(v) ? v : { file: k, text: jsonText(v) }));
  }
  if (!Array.isArray(doc)) return [];
  const out: [string, string][] = [];
  for (const r of doc) {
    if (!isObj(r)) continue;
    const f = jsonFile(r), t = jsonText(r);
    if (f && t != null) out.push([f, t]);
  }
  return out;
}

/** "file -> text" lines of a metadata file ([] when it does not look like one). */
export function parseMetadata(text: string, name: string): [string, string][] {
  if (JSON_EXTS.includes(ext(name))) return parseJson(text);
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] || "";
  const sep = ext(name) === ".tsv" || first.includes("\t") ? "\t" : first.includes("|") ? "|"
            : ext(name) === ".csv" && first.includes(",") ? "," : " ";
  const rows = sep === " "   // Kaldi style: the id, then the words
    ? text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => { const m = /^(\S+)\s+(.*)$/.exec(l); return m ? [m[1], m[2]] : [l]; })
    : parseRows(text, sep);
  if (!rows.length) return [];
  let fileCol = 0, textCol = 1;
  const head = rows[0].map(h => h.trim().toLowerCase());
  const fc = FILE_COLS.find(c => head.includes(c)), tc = TEXT_COLS.find(c => head.includes(c));
  if (fc || tc) {                                     // a header row
    rows.shift();
    fileCol = fc ? head.indexOf(fc) : 0;
    textCol = tc ? head.indexOf(tc) : head.findIndex((_, k) => k !== fileCol);
  }
  return rows.filter(r => r.length > Math.max(fileCol, textCol) && r[fileCol].trim())
             .map(r => [r[fileCol].trim(), clean(r[textCol])]);
}

/** Pair every audio file with its label (read in the browser). */
export async function scanFiles(files: File[]): Promise<Scan> {
  const all = files.map(f => ({ f, p: relPath(f) })).filter(x => !hidden(x.p));
  // the folder picked is the first part of every path: leave it out of the names
  const tops = new Set(all.map(x => x.p.includes("/") ? x.p.split("/")[0] : ""));
  const folder = tops.size === 1 && !tops.has("") ? [...tops][0] : "";
  for (const x of all) if (folder) x.p = x.p.slice(folder.length + 1);

  const audios = all.filter(x => AUDIO_EXTS.includes(ext(x.p))).sort((a, b) => a.p.localeCompare(b.p, undefined, { numeric: true }));
  const byPath = new Map(audios.map(a => [noExt(a.p).toLowerCase(), a]));
  const byStem = new Map<string, typeof audios>();
  for (const a of audios) byStem.set(stem(a.p), [...(byStem.get(stem(a.p)) || []), a]);
  const find = (key: string) => {                     // a name in a label file / metadata line -> its audio
    key = key.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
    if (AUDIO_EXTS.includes(ext(key))) key = noExt(key);
    if (byPath.has(key)) return byPath.get(key)!;
    const same = byStem.get(stem(key)) || [];
    return same.length === 1 ? same[0] : same.find(a => noExt(a.p).toLowerCase().endsWith("/" + key));
  };

  const labels = new Map<typeof audios[number], { text: string; from: string; exact: boolean }>();
  const others = all.filter(x => !AUDIO_EXTS.includes(ext(x.p)));
  const metaFiles: string[] = [];
  let ignored = 0;
  for (const x of others) {                           // 1. a text file per audio
    const e = ext(x.p);
    if (!LABEL_EXTS.includes(e)) continue;
    const exact = byPath.get(noExt(x.p).toLowerCase()), a = exact || ((byStem.get(stem(x.p)) || []).length === 1 ? byStem.get(stem(x.p))![0] : undefined);
    if (!a || (labels.get(a)?.exact && !exact)) continue;
    let text: string | null = await x.f.text();
    if (e === ".json") {                              // a.json: {"text": ...} or "text" (else maybe a metadata file)
      text = jsonText(readJson(text.replace(/^﻿/, "")));
      if (text == null) continue;
    } else text = clean(text);
    labels.set(a, { text, from: x.p, exact: !!exact });
    (x as any).used = true;
  }
  for (const x of others) {                           // 2. metadata files, for the audio with no text file
    if ((x as any).used) continue;
    if (!(META_EXTS.includes(ext(x.p)) || /(^|\/)text$/i.test(x.p)) || x.f.size > 50e6) { ignored++; continue; }   // Kaldi: "text"
    const lines = parseMetadata(await x.f.text(), x.p);
    let used = 0;
    for (const [key, text] of lines) {
      const a = find(key);
      if (a && !labels.has(a)) { labels.set(a, { text, from: x.p, exact: false }); used++; }
    }
    if (used) metaFiles.push(x.p); else ignored++;
  }
  return {
    pairs: audios.map(a => ({ file: a.f, name: a.p, text: labels.get(a)?.text ?? null, from: labels.get(a)?.from || "" })),
    metaFiles, ignored, folder,
  };
}

/** Every file under the folders / files dropped on the page (a dropped folder is read recursively). */
export async function droppedFiles(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return [...dt.files];
  const out: File[] = [];
  const walk = async (e: FileSystemEntry, path: string): Promise<void> => {
    if (e.isFile) {
      const f = await new Promise<File>((ok, err) => (e as FileSystemFileEntry).file(ok, err));
      Object.defineProperty(f, "relPath", { value: path + e.name });
      out.push(f);
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {   // readEntries returns at most 100 entries at a time
        const batch = await new Promise<FileSystemEntry[]>((ok, err) => reader.readEntries(ok, err));
        if (!batch.length) break;
        for (const c of batch) await walk(c, path + e.name + "/");
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}
