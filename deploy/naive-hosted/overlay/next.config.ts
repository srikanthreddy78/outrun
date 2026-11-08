import type { NextConfig } from "next";

/**
 * The Naive-hosted build's Next config (deploy/naive-hosted). @outrun/core and @outrun/worker are
 * vendored into the app and resolved through tsconfig paths, so they compile as app source.
 * Typecheck and lint are skipped here because CI already runs both on the repo.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg-boss", "pg"],
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  // The admin route applies the Drizzle migrations at runtime, so ship the SQL with it.
  outputFileTracingIncludes: { "/api/hosted/admin": ["./vendor/core/drizzle/**/*"] },
};

export default nextConfig;
