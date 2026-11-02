"use client";
// Page buttons: previous, numbers (or a page-number box for many pages), next, and an optional per-page choice.
import type { ReactNode } from "react";
import { Icon } from "./Icon";

export function Pager({ page, pages, onPage, label, tail, perPage, perOptions, onPer, className = "pkg-pager", numberBox }: {
  page: number; pages: number; onPage: (p: number) => void; label?: ReactNode; tail?: ReactNode; className?: string;
  perPage?: number; perOptions?: number[]; onPer?: (n: number) => void; numberBox?: boolean;
}) {
  return (
    <div className={className}>
      {label && <span>{label}</span>}
      <button disabled={page <= 1} aria-label="Previous page" onClick={() => onPage(page - 1)}><Icon name="chevron-left" /></button>
      {numberBox || pages > 12
        ? <span>Page <input type="number" min={1} max={pages} value={page} className="num"
                            onChange={e => onPage(Math.max(1, Math.min(pages, +e.target.value || 1)))} /> / {pages}</span>
        : Array.from({ length: pages }, (_, i) => (
            <button key={i} className={i + 1 === page ? "on" : ""} onClick={() => onPage(i + 1)}>{i + 1}</button>))}
      <button disabled={page >= pages} aria-label="Next page" onClick={() => onPage(page + 1)}><Icon name="chevron-right" /></button>
      {perOptions && onPer && (
        <select aria-label="Per page" value={perPage} onChange={e => onPer(+e.target.value)}>
          {perOptions.map(n => <option key={n} value={n}>{n} / page</option>)}
        </select>)}
      {tail && <span>{tail}</span>}
    </div>
  );
}
