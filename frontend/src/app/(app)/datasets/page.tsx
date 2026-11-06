"use client";
// Dataset Cleaning was merged into Load Data: Hugging Face datasets and local folders are loaded into tasks there.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function DatasetsMoved() {
  const router = useRouter();
  useEffect(() => { router.replace("/upload"); }, [router]);
  return <div className="boot muted">Datasets are loaded in Load Data now…</div>;
}
