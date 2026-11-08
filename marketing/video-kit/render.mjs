#!/usr/bin/env node
/* global window, fetch, AbortSignal */
/**
 * Renders a vertical short-form video from a beats file. See beats.example.json for the format.
 *
 *   node render.mjs beats.json out.mp4          full render, then a check of the result
 *   node render.mjs beats.json dir --stills     one preview still per scene, no encoding
 *
 * ffmpeg comes from the FFMPEG environment variable, or from PATH. The report is printed as JSON
 * on stdout; progress goes to stderr.
 */
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const KIT = dirname(fileURLToPath(import.meta.url));
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const W = 1080;
const H = 1920;
const FPS = 30;
const LEAD = 0.15;
const PAD = 0.35;
const TARGET_LUFS = -14;
const SCENE_DEFAULTS = { hook: 2.4, walkthrough: 3.4, callout: 3.8, poster: 3, clip: 3.4, cta: 3 };
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const log = (msg) => process.stderr.write(`${msg}\n`);
const round = (x, d = 2) => Number(x.toFixed(d));

function ffmpeg(args, { check = true } = {}) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-nostats", "-y", ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (r.error)
    throw new Error(`Could not run ${FFMPEG}: ${r.error.message}. Set FFMPEG or put ffmpeg on PATH.`);
  if (check && r.status !== 0) throw new Error(`ffmpeg failed:\n${r.stderr.slice(-1500)}`);
  return r.stderr;
}

// ffprobe is not available everywhere, so all probing goes through ffmpeg's own output.
function probe(file) {
  const text = ffmpeg(["-i", file], { check: false });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
  const video = /Stream .*Video: (\w+).*?, (\d{2,5})x(\d{2,5})[ ,].*?(?:([\d.]+) fps|([\d.]+) tbr)/.exec(
    text,
  );
  const audio = /Stream .*Audio: (\w+).*?(\d+) Hz, (\w+)/.exec(text);
  return {
    duration: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0,
    video: video && {
      codec: video[1],
      width: Number(video[2]),
      height: Number(video[3]),
      fps: Number(video[4] ?? video[5]),
    },
    audio: audio && { codec: audio[1], rate: Number(audio[2]), channels: audio[3] },
  };
}

function measureLoudness(file) {
  const text = ffmpeg(["-i", file, "-af", "ebur128=framelog=quiet:peak=true", "-f", "null", "-"]);
  const summary = text.slice(text.lastIndexOf("Summary"));
  const i = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
  const lra = /LRA:\s+([\d.]+) LU/.exec(summary);
  const peak = /Peak:\s+(-?[\d.]+) dBFS/.exec(summary);
  return {
    lufs: i ? Number(i[1]) : null,
    lra: lra ? Number(lra[1]) : null,
    truePeak: peak ? Number(peak[1]) : null,
  };
}

function readSpec(beatsPath) {
  const dir = dirname(beatsPath);
  const spec = JSON.parse(readFileSync(beatsPath, "utf8"));
  const assetsDir = resolve(dir, spec.assets ?? "assets");
  const errors = [];
  const fail = (msg) => errors.push(msg);
  const assetPath = (rel, where) => {
    if (typeof rel !== "string" || !rel) {
      fail(`${where}: missing file name`);
      return "";
    }
    const full = resolve(assetsDir, rel);
    if (!full.startsWith(assetsDir + sep) || !existsSync(full)) fail(`${where}: no such asset "${rel}"`);
    return full;
  };

  const brand = spec.brand ?? {};
  const palette = brand.palette ?? {};
  const fonts = brand.fonts ?? {};
  const hex = (v) => typeof v === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v);
  if (!brand.name) fail("brand.name is required");
  if (!brand.url) fail("brand.url is required");
  if (!Array.isArray(palette.bg) || !palette.bg.length || !palette.bg.every(hex)) {
    fail("brand.palette.bg must be a list of hex colours (top to bottom)");
  }
  for (const key of ["fg", "accent"])
    if (!hex(palette[key])) fail(`brand.palette.${key} must be a hex colour`);
  for (const key of ["card", "glow"]) {
    if (palette[key] !== undefined && !hex(palette[key])) fail(`brand.palette.${key} must be a hex colour`);
  }
  if (!fonts.display || !fonts.body) fail("brand.fonts.display and brand.fonts.body are required");

  const raw = Array.isArray(spec.beats) ? spec.beats : [];
  if (raw.length < 5 || raw.length > 7) fail(`beats: need 5 to 7 scenes, found ${raw.length}`);
  if (raw.length && raw[0].scene !== "hook") fail("beats: the first scene must be a hook");
  if (raw.length && raw[raw.length - 1].scene !== "cta") fail("beats: the last scene must be a cta");

  let start = 0;
  const beats = raw.map((beat, i) => {
    const where = `beat ${i + 1} (${beat.scene})`;
    if (!(beat.scene in SCENE_DEFAULTS)) fail(`${where}: unknown scene`);
    if (beat.scene === "hook" && !(Array.isArray(beat.lines) && beat.lines.length))
      fail(`${where}: needs lines`);
    if (beat.scene === "walkthrough" || beat.scene === "callout" || beat.scene === "poster") {
      assetPath(beat.img, where);
    }
    if (beat.scene === "callout" && !(Array.isArray(beat.callouts) && beat.callouts.length)) {
      fail(`${where}: needs callouts`);
    }
    if (beat.scene === "clip") assetPath(beat.clip, where);
    const voicePath = beat.voice ? assetPath(beat.voice, `${where} voice`) : null;
    const voiceSeconds = voicePath && existsSync(voicePath) ? probe(voicePath).duration : 0;
    const dur = Math.max(
      beat.dur ?? SCENE_DEFAULTS[beat.scene] ?? 3,
      beat.scene === "cta" ? 2.6 : 1.2,
      voiceSeconds ? LEAD + voiceSeconds + PAD : 0,
    );
    const item = {
      ...beat,
      id: beat.id || `${String(i + 1).padStart(2, "0")}-${beat.scene}`,
      start,
      dur,
      voicePath,
      voiceStart: voiceSeconds ? LEAD : undefined,
      voiceEnd: voiceSeconds ? LEAD + voiceSeconds : undefined,
    };
    start += dur;
    return item;
  });
  const total = start;
  const audio = spec.audio ?? {};
  const musicPath = audio.music ? assetPath(audio.music, "audio.music") : null;
  if (total > 60) fail(`total length ${round(total)}s is over the 60s limit`);
  if (errors.length) throw new Error(`Bad beats file:\n - ${errors.join("\n - ")}`);

  return { spec, brand, assetsDir, beats, total, audio, musicPath };
}

async function cssExists(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(8000) })).ok;
  } catch {
    return false;
  }
}

async function googleFont(family, weights, italics) {
  const base = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}`;
  const sorted = [...new Set(weights)].sort((a, b) => a - b);
  const slanted = [...new Set(italics)].sort((a, b) => a - b);
  // Google rejects a whole request if one variant doesn't exist, so step down until one works.
  if (slanted.length) {
    const pairs = [...sorted.map((w) => `0,${w}`), ...slanted.map((w) => `1,${w}`)].join(";");
    const url = `${base}:ital,wght@${pairs}&display=swap`;
    if (await cssExists(url)) return { url, weights: sorted, italics: slanted };
  }
  const upright = `${base}:wght@${sorted.join(";")}&display=swap`;
  if (await cssExists(upright)) return { url: upright, weights: sorted, italics: [] };
  const single = [];
  for (const w of sorted) if (await cssExists(`${base}:wght@${w}`)) single.push(w);
  if (single.length)
    return { url: `${base}:wght@${single.join(";")}&display=swap`, weights: single, italics: [] };
  if (await cssExists(`${base}&display=swap`))
    return { url: `${base}&display=swap`, weights: [400], italics: [] };
  return null;
}

async function resolveFonts(brand, beats) {
  const f = brand.fonts;
  const displayWeight = f.displayWeight ?? 700;
  const usesItalic = beats.some((b) => b.italic);
  const families = [
    { family: f.display, weights: [displayWeight, 400], italics: usesItalic ? [displayWeight] : [] },
    { family: f.body, weights: [400, 500, 600, 700], italics: [] },
  ];
  const urls = [];
  const faces = [];
  const warnings = [];
  for (const { family, weights, italics } of families) {
    const found = await googleFont(family, weights, italics);
    if (!found) {
      warnings.push(`Font "${family}" is not on Google Fonts or could not be fetched; using a fallback`);
      continue;
    }
    urls.push(found.url);
    for (const w of found.weights) faces.push(`${w} 40px "${family}"`);
    for (const w of found.italics) faces.push(`italic ${w} 40px "${family}"`);
  }
  return { urls: [...new Set(urls)], faces: [...new Set(faces)], warnings };
}

function serveStage(roots) {
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(req.url.split("?")[0]);
    const route = Object.keys(roots).find((p) => path === p || path.startsWith(p));
    const full = route ? resolve(roots[route], `.${path.slice(route.length - 1)}`) : "";
    if (!route || !full.startsWith(roots[route] + sep) || !existsSync(full) || statSync(full).isDirectory()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", MIME[extname(full).toLowerCase()] ?? "application/octet-stream");
    createReadStream(full).pipe(res);
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r(server));
  });
}

// Frames for each clip scene are written to a temp folder and read one at a time, so a clip of any
// length costs disk, not memory.
function extractClips(beats, assetsDir, tmp) {
  const framesDir = join(tmp, "frames");
  for (const b of beats) {
    if (b.scene !== "clip") continue;
    const dir = join(framesDir, b.id);
    mkdirSync(dir, { recursive: true });
    ffmpeg([
      "-ss",
      String(b.clipStart ?? 0),
      "-i",
      resolve(assetsDir, b.clip),
      "-t",
      String(b.dur),
      "-vf",
      `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
      "-q:v",
      "4",
      join(dir, "%04d.jpg"),
    ]);
    b.clipDir = b.id;
    b.clipFrames = readdirSync(dir).length;
    if (!b.clipFrames) throw new Error(`Clip ${b.clip} produced no frames`);
  }
  return framesDir;
}

async function openStage(port, spec) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--renderer-process-limit=1",
      "--disable-extensions",
      "--js-flags=--max-old-space-size=192",
    ],
  });
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  let pageError = null;
  page.on("pageerror", (e) => {
    pageError = e;
  });
  await page.goto(`http://127.0.0.1:${port}/stage/index.html`, { waitUntil: "load" });
  const info = await page.evaluate((s) => window.initStage(s), spec);
  if (pageError) throw pageError;
  const cdp = await context.newCDPSession(page);
  const shot = async (t) => {
    await page.evaluate((x) => window.seek(x), t);
    if (pageError) throw pageError;
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 90,
      optimizeForSpeed: true,
    });
    return Buffer.from(data, "base64");
  };
  return { browser, shot, info };
}

async function encodeFrames(shot, total, silentPath) {
  const frames = Math.ceil(total * FPS);
  const ff = spawn(
    FFMPEG,
    [
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "error",
      "-y",
      "-threads",
      "1",
      "-filter_threads",
      "1",
      "-f",
      "image2pipe",
      "-framerate",
      String(FPS),
      "-c:v",
      "mjpeg",
      "-i",
      "-",
      "-vf",
      "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-threads",
      "1",
      "-rc-lookahead",
      "10",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_range",
      "tv",
      "-r",
      String(FPS),
      silentPath,
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  let ffError = null;
  const closed = new Promise((res) => {
    ff.on("error", (e) => {
      ffError = e;
      res();
    });
    ff.on("close", (code) => {
      if (code !== 0) ffError = new Error(`ffmpeg exited with code ${code}`);
      res();
    });
  });
  ff.stdin.on("error", () => {});
  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    if (ffError) throw ffError;
    const data = await shot(i / FPS);
    if (!ff.stdin.write(data)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % 90 === 0) log(`frame ${i}/${frames} (${Math.round((Date.now() - started) / 1000)}s)`);
  }
  ff.stdin.end();
  await closed;
  if (ffError) throw ffError;
  return frames;
}

// Lays each beat's voice on a looped music bed, ducks the bed under the voice, and hits -14 LUFS.
function mixAudio({ beats, total, musicPath, audio, tmp }) {
  const voices = beats.filter((b) => b.voicePath);
  if (!voices.length && !musicPath) return null;
  const T = round(total, 3);
  const inputs = [];
  const parts = [];
  let n = 0;
  const stereo = "aresample=48000,aformat=channel_layouts=stereo";

  if (voices.length) {
    const labels = [];
    for (const b of voices) {
      inputs.push("-i", b.voicePath);
      parts.push(`[${n}:a]${stereo},adelay=${Math.round((b.start + LEAD) * 1000)}:all=1[v${n}]`);
      labels.push(`[v${n}]`);
      n++;
    }
    // The voice track must run the full length, or the sidechain cuts the music when it ends.
    parts.push(
      `${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,apad=whole_dur=${T},atrim=0:${T},${musicPath ? "asplit=2[vo][key]" : "anull[vo]"}`,
    );
  }
  if (musicPath) {
    inputs.push("-stream_loop", "-1", "-i", musicPath);
    const vol = audio.musicVolume ?? (voices.length ? 0.42 : 1);
    const fadeAt = Math.max(0, T - 1.4);
    parts.push(
      `[${n}:a]${stereo},atrim=0:${T},asetpts=N/SR/TB,volume=${vol},afade=t=in:d=0.25,afade=t=out:st=${fadeAt}:d=1.4[bed]`,
    );
    n++;
  }
  if (voices.length && musicPath) {
    parts.push("[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=380[ducked]");
    parts.push("[vo][ducked]amix=inputs=2:normalize=0:dropout_transition=0[sum]");
  } else if (voices.length) {
    parts.push("[vo]anull[sum]");
  } else {
    parts.push("[bed]anull[sum]");
  }
  parts.push(`[sum]loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11,aresample=48000[out]`);

  const wav = join(tmp, "mix.wav");
  ffmpeg([
    ...inputs,
    "-filter_complex",
    parts.join(";"),
    "-map",
    "[out]",
    "-c:a",
    "pcm_s16le",
    "-t",
    String(T),
    wav,
  ]);

  // loudnorm's first-pass output can land a little off on short clips; nudge it onto the target.
  const measured = measureLoudness(wav);
  if (measured.lufs !== null && Math.abs(measured.lufs - TARGET_LUFS) > 0.5) {
    const adjusted = join(tmp, "mix2.wav");
    const gain = round(TARGET_LUFS - measured.lufs);
    ffmpeg([
      "-i",
      wav,
      "-af",
      `volume=${gain}dB,alimiter=limit=0.84:level=false`,
      "-c:a",
      "pcm_s16le",
      adjusted,
    ]);
    return adjusted;
  }
  return wav;
}

function mux(silentPath, wav, total, outPath) {
  const audioIn = wav
    ? ["-i", wav]
    : ["-f", "lavfi", "-t", String(total), "-i", "anullsrc=r=48000:cl=stereo"];
  ffmpeg([
    "-i",
    silentPath,
    ...audioIn,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    String(total),
    "-movflags",
    "+faststart",
    outPath,
  ]);
}

function extractCheckFrames(outPath, beats) {
  const dir = outPath.replace(/\.mp4$/i, "") + "-frames";
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return beats.map((b) => {
    const t = b.start + b.dur * 0.72;
    const file = join(dir, `${b.id}.jpg`);
    ffmpeg(["-ss", String(t), "-i", outPath, "-frames:v", "1", "-q:v", "3", "-vf", "scale=720:-2", file]);
    return file;
  });
}

async function main() {
  const [beatsArg, outArg, ...rest] = process.argv.slice(2);
  const stills = rest.includes("--stills");
  if (!beatsArg || !outArg) {
    throw new Error(
      "Usage: node render.mjs <beats.json> <out.mp4> | node render.mjs <beats.json> <dir> --stills",
    );
  }
  const started = Date.now();
  const beatsPath = resolve(beatsArg);
  const outPath = resolve(outArg);
  const { brand, assetsDir, beats, total, audio, musicPath } = readSpec(beatsPath);
  const tmp = mkdtempSync(join(tmpdir(), "video-kit-"));
  let server;
  let browser;
  try {
    const framesDir = extractClips(beats, assetsDir, tmp);
    server = await serveStage({
      "/stage/": join(KIT, "stage"),
      "/assets/": assetsDir,
      "/frames/": framesDir,
    });
    const fonts = await resolveFonts(brand, beats);
    const assetUrls = Object.fromEntries(
      beats.filter((b) => b.img).map((b) => [b.img, `/assets/${encodeURI(b.img)}`]),
    );
    const stage = await openStage(server.address().port, {
      brand: {
        ...brand,
        displayUrl: String(brand.url)
          .replace(/^https?:\/\//, "")
          .replace(/\/$/, ""),
        fonts: { ...brand.fonts, displayWeight: brand.fonts.displayWeight ?? 700 },
      },
      beats: beats.map((b) => ({ ...b, voicePath: undefined })),
      total,
      assetUrls,
      fonts,
    });
    browser = stage.browser;
    const warnings = [
      ...fonts.warnings,
      ...stage.info.fontWarnings.map((f) => `Font face did not load: ${f}`),
    ];
    if (total > 30) warnings.push(`Length ${round(total)}s is over the 30s target`);
    if (!beats.some((b) => b.voicePath) && !musicPath)
      warnings.push("No voice or music in the beats file: silent audio");
    const scenes = beats.map((b) => ({ id: b.id, scene: b.scene, start: round(b.start), dur: round(b.dur) }));

    if (stills) {
      mkdirSync(outPath, { recursive: true });
      const files = [];
      for (const b of beats) {
        const file = join(outPath, `${b.id}.jpg`);
        writeFileSync(file, await stage.shot(b.start + b.dur * 0.72));
        files.push(file);
      }
      process.stdout.write(
        `${JSON.stringify({ stills: files, total: round(total), scenes, warnings }, null, 2)}\n`,
      );
      return;
    }

    mkdirSync(dirname(outPath), { recursive: true });
    const silentPath = join(tmp, "video.mp4");
    const frames = await encodeFrames(stage.shot, total, silentPath);
    await browser.close();
    browser = null;
    log("mixing audio");
    const wav = mixAudio({ beats, total, musicPath, audio, tmp });
    mux(silentPath, wav, total, outPath);
    const info = probe(outPath);
    const loudness = wav ? measureLoudness(outPath) : null;
    if (loudness && loudness.lufs !== null && Math.abs(loudness.lufs - TARGET_LUFS) > 1) {
      warnings.push(`Loudness ${loudness.lufs} LUFS is more than 1 LU from ${TARGET_LUFS}`);
    }
    const checkFrames = extractCheckFrames(outPath, beats);
    const report = {
      out: outPath,
      seconds: round(info.duration),
      sizeMB: round(statSync(outPath).size / 1e6),
      frames,
      video: info.video,
      audio: info.audio,
      loudness,
      renderSeconds: Math.round((Date.now() - started) / 1000),
      checkFrames,
      scenes,
      warnings,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  log(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
