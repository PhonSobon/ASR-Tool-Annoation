"use client";
// Home page (public). The texts are in lib/home-text.tsx. UX: one clear
// action everywhere (Sign in / Open workspace), a sticky navbar that shows where you are (scroll spy) and folds into a
// menu on phones, the hero, then what the platform does (features), how a package
// moves (interactive workflow), the labeling process (3D), how a team shares the work, who does what (roles) and the
// usual questions (FAQ). Light / System / Dark switch in the navbar.
import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Logo } from "@/components/Logo";
import { ThemeSwitch } from "@/components/theme";
import { Tilt } from "@/components/Tilt";
import { Timeline } from "@/components/Timeline";
import { getJson } from "@/lib/api";
import { HOME as t } from "@/lib/home-text";
import { ROLES } from "@/lib/roles";
import type { Me } from "@/lib/types";

const SECTIONS = ["features", "workflow", "team", "roles", "faq"] as const;

export default function Home() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [menu, setMenu] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [active, setActive] = useState("");

  useEffect(() => { getJson<{ user: Me | null }>("/api/auth/me").then(j => setMe(j.user)).catch(() => setMe(null)); }, []);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on(); window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  // scroll spy: the section in the middle of the screen is the active navbar link
  useEffect(() => {
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) setActive(e.target.id); }),
                                        { rootMargin: "-45% 0px -50% 0px" });
    SECTIONS.forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!menu) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [menu]);

  const enter = me ? (me.must_change ? "/change-password" : "/tasks") : "/login";
  const enterLabel = me ? t.openWorkspace : t.signIn;
  const brand = <span>Data Annotation<small>Speech Annotation</small></span>;

  return (
    <div className="lp">
      <a className="lp-skip" href="#main">{t.skip}</a>

      <header className={`lp-nav${scrolled || menu ? " solid" : ""}`}>
        <div className="lp-nav-in">
          <Link className="lp-brand" href="/" onClick={() => setMenu(false)}><span className="lp-logo3d"><Logo /></span>{brand}</Link>
          <nav className="lp-links" aria-label={t.sections}>
            {SECTIONS.map(id => <a key={id} href={`#${id}`} className={active === id ? "on" : ""} aria-current={active === id ? "true" : undefined}>{t.nav[id]}</a>)}
          </nav>
          <div className="lp-actions">
            <ThemeSwitch className="lp-theme" />
            {me !== undefined && <Link className="lp-btn" href={enter}>{enterLabel}</Link>}
            <button type="button" className="lp-burger" aria-label={menu ? t.closeMenu : t.openMenu} aria-expanded={menu} aria-controls="lp-sheet"
                    onClick={() => setMenu(m => !m)}><Icon name={menu ? "x" : "menu"} /></button>
          </div>
        </div>
        {menu && (
          <div className="lp-sheet" id="lp-sheet">
            {SECTIONS.map(id => <a key={id} href={`#${id}`} onClick={() => setMenu(false)}>{t.nav[id]}</a>)}
            <div className="lp-sheet-row"><span>{t.theme}</span><ThemeSwitch labels /></div>
            {me !== undefined && <Link className="lp-btn lg block" href={enter}>{enterLabel}</Link>}
          </div>
        )}
      </header>

      <main id="main">
        {/* ---------- hero ---------- */}
        <section className="lp-hero">
          <div className="lp-hero-fade" aria-hidden="true" />
          <div className="lp-hero-in">
              <h1>{t.heroTitle}</h1>
              <p>{t.heroText}</p>
              <div className="lp-cta">
                {me !== undefined && <Link className="lp-btn lg" href={enter}>{enterLabel}</Link>}
                <a className="lp-btn lg ghost" href="#workflow">{t.howItWorks}</a>
              </div>
          </div>
        </section>

        {/* ---------- features ---------- */}
        <section className="lp-sec" id="features">
          <header className="lp-head">
            <h2>{t.featuresTitle}</h2>
            <p>{t.featuresText}</p>
          </header>
          <div className="lp-bento">
            {t.features.map(f => (
              <Tilt as="article" key={f.icon + f.title} className="lp-card" max={10}>
                <span className="lp-ico z3"><Icon name={f.icon} /></span>
                <h3 className="z2">{f.title}</h3>
                <p className="z1">{f.text}</p>
              </Tilt>
            ))}
          </div>
        </section>

        {/* ---------- how it works (timeline) ---------- */}
        <section className="lp-sec alt" id="workflow">
          <header className="lp-head">
            <h2>{t.workflowTitle}</h2>
            <p>{t.workflowText}</p>
          </header>
          <Timeline steps={t.steps} />
        </section>

        {/* ---------- teamwork ---------- */}
        <section className="lp-sec" id="team">
          <div className="lp-split">
            <div>
              <h2>{t.teamTitle}</h2>
              <p className="lp-lead">{t.teamText}</p>
              <ul className="lp-list">
                {t.teamPoints.map(p => <li key={p.icon}><Icon name={p.icon} /><span><b>{p.title}</b>{p.rest}</span></li>)}
              </ul>
            </div>
          </div>
        </section>

        {/* ---------- roles ---------- */}
        <section className="lp-sec alt" id="roles">
          <header className="lp-head">
            <h2>{t.rolesTitle}</h2>
            <p>{t.rolesText}</p>
          </header>
          <div className="lp-roles">
            {ROLES.map(r => (
              <Tilt key={r.id} className={`lp-role r-${r.id}`} max={10}>
                <span className="role-orb z3"><span className="role-mark" /></span>
                <div className="z1"><h3>{t.roles[r.id]?.label ?? r.label}</h3><p>{t.roles[r.id]?.summary ?? r.summary}</p></div>
              </Tilt>
            ))}
          </div>
        </section>

        {/* ---------- FAQ ---------- */}
        <section className="lp-sec" id="faq">
          <header className="lp-head">
            <h2>{t.faqTitle}</h2>
          </header>
          <div className="lp-faq">
            {t.faq.map(([q, a], k) => (
              <details key={k} open={k === 0}>
                <summary>{q}<Icon name="plus" /></summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <Tilt as="section" className="lp-final" max={3}>
          <div className="z2">
            <h2>{t.finalTitle}</h2>
            <p>{me ? t.finalIn : t.finalOut}</p>
          </div>
          {me !== undefined && <Link className="lp-btn lg light z3" href={enter}>{enterLabel}</Link>}
        </Tilt>
      </main>

      <footer className="lp-foot">
        <div>
          <Link className="lp-brand" href="/"><Logo />{brand}</Link>
          <p className="muted">{t.footerText}</p>
        </div>
        <nav aria-label={t.product}>
          <b>{t.product}</b>
          {SECTIONS.slice(0, 2).map(id => <a key={id} href={`#${id}`}>{t.nav[id]}</a>)}
        </nav>
        <nav aria-label={t.more}>
          <b>{t.more}</b>
          {SECTIONS.slice(2).map(id => <a key={id} href={`#${id}`}>{t.nav[id]}</a>)}
          {me !== undefined && <Link href={enter}>{enterLabel}</Link>}
        </nav>
      </footer>
    </div>
  );
}
