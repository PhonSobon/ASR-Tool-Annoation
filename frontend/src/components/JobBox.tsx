"use client";
// Background jobs on the server (push to the Hub, ASR checks, imports): poll GET <url> every second while one runs.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, getJson } from "@/lib/api";
import type { Job } from "@/lib/types";
import { Icon } from "./Icon";

/** The job at `jobUrl` ({job}); start() after starting one; onEnd(job) once when a watched job ends; onTick while running. */
export function useJob(jobUrl: string | null, onEnd: (job: Job) => void, onTick?: (job: Job, tick: number) => void) {
  const [job, setJob] = useState<Job | null>(null);
  const [visible, setVisible] = useState(false);
  const watching = useRef(false), timer = useRef<ReturnType<typeof setTimeout>>(undefined), tick = useRef(0);
  const ends = useRef(onEnd), ticks = useRef(onTick);
  ends.current = onEnd; ticks.current = onTick;

  const poll = useCallback(async () => {
    clearTimeout(timer.current);
    if (!jobUrl) return;
    let j: Job | null = null;
    try { j = (await getJson<{ job: Job | null }>(jobUrl)).job; } catch { /* keep polling */ }
    setJob(j);
    if (j?.running) {
      setVisible(true);
      watching.current = true;
      ticks.current?.(j, ++tick.current);
      timer.current = setTimeout(poll, 1000);
    } else if (watching.current && j) {
      watching.current = false;
      ends.current(j);
    }
  }, [jobUrl]);

  useEffect(() => { setVisible(false); watching.current = false; poll(); return () => clearTimeout(timer.current); }, [poll]);
  const start = useCallback(() => { watching.current = true; setVisible(true); poll(); }, [poll]);
  return { job, running: !!job?.running, visible: visible && !!job, start };
}

export function JobBox({ job, stopUrl, canStop = true }: { job: Job; stopUrl: string; canStop?: boolean }) {
  const url = job.result?.url as string | undefined;
  return (
    <div className={"job" + (job.error ? " err" : "")}>
      <span>
        {job.running ? <Icon name="loader" className="spin" /> : job.error ? <Icon name="alert" /> : <Icon name="check" />}{" "}
        {url ? job.message.replace(url, "") : job.message}
        {url && <a href={url} target="_blank" rel="noopener">{url}</a>}
      </span>
      {job.running && <div className="bar"><div style={{ width: `${job.total ? 100 * job.done / job.total : 0}%` }} /></div>}
      {job.running && canStop && <button className="stop small" onClick={() => api(stopUrl).catch(() => {})}><Icon name="stop" /> Stop</button>}
    </div>
  );
}
