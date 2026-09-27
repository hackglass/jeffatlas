import type { NextConfig } from "next";

// GitHub Pages serves project sites from a subpath (e.g. /jeffatlas).
// The deploy workflow sets PAGES_BASE_PATH from actions/configure-pages;
// it is empty during local development. The same value is exposed to the
// browser so fetches of /data/*.json work under the subpath.
const basePath = process.env.PAGES_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  images: { unoptimized: true },
};

export default nextConfig;
