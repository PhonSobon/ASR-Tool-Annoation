"use client";
// The logged-in user (GET /api/auth/me) and what the role may do, the breadcrumbs and the header's save status.
// Wraps every page behind the login: nobody logged in -> /login; still on the default password -> /change-password.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getJson } from "@/lib/api";
import type { DirectoryUser, Me } from "@/lib/types";

export { ROLE_LABEL } from "@/lib/roles";

export type Crumb = [label: string, href?: string];
export type SaveKind = "ok" | "err" | "";

interface SessionApi {
  me: Me;
  can: (perm: string) => boolean;
  crumbs: Crumb[];
  setCrumbs: (c: Crumb[]) => void;
  save: { text: string; kind: SaveKind };
  setSave: (text: string, kind?: SaveKind) => void;
  /** active users for the members dialogs and names (managers only; others get []) */
  directory: () => Promise<DirectoryUser[]>;
  nameOf: (username: string) => string;
}

const Ctx = createContext<SessionApi | null>(null);
export const useSession = () => useContext(Ctx)!;

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [save, setSaveState] = useState<{ text: string; kind: SaveKind }>({ text: "", kind: "" });
  const [dir, setDir] = useState<DirectoryUser[] | null>(null);

  useEffect(() => {
    getJson<{ user: Me | null }>("/api/auth/me")
      .then(j => !j.user ? router.replace("/login") : j.user.must_change ? router.replace("/change-password") : setMe(j.user))
      .catch(() => router.replace("/login"));
  }, [router]);

  const can = useCallback((perm: string) => !!me?.permissions.includes(perm), [me]);
  const setSave = useCallback((text: string, kind: SaveKind = "") => setSaveState({ text, kind }), []);
  const directory = useCallback(async () => {
    if (dir) return dir;
    if (!me?.permissions.includes("task.manage") && !me?.permissions.includes("dataset.manage")) return [];
    const users = (await getJson<{ users: DirectoryUser[] }>("/api/users/directory")).users;
    setDir(users);
    return users;
  }, [dir, me]);
  const nameOf = useCallback((u: string) => dir?.find(x => x.username === u)?.name || u, [dir]);

  useEffect(() => { if (me) directory().catch(() => {}); }, [me, directory]);

  if (!me) return <div className="boot muted">Loading…</div>;
  return (
    <Ctx.Provider value={{ me, can, crumbs, setCrumbs, save, setSave, directory, nameOf }}>
      {children}
    </Ctx.Provider>
  );
}

/** Set the breadcrumbs of a page. */
export function useCrumbs(crumbs: Crumb[]) {
  const { setCrumbs } = useSession();
  const key = JSON.stringify(crumbs);
  useEffect(() => { setCrumbs(JSON.parse(key)); }, [key, setCrumbs]);
}
