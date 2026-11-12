import type { NextConfig } from "next";

// The Flask backend (backend/app.py) serves the API. The browser only talks to Next.js: /api/* is forwarded to
// Flask, so the login cookie stays on one origin.
const API_URL = process.env.API_URL || "http://127.0.0.1:5100";

const nextConfig: NextConfig = {
  // the Docker image sets NEXT_OUTPUT=standalone (a small self-contained server); `npm start` uses the normal build
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
  // audio uploads (up to 1 GB) and speech recognition go through the proxy
  experimental: { proxyClientMaxBodySize: "1gb", proxyTimeout: 10 * 60 * 1000 },
  // `npm run dev` opened as http://127.0.0.1:3000 (not only localhost); more hosts: DEV_ORIGINS=host1,host2
  allowedDevOrigins: ["127.0.0.1", ...(process.env.DEV_ORIGINS || "").split(",").filter(Boolean)],
  agentRules: false,   // do not write AGENTS.md into the project
};

export default nextConfig;
