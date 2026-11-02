"use client";
// Members dialog (tasks and datasets): tick who works on it, per group.
import { useEffect, useRef, useState } from "react";
import type { DirectoryUser } from "@/lib/types";
import { ROLE_LABEL, useSession } from "./session";

export interface MemberGroup { key: string; label: string; roles: string[] }

export function MembersDialog({ title, text, groups, current, onSave, onClose }: {
  title: string; text: string; groups: MemberGroup[]; current: Record<string, string[] | undefined>;
  onSave: (value: Record<string, string[]>) => void; onClose: () => void;
}) {
  const { directory, can } = useSession();
  const ref = useRef<HTMLDialogElement>(null);
  const [people, setPeople] = useState<DirectoryUser[] | null>(null);
  const [value, setValue] = useState<Record<string, string[]>>(
    () => Object.fromEntries(groups.map(g => [g.key, [...(current[g.key] || [])]])));

  useEffect(() => { ref.current?.showModal(); directory().then(setPeople).catch(() => setPeople([])); }, [directory]);
  const toggle = (key: string, u: string) => setValue(v => ({
    ...v, [key]: v[key].includes(u) ? v[key].filter(x => x !== u) : [...v[key], u] }));

  return (
    <dialog className="confirm members-dlg" ref={ref} onClose={onClose}>
      <h3>{title}</h3>
      <p className="muted">{text}</p>
      <div className="mem-groups">
        {groups.map(g => {
          const list = (people || []).filter(u => g.roles.includes(u.role));
          return (
            <fieldset className="mem-group" key={g.key}>
              <legend>{g.label}</legend>
              {people === null ? <div className="muted">Loading…</div> : list.length ? list.map(u => (
                <label key={u.username}>
                  <input type="checkbox" checked={value[g.key].includes(u.username)} onChange={() => toggle(g.key, u.username)} /> {u.name}
                  <span className="muted">{u.username} · {ROLE_LABEL[u.role] || u.role}</span>
                </label>
              )) : <div className="muted">No user with this role yet{can("users.manage") ? " — add one in Users & Roles" : ""}.</div>}
            </fieldset>
          );
        })}
      </div>
      <div className="confirm-actions">
        <button type="button" className="sec" onClick={onClose}>Cancel</button>
        <button type="button" onClick={() => onSave(value)}>Save</button>
      </div>
    </dialog>
  );
}
