"use client";
// Every page behind the login: the user is loaded first (else /login), then the shell around the page.
import type { ReactNode } from "react";
import { SessionProvider } from "@/components/session";
import { Shell } from "@/components/Shell";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
