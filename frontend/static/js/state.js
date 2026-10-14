// Editor state shared by the scripts below (classic scripts share top-level variables).
// ---------- state ----------
let session = null;          // what the cut editor shows: {id (audio), name, duration, offset?, onSave?}
                             // offset = where it starts in the audio file (a package = one crop of a long audio);
                             // onSave(segments) replaces the default save (PUT /api/audios/<id>/state)
let segs = [];               // segments in time order, covering the whole audio without gaps
let sel = null;              // selected segment
let nextId = 1;
let peaks = null, peakRate = 200, peakMax = 1;
let pps = 50, gain = 1;      // timeline zoom (pixels per second), waveform height
let pos = 0, hover = null;   // playhead, mouse time
let playEnd = null, ticking = false;
let dragRange = null;        // [t0, t1] while dragging across the waveform to crop
const undoStack = [], redoStack = [];
const player = new Audio();
const RULER = 24, WAVE_H = 170, MAX_PPS = 400;

const newSeg = o => ({ id: nextId++, start: 0, end: 0, text: "", norm: "", normEdited: false, role: "Narrator",
                       words: null, wordsText: null, state: "pending", error: "", deleted: false, ...o });
const untouched = s => !!s.words && s.text === s.wordsText;   // text still matches the word timings
const wordsToText = ws => ws.map((w, j) => (j && w.sp ? " " : "") + w.text).join("");
const gapTimes = ws => ws.slice(1).map((w, j) => (ws[j].end + w.start) / 2);
const segAt = t => segs.find(s => t >= s.start && t < s.end) || segs[segs.length - 1];

// Called by the editor so a page can follow it (the package page's segments table); no-ops on Upload & Crop
const hooks = { structure() {}, select() {} };

function setStatus(t) { $("status").textContent = t; }
