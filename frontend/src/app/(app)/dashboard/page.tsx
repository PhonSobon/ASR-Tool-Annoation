"use client";
// Dashboard: one page, two tabs. Projects (administrators and project managers): tasks, packages, the review,
// daily work. Team (administrators): what every user produced - the former Work Dashboard. /dashboard?tab=team
// opens the Team tab.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ProjectsView } from "@/components/dashboard/ProjectsView";
import { TeamView } from "@/components/dashboard/TeamView";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icon-sprite";
import { useCrumbs, useSession } from "@/components/session";

type Tab = "projects" | "team";
const TABS: { id: Tab; label: string; icon: IconName; perm: string; text: string }[] = [
  { id: "projects", label: "Projects", icon: "file", perm: "task.manage",
    text: "Where the work stands: tasks, packages through annotation and review, and what needs a manager." },
  { id: "team", label: "Team", icon: "users", perm: "users.manage",
    text: "What every user produced: hours annotated, packages done, returned and accepted, reviews and cleaned clips." },
];

export default function DashboardPage() {
  const { can } = useSession();
  const router = useRouter();
  const tabs = TABS.filter(t => can(t.perm));
  const [tab, setTab] = useState<Tab>("projects");
  const [refresh, setRefresh] = useState(0);
  const current = tabs.find(t => t.id === tab) || tabs[0];
  useCrumbs([["Workbench"], ["Dashboard"], [current?.label || ""]]);

  useEffect(() => {
    if (!can("task.manage") && !can("users.manage")) { router.replace("/tasks"); return; }
    const t = new URLSearchParams(location.search).get("tab");
    if (t === "team" || t === "projects") setTab(t);
  }, [can, router]);

  const open = (id: Tab) => {
    setTab(id);
    history.replaceState(null, "", id === "projects" ? "/dashboard" : `/dashboard?tab=${id}`);
  };
  if (!current) return null;

  return (
    <section className="activity dash">
      <header className="dash-head">
        <div>
          <h2>Dashboard</h2>
          <p>{current.text} Updates every minute.</p>
        </div>
        <button className="sec" onClick={() => setRefresh(n => n + 1)}><Icon name="restore" /> Refresh</button>
      </header>

      {tabs.length > 1 && (
        <nav className="dash-tabs" role="tablist" aria-label="Dashboard">
          {tabs.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === current.id}
                    className={t.id === current.id ? "on" : ""} onClick={() => open(t.id)}>
              <Icon name={t.icon} /> {t.label}
            </button>))}
        </nav>
      )}

      {current.id === "projects" ? <ProjectsView refresh={refresh} /> : <TeamView refresh={refresh} />}
    </section>
  );
}
