"use client";
// Light / Dark / System theme. The choice is kept in this browser (localStorage "theme"); <html data-theme> holds the
// theme in effect ("light" | "dark"), which the stylesheets read (styles/base.css). THEME_SCRIPT runs in <head>
// before the first paint so a dark page never flashes white; "system" follows the OS setting, also when it changes.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./icon-sprite";

export type ThemePref = "light" | "dark" | "system";
const KEY = "theme";

export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem("${KEY}");if(p!=="light"&&p!=="dark")p="system";
var d=p==="dark"||(p==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.dataset.theme=d?"dark":"light";}catch(e){document.documentElement.dataset.theme="light";}})();`;

const dark = () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
const read = (): ThemePref => {
  try { const p = localStorage.getItem(KEY); return p === "light" || p === "dark" ? p : "system"; } catch { return "system"; }
};
const apply = (pref: ThemePref) => {
  document.documentElement.dataset.theme = pref === "dark" || (pref === "system" && dark()) ? "dark" : "light";
};

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>("system");
  useEffect(() => { setPref(read()); }, []);
  useEffect(() => {
    apply(pref);
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)"), on = () => apply("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [pref]);
  // another tab changed the choice
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === KEY) setPref(read()); };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);
  const set = useCallback((p: ThemePref) => {
    try { p === "system" ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, p); } catch { /* private window */ }
    setPref(p);
  }, []);
  return { pref, set };
}

const OPTIONS: { id: ThemePref; label: string; icon: IconName }[] = [
  { id: "light", label: "Light", icon: "sun" },
  { id: "system", label: "System", icon: "monitor" },
  { id: "dark", label: "Dark", icon: "moon" },
];

/** Three-way switch. `labels`: show the words next to the icons (menus); else icons only, the words as tooltips. */
export function ThemeSwitch({ labels = false, className = "" }: { labels?: boolean; className?: string }) {
  const { pref, set } = useTheme();
  return (
    <div className={`theme-switch${labels ? " with-labels" : ""} ${className}`} role="radiogroup" aria-label="Color theme">
      {OPTIONS.map(o => (
        <button key={o.id} type="button" role="radio" aria-checked={pref === o.id} className={pref === o.id ? "on" : ""}
                title={`${o.label} theme`} aria-label={labels ? undefined : `${o.label} theme`} onClick={() => set(o.id)}>
          <Icon name={o.icon} />{labels && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}
