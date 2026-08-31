import type { NextConfig } from "next";

const isStatic = process.env.NEXT_PUBLIC_STATIC === "true";

const nextConfig: NextConfig = {
  output: isStatic ? "export" : "standalone",
  // GitHub Pages serves from /psyboss/ subpath
  basePath: isStatic ? "/psyboss" : "",
  assetPrefix: isStatic ? "/psyboss/" : "",
  images: { unoptimized: true },
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: false,
};

export default nextConfig;
