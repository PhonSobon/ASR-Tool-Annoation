"use client";
// The annotation rules, shown from the package page.
import { useEffect, useRef } from "react";
import { Icon } from "@/components/Icon";

export function SpecDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog className="spec" ref={ref} onClose={onClose}>
      <h3>Annotation Specification</h3>
      <ol>
        <li><b>Listen first.</b> Play the whole package before typing. Use 0.75x speed for fast speech.</li>
        <li><b>One segment = one speaker turn.</b> If a second person speaks, cut the audio there (S at the playhead, or drag across the waveform) and give each segment its role.</li>
        <li><b>Write exactly what is said</b> in Khmer script — no summaries, no grammar corrections. Keep repeated words and false starts.</li>
        <li><b>Numbers:</b> write them as spoken in the annotation text; the normalized text turns Khmer digits into 0-9 automatically.</li>
        <li><b>English words</b> spoken inside Khmer stay in Latin letters, and set <i>Code Switching Present</i> to Yes.</li>
        <li><b>Unclear speech:</b> if a word cannot be understood after three listens, write <code>[unclear]</code>.</li>
        <li><b>Noise, music only, or no speech:</b> skip the segment (<Icon name="trash" />) or the whole package.</li>
        <li><b>Normalized text</b> is made automatically (word-segmented, digits 0-9); edit it only if the segmentation is wrong.</li>
        <li><b>Role Information</b> describes the speaker of each role (age group, gender, native speaker); <b>Overall Audio Information</b> describes the whole package.</li>
      </ol>
      <form method="dialog"><button>Close</button></form>
    </dialog>
  );
}
