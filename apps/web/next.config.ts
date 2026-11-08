import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@outrun/core"],
  serverExternalPackages: ["pg-boss", "pg"],
  poweredByHeader: false,
};

export default nextConfig;
