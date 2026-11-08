import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@outrun/core"],
  serverExternalPackages: ["pg-boss", "pg"],
  poweredByHeader: false,
  // CI runs ESLint on the whole repo; the build shouldn't repeat it.
  eslint: { ignoreDuringBuilds: true },
  // The home page is the team's static site (public/site, from user_acquisition/landing_page),
  // with a "Live stats" button to /ops. The domain scan that used to be home is at /scan.
  async rewrites() {
    return { beforeFiles: [{ source: "/", destination: "/site/index.html" }], afterFiles: [], fallback: [] };
  },
};

export default nextConfig;
