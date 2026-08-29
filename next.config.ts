import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["58.145.57.186"],

  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;