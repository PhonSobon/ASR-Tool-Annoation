// The six roles as the UI shows them (home page, Users & Roles, account menu). The server decides what each role may
// really do (backend/auth/roles.py); keep the texts in step with it.
import type { Role } from "./types";

export interface RoleInfo { id: Role; label: string; summary: string }

export const ROLES: RoleInfo[] = [
  { id: "admin", label: "Administrator", summary: "Adds every account, sees every user's status and the full activity log." },
  { id: "manager", label: "Project Manager", summary: "Uploads audio, makes tasks, imports datasets, assigns people, exports." },
  { id: "annotator", label: "Annotator", summary: "Annotates the packages and dataset clips they are assigned to." },
  { id: "inspector", label: "Reviewer", summary: "Reviews completed packages: accept, fix the text, or return to the annotator." },
];

export const ROLE_LABEL: Record<string, string> = Object.fromEntries(ROLES.map(r => [r.id, r.label]));
export const roleInfo = (id: string) => ROLES.find(r => r.id === id);
