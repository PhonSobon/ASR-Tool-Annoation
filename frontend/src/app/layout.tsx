import type { Metadata } from "next";
import type { ReactNode } from "react";
import { IconSprite } from "@/components/Icon";
import { NotifyProvider } from "@/components/notify";
import { THEME_SCRIPT } from "@/components/theme";
import "./globals.css";

export const metadata: Metadata = { title: "Data Annotation Platform" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-theme is set by THEME_SCRIPT before React starts, so the server's HTML differs from it on purpose
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+Khmer:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body>
        <IconSprite />
        <NotifyProvider>{children}</NotifyProvider>
      </body>
    </html>
  );
}
