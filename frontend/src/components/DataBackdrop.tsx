// Full-screen background of the sign-in pages: the data process drawn as one picture. Recordings stored on the
// server (left) flow as audio through ASR and review into the dataset (database and WAV / JSON files, right).
const WAVE = [14, 26, 40, 22, 52, 34, 60, 28, 46, 18, 38, 56, 30, 44, 20, 12];

function Rack({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width="190" height="74" rx="10" className="bd-box" />
      {[0, 1, 2].map(i => <rect key={i} x="20" y={18 + i * 14} width="96" height="5" rx="2.5" className="bd-slot" />)}
      <circle cx="150" cy="26" r="5" className="bd-led" />
      <circle cx="168" cy="26" r="5" className="bd-led b" />
      <circle cx="150" cy="48" r="5" className="bd-led c" />
    </g>
  );
}

function Cylinder({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`} className="bd-db">
      <path d="M0 22v120c0 12 40 22 90 22s90-10 90-22V22" />
      <ellipse cx="90" cy="22" rx="90" ry="22" />
      <path d="M0 62c0 12 40 22 90 22s90-10 90-22M0 102c0 12 40 22 90 22s90-10 90-22" fill="none" />
    </g>
  );
}

function File({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path d="M0 8a8 8 0 0 1 8-8h62l22 22v76a8 8 0 0 1-8 8H8a8 8 0 0 1-8-8z" className="bd-box" />
      <path d="M70 0v22h22" className="bd-fold" />
      <text x="46" y="70" className="bd-file">{label}</text>
    </g>
  );
}

/** fixed: behind the whole page (sign-in); else fills its positioned parent (the home page banner). */
export function DataBackdrop({ fixed = true }: { fixed?: boolean }) {
  return (
    <div className={`data-backdrop${fixed ? "" : " in-hero"}`} aria-hidden="true">
      <svg viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="bdSky" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#0b1b44" /><stop offset=".55" stopColor="#0f2a6b" /><stop offset="1" stopColor="#123c8c" />
          </linearGradient>
          <pattern id="bdDots" width="28" height="28" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.2" fill="#ffffff" opacity=".08" />
          </pattern>
          <radialGradient id="bdGlow" cx=".5" cy=".5" r=".5">
            <stop offset="0" stopColor="#3b82f6" stopOpacity=".35" /><stop offset="1" stopColor="#3b82f6" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="1440" height="900" fill="url(#bdSky)" />
        <rect width="1440" height="900" fill="url(#bdDots)" />
        <circle cx="720" cy="450" r="420" fill="url(#bdGlow)" />

        {/* server: stored recordings */}
        <text x="110" y="214" className="bd-label">SERVER · RECORDINGS</text>
        <Rack x={110} y={236} /><Rack x={110} y={326} /><Rack x={110} y={416} /><Rack x={110} y={506} />

        {/* audio flowing out of the server */}
        <g transform="translate(360 150)">
          {WAVE.map((h, i) => <rect key={i} x={i * 12} y={40 - h / 2} width="6" height={h} rx="3" className="bd-wave" />)}
        </g>
        <path d="M300 400 C 420 400 430 210 560 190" className="bd-flow" />
        <path d="M300 540 C 460 560 500 740 700 760 S 1000 720 1120 640" className="bd-flow" />
        <path d="M640 190 C 900 150 1000 250 1150 300" className="bd-flow" />

        {/* process steps along the way */}
        <g className="bd-step"><rect x="560" y="166" width="88" height="44" rx="22" /><text x="604" y="194">ASR</text></g>
        <g className="bd-step"><rect x="660" y="738" width="104" height="44" rx="22" /><text x="712" y="766">Review</text></g>

        {/* the dataset */}
        <text x="1140" y="270" className="bd-label">DATASET</text>
        <Cylinder x={1150} y={290} />
        <File x={1120} y={560} label="WAV" /><File x={1230} y={590} label="JSON" />

        {/* small rows of data at the bottom left */}
        <g transform="translate(110 660)" className="bd-rows">
          {[0, 1, 2, 3].map(i => (
            <g key={i} transform={`translate(0 ${i * 26})`}>
              <rect width="14" height="14" rx="4" className={i < 3 ? "ok" : ""} />
              <rect x="26" y="4" width={150 - i * 22} height="6" rx="3" />
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
