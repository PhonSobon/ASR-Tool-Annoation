"use client";
// Push to a Hugging Face dataset repo (tasks and datasets): repo, own repo or pull request, split, token, private.
// `children` adds the options of the caller (which packages / clips); `info` explains what goes up.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { Icon } from "./Icon";

export interface PushForm { repo_id: string; split: string; token: string; private: boolean; create_pr: boolean }

export function HubPushDialog({ title, defaults, suggestRepo, info, children, prRepo, onPush, onClose, canPush = true }: {
  title: string; defaults: { repo: string; split: string }; suggestRepo: (user: string) => string;
  info: (f: PushForm) => string; children?: ReactNode; prRepo?: string; canPush?: boolean;
  onPush: (f: PushForm) => Promise<void>; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [f, setF] = useState<PushForm>({ repo_id: defaults.repo, split: defaults.split, token: "", private: true, create_pr: false });
  const [msg, setMsg] = useState("");
  const needsToken = !f.create_pr && f.private;

  useEffect(() => {
    ref.current?.showModal();
    if (!defaults.repo) api("/api/hub/whoami", {}).then(r => {
      if (r.name) setF(x => x.repo_id ? x : { ...x, repo_id: suggestRepo(r.name) });
      else setMsg("Not logged in: enter a write token from huggingface.co/settings/tokens (or run `hf auth login`).");
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const push = async () => {
    if (needsToken && !f.token.trim()) return setMsg("⚠ A private repo needs your Hugging Face access token with write access (huggingface.co/settings/tokens).");
    try { await onPush(f); } catch (e: any) { setMsg("⚠ " + e.message); }
  };

  return (
    <dialog className="push-dlg" ref={ref} onClose={onClose}>
      <h3><Icon name="upload" /> {title}</h3>
      <label className="fld"><span className="req">Dataset repo</span>
        <input placeholder="your-name/khmer_asr_dataset" autoComplete="off" value={f.repo_id} onChange={e => setF({ ...f, repo_id: e.target.value })} /></label>
      <div className="radios col">
        <label><input type="radio" checked={!f.create_pr} onChange={() => setF({ ...f, create_pr: false, repo_id: f.repo_id === prRepo ? "" : f.repo_id })} /> Push to my repo (created if it does not exist)</label>
        <label><input type="radio" checked={f.create_pr} onChange={() => setF({ ...f, create_pr: true, repo_id: prRepo || f.repo_id })} /> Open a pull request on an existing repo</label>
      </div>
      <div className="form-grid push-grid">
        {children}
        <label className="fld"><span>Split</span><input value={f.split} onChange={e => setF({ ...f, split: e.target.value })} /></label>
        <label className="fld"><span className={needsToken ? "req" : ""}>Access token (write)</span>
          <input type="password" autoComplete="off" placeholder={needsToken ? "Required for a private repo (hf_…)" : "Empty = your saved hf login"}
                 value={f.token} onChange={e => setF({ ...f, token: e.target.value })} /></label>
      </div>
      <label className="muted"><input type="checkbox" checked={f.private} disabled={f.create_pr} onChange={e => setF({ ...f, private: e.target.checked })} /> Private repo (needs your access token)</label>
      <p className="muted push-info">{info(f)}{msg ? "\n" + msg : ""}</p>
      <div className="confirm-actions">
        <button type="button" className="sec" onClick={onClose}>Cancel</button>
        <button type="button" disabled={!canPush} onClick={push}><Icon name="upload" /> Push</button>
      </div>
    </dialog>
  );
}
