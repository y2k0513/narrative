import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep pdfjs-dist as a real Node dependency on server routes.
  // This prevents Next/Turbopack from relocating pdf.mjs without its worker.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
};

export default nextConfig;
