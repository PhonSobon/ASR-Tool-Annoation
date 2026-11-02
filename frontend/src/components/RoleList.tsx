// The roles as a list: colour mark, name, what the role does, and (on Users & Roles) what it may do in detail.
import type { ReactNode } from "react";
import { ROLES } from "@/lib/roles";

export function RoleList({ details, highlight }: { details?: Record<string, ReactNode>; highlight?: string }) {
  return (
    <ul className="role-list">
      {ROLES.map(r => (
        <li key={r.id} className={`r-${r.id}${highlight === r.id ? " on" : ""}`}>
          <span className="role-mark" aria-hidden="true" />
          <div className="role-body">
            <b>{r.label}{highlight === r.id && <span className="role-you">Your role</span>}</b>
            <p>{r.summary}</p>
            {details?.[r.id]}
          </div>
        </li>
      ))}
    </ul>
  );
}
