"use client";
// Home page (public): what the platform does, the workflow, and the way in (sign in only: accounts are
// made by the administrator).
import Link from "next/link";
import { useEffect, useState } from "react";
import { DataBackdrop } from "@/components/DataBackdrop";
import { Icon } from "@/components/Icon";
import { Logo } from "@/components/Logo";
import type { IconName } from "@/components/icon-sprite";
import { getJson } from "@/lib/api";
import type { Me } from "@/lib/types";

const STEPS: { icon: IconName; title: string; text: string }[] = [
  { icon: "upload", title: "Upload & Crop", text: "Cut long recordings into packages." },
  { icon: "recognize", title: "Annotate", text: "Transcribe with help from the Khmer ASR." },
  { icon: "search", title: "Inspect", text: "Pass, fix, or return to the annotator." },
  { icon: "check-circle", title: "Accept", text: "Final approval of inspected packages." },
  { icon: "download", title: "Export", text: "WAV + JSON, or push to Hugging Face." },
];

export default function Home() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => { getJson<{ user: Me | null }>("/api/auth/me").then(j => setMe(j.user)).catch(() => setMe(null)); }, []);
  const enter = me ? (me.must_change ? "/change-password" : "/tasks") : "/login";
  const enterLabel = me ? "Open workspace" : "Sign in";

  return (
    <div className="home">
      <header className="home-nav">
        <Link className="brand" href="/"><Logo /><span>Data Annotation Platform</span></Link>
        <nav>
          <a href="#workflow">Workflow</a>
          {me !== undefined && <Link className="btn" href={enter}>{enterLabel}</Link>}
        </nav>
      </header>

      <section className="home-banner">
        <DataBackdrop fixed={false} />
        <div className="home-hero">
          <span className="hero-tag">Khmer speech · ASR datasets</span>
          <h1>Build clean Khmer speech datasets, together.</h1>
          <p>Upload recordings, transcribe them with a local Khmer ASR model, check every package in two review steps and
            export training-ready data. Everything runs on your own server.</p>
          <div className="hero-cta">
            <Link className="btn lg" href={enter}>{enterLabel} <Icon name="arrow-right" /></Link>
          </div>
          {me
            ? <p className="hero-note">Signed in as <b>{me.name}</b> · {me.role_label}</p>
            : <p className="hero-note">No sign-up. Your administrator gives you a user name and a default password;
                you choose your own the first time you sign in.</p>}
        </div>
      </section>

      <section className="home-sec" id="workflow">
        <h2>How the work flows</h2>
        <ol className="home-steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="step-ico"><Icon name={s.icon} /></span>
              <b>{i + 1}. {s.title}</b>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
        <p className="home-also"><Icon name="database" /> Also: import a Hugging Face dataset, let the ASR flag clips whose
          text does not match the audio, fix or reject them, and push the cleaned data back.</p>
      </section>

      <footer className="home-foot">
        <span>Data Annotation Platform · Khmer ASR</span>
        {me !== undefined && <Link href={enter}>{enterLabel}</Link>}
      </footer>
    </div>
  );
}
