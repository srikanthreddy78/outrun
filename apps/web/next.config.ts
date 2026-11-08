import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@outrun/core"],
  serverExternalPackages: ["pg-boss", "pg"],
  poweredByHeader: false,
  // CI runs ESLint on the whole repo; the build shouldn't repeat it.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
