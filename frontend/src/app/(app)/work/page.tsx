"use client";
// The Work Dashboard is now the Team tab of the Dashboard; old links and bookmarks go there.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function WorkPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/dashboard?tab=team"); }, [router]);
  return <div className="boot muted">Loading…</div>;
}
