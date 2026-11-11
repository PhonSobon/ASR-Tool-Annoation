"use client";
// Home page "How it works": a vertical timeline, no cards. A line runs down the middle (on phones: the left edge) with
// the steps alternating left and right. While you scroll, the line fills with blue, each step's dot lights up as you
// reach it and its text slides in. "Reduce motion": everything shown at once.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { HomeText } from "@/lib/home-text";

export function Timeline({ steps }: { steps: HomeText["steps"] }) {
  const box = useRef<HTMLOListElement>(null);
  const [fill, setFill] = useState(0);              // 0..1: how far the blue line has filled
  const [reached, setReached] = useState(-1);       // the last step whose dot is lit

  useEffect(() => {
    const el = box.current!;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setFill(1); setReached(steps.length - 1); return; }
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect(), mark = window.innerHeight * 0.6;   // the point on screen the line fills to
      setFill(Math.max(0, Math.min(1, (mark - r.top) / r.height)));
      const dots = el.querySelectorAll<HTMLElement>(".tl-dot");
      let last = -1;
      dots.forEach((d, i) => { if (d.getBoundingClientRect().top < mark) last = i; });
      setReached(last);
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => { window.removeEventListener("scroll", on); window.removeEventListener("resize", on); cancelAnimationFrame(raf); };
  }, [steps.length]);

  return (
    <ol className="tl" ref={box}>
      <span className="tl-line" aria-hidden="true"><i style={{ transform: `scaleY(${fill})` }} /></span>
      {steps.map((s, i) => (
        <li key={s.title} className={`tl-step${i % 2 ? " right" : " left"}${i <= reached ? " in" : ""}`}>
          <span className="tl-dot" aria-hidden="true"><Icon name={s.icon} /></span>
          <div className="tl-body">
            <span className="tl-num">{String(i + 1).padStart(2, "0")}</span>
            <h3>{s.title}</h3>
            <span className={`tl-who w-${s.role}`}>{s.who}</span>
            <p>{s.text}</p>
            <ul>{s.points.map(p => <li key={p}>{p}</li>)}</ul>
            <span className="tl-out">→ {s.out}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
