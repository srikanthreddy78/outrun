/**
 * Builds the studio app into `dist/` for `deploy_dir`: the server as one function at
 * `dist/api/app.js`, the host's rewrites in `dist/vercel.json`, and `dist/package.json` for `pg`.
 */
import { build } from "esbuild";
import { Buffer } from "node:buffer";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

/** A ustar .tgz of `folder`, written here so the archive is identical on every machine. */
function tgz(folder) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== "node_modules" && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const blocks = walk(folder).flatMap((file) => {
    const name = relative(dirname(folder), file).split(sep).join("/");
    const data = readFileSync(file);
    const header = Buffer.alloc(512);
    const field = (text, at) => header.write(text, at, "latin1");
    field(name, 0);
    field("0000755\0", 100);
    field("0000000\0", 108);
    field("0000000\0", 116);
    field(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    field(`${(1767225600).toString(8).padStart(11, "0")}\0`, 136);
    field("        ", 148);
    field("0", 156);
    field("ustar\0" + "00", 257);
    const sum = header.reduce((a, b) => a + b, 0);
    field(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

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
      functions: { "api/app.js": { maxDuration: 60 } },
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
// Static, served at /video-kit.tgz: none of the rewrites above match it.
writeFileSync(join(dist, "video-kit.tgz"), tgz(join(root, "video-kit")));
process.stdout.write("dist/api/app.js, dist/vercel.json, dist/package.json, dist/video-kit.tgz\n");
