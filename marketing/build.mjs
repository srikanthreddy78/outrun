/**
 * Builds the studio app into `dist/` for `deploy_dir`: the server as one function at
 * `dist/api/app.js`, the host's rewrites in `dist/vercel.json`, and `dist/package.json` for `pg`.
 */
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "api"), { recursive: true });

await build({
  entryPoints: [join(root, "app", "main.ts")],
  outfile: join(dist, "api", "app.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["pg"],
});

const app = (path) => `/api/app?__path=${path}`;
writeFileSync(
  join(dist, "vercel.json"),
  `${JSON.stringify(
    {
      rewrites: [
        { source: "/mcp", destination: app("/mcp") },
        { source: "/api/enter", destination: app("/api/enter") },
        { source: "/api/health", destination: app("/api/health") },
        { source: "/c/:id", destination: app("/c/:id") },
        { source: "/", destination: app("/") },
      ],
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(dist, "package.json"),
  `${JSON.stringify({ name: "outrun-studio", private: true, type: "module", dependencies: { pg: "^8.16.3" } }, null, 2)}\n`,
);
process.stdout.write("dist/api/app.js, dist/vercel.json, dist/package.json\n");
