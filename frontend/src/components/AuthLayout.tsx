"use client";
// The sign-in pages (/login, /change-password): the 3D scene with a short introduction on one side, the form card on
// the other, the Light / System / Dark switch at the top. On a phone the scene fills the screen behind the card.
import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { AuthScene } from "./AuthScene";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { ThemeSwitch } from "./theme";

export function AuthLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.body.classList.add("auth-body");
    return () => document.body.classList.remove("auth-body");
  }, []);
  return (
    <div className="auth">
      <div className="auth-stage">
        <AuthScene shift={{ y: 0.17 }} shiftNarrow={{ y: 0.3 }} />
        <div className="auth-copy">
          <span className="auth-eyebrow"><span className="dot" /> Khmer speech · ASR datasets</span>
          <h2>Turn Khmer speech into <em>clean training data.</em></h2>
          <ul>
            <li><Icon name="recognize" /> Local Khmer ASR drafts every transcript</li>
            <li><Icon name="shield" /> One review: a reviewer accepts or returns each package</li>
            <li><Icon name="download" /> Export WAV + JSON or push to Hugging Face</li>
          </ul>
        </div>
      </div>
      <div className="auth-side">
        <div className="auth-top">
          <Link className="auth-brand" href="/"><Logo /><span>Data Annotation<small>Speech Annotation</small></span></Link>
          <div className="auth-top-r"><Link className="auth-home" href="/">Home</Link><ThemeSwitch /></div>
        </div>
        <div className="auth-center">{children}</div>
        <p className="auth-foot">Runs on your own server · no cloud, no API key</p>
      </div>
    </div>
  );
}
