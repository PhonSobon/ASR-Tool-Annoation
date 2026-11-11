"use client";
// A card that leans toward the mouse in 3D, with a moving light reflection (CSS: .tilt in styles/landing.css). Children
// with class "z1" / "z2" / "z3" float above the card at different depths. Off on touch screens and for "reduce motion".
import { useRef, type ElementType, type ReactNode } from "react";

export function Tilt({ as: Tag = "div", className = "", max = 9, children, ...rest }:
  { as?: ElementType; className?: string; max?: number; children: ReactNode } & Record<string, unknown>) {
  const ref = useRef<HTMLElement>(null);
  const live = () => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (prefers-reduced-motion: no-preference)").matches;
  const move = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || e.pointerType !== "mouse" || !live()) return;
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    el.style.setProperty("--ry", `${(x - 0.5) * 2 * max}deg`);
    el.style.setProperty("--rx", `${(0.5 - y) * 2 * max}deg`);
    el.style.setProperty("--gx", `${x * 100}%`);
    el.style.setProperty("--gy", `${y * 100}%`);
    el.classList.add("tilting");
  };
  const leave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--rx", "0deg"); el.style.setProperty("--ry", "0deg");
    el.classList.remove("tilting");
  };
  return (
    <Tag ref={ref} className={`tilt ${className}`} onPointerMove={move} onPointerLeave={leave} {...rest}>
      {children}
      <span className="tilt-glare" aria-hidden="true" />
    </Tag>
  );
}
