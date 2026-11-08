/* global document, window, Image, fetch, createImageBitmap, getComputedStyle */

// Deterministic stage: window.seek(t) draws one exact frame at 1080x1920. Nothing reads the wall
// clock, so the same beats file always renders the same video.

const W = 1080;
const H = 1920;
const FPS = 30;
const CROSSFADE = 0.28;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

const app = document.getElementById("app");
const bg = document.getElementById("bg");
const bloom = document.getElementById("bloom");
const capEl = document.getElementById("cap");
const scenesEl = document.getElementById("scenes");
let timeline = [];
let TOTAL = 0;
const glows = [];

function node(cls, html = "", at, fx = "rise", d = 0.6) {
  const e = document.createElement("div");
  e.className = cls;
  e.innerHTML = html;
  if (at !== undefined) {
    e.dataset.at = at;
    e.dataset.fx = fx;
    e.dataset.d = d;
  }
  return e;
}

function applyFx(e, p, fx) {
  const s = e.style;
  if (fx === "fade") s.opacity = p;
  if (fx === "rise") {
    s.opacity = p;
    s.transform = `translateY(${(1 - p) * 42}px)`;
  }
  if (fx === "line") s.transform = `translateY(${(1 - p) * 116}%)`;
  if (fx === "scale") {
    s.opacity = p;
    s.transform = `scale(${lerp(0.92, 1, p)})`;
  }
}

function hexRgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
const luminance = (hex) => {
  const [r, g, b] = hexRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};
const rgba = (hex, a) => `rgba(${hexRgb(hex).join(", ")}, ${a})`;

function applyBrand(brand) {
  const p = brand.palette;
  const root = document.documentElement.style;
  const stops = p.bg.length === 1 ? [p.bg[0], p.bg[0]] : p.bg;
  root.setProperty("--bg", `linear-gradient(180deg, ${stops.join(", ")})`);
  root.setProperty("--fg", p.fg);
  root.setProperty("--accent", p.accent);
  root.setProperty("--on-accent", luminance(p.accent) > 0.55 ? "#141210" : "#ffffff");
  root.setProperty("--card", p.card || "#ffffff");
  root.setProperty("--glow", p.glow || "#ffffff");
  root.setProperty("--cap-bg", rgba(luminance(p.fg) < 0.45 ? p.fg : "#141210", 0.84));
  root.setProperty("--cap-fg", luminance(p.fg) < 0.45 ? "#ffffff" : p.fg);
  root.setProperty("--scrim", rgba(luminance(p.fg) < 0.45 ? p.fg : "#141210", 0.26));
  const f = brand.fonts;
  root.setProperty("--display", `"${f.display}", ${f.displaySerif ? "serif" : "sans-serif"}`);
  root.setProperty("--body", `"${f.body}", sans-serif`);
  root.setProperty("--display-weight", String(f.displayWeight));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => (i.decode ? i.decode().catch(() => {}) : Promise.resolve()).then(() => resolve(i));
    i.onerror = () => reject(new Error(`Could not load ${src}`));
    i.src = src;
  });
}

// Camera keys are [f, cx, cy, zoom]: f is 0 to 1 through the scene, cx and cy the image point to centre.
function cameraAt(keys, f) {
  if (f <= keys[0][0]) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    if (f <= keys[i][0]) {
      const a = keys[i - 1];
      const b = keys[i];
      const u = easeInOut((f - a[0]) / (b[0] - a[0] || 1));
      return [f, lerp(a[1], b[1], u), lerp(a[2], b[2], u), lerp(a[3], b[3], u)];
    }
  }
  return keys[keys.length - 1];
}

function coverCam(cw, ch, iw, ih, cx, cy, z) {
  const s = Math.max(cw / iw, ch / ih) * z;
  const tx = Math.min(0, Math.max(cw - iw * s, cw / 2 - cx * iw * s));
  const ty = Math.min(0, Math.max(ch - ih * s, ch / 2 - cy * ih * s));
  return { s, tx, ty };
}

// A screen image in a viewport of cw x ch, moved by the camera. Returns (lt, dur) => draw.
function shotLayer(parent, img, b, cw, ch, originX, originY) {
  img.className = "shot-img";
  parent.appendChild(img);
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  img.style.width = `${iw}px`;
  img.style.height = `${ih}px`;
  const keys = b.cam || [
    [0, 0.5, 0.5, 1],
    [1, 0.5, 0.5, 1.12],
  ];
  const callouts = (b.callouts || []).map((c) => {
    const hl = node("hl");
    const label = node("callout-label", esc(c.text));
    parent.append(hl, label);
    return { c, hl, label };
  });
  const taps = (b.taps || []).map(([f, x, y]) => {
    const t = node("tap");
    parent.appendChild(t);
    return { f, x, y, t };
  });
  return (lt, dur) => {
    const f = clamp(lt / dur);
    const [, cx, cy, z] = cameraAt(keys, f);
    const { s, tx, ty } = coverCam(cw, ch, iw, ih, cx, cy, z);
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    for (const { c, hl, label } of callouts) {
      const start = c.at ?? 0.4;
      const end = c.until ?? dur - 0.15;
      const on = clamp((lt - start) * 7) * clamp((end - lt) * 7);
      hl.style.opacity = on;
      label.style.opacity = on;
      if (on <= 0 || !c.box) continue;
      const [x0, y0, x1, y1] = c.box;
      const left = tx + x0 * iw * s;
      const top = ty + y0 * ih * s;
      const width = (x1 - x0) * iw * s;
      const height = (y1 - y0) * ih * s;
      hl.style.left = `${left}px`;
      hl.style.top = `${top}px`;
      hl.style.width = `${width}px`;
      hl.style.height = `${height}px`;
      const labelH = label.offsetHeight;
      const labelW = label.offsetWidth;
      const below = top + height + 26 + labelH <= Math.min(1360, ch) - originY;
      const anchored = below ? top + height + 26 : top - 26 - labelH;
      const y = clamp(c.place === "low" ? 1240 - originY : anchored, 120 - originY, 1360 - originY - labelH);
      const x = clamp(left + width / 2 - labelW / 2, 40 - originX, W - 40 - originX - labelW);
      label.style.transform = `translate(${x - 60}px, ${y + (1 - on) * 24}px)`;
    }
    for (const { f: tf, x, y, t } of taps) {
      const p = (f - tf) / (0.65 / dur);
      t.style.opacity = p >= 0 && p <= 1 ? 1 - p : 0;
      if (p >= 0 && p <= 1) {
        t.style.transform = `translate(${tx + x * iw * s}px, ${ty + y * ih * s}px) scale(${lerp(0.6, 1.9, easeOut(p))})`;
      }
    }
  };
}

const SCENES = {
  hook(s, b) {
    // The hook has to be readable from the very first frame, so its reveals start before the scene.
    addTitle(s, b.lines, { at: (i) => -0.8 + i * 0.2, center: b.center, italic: b.italic });
    if (b.sub) s.title.appendChild(node("title-sub", esc(b.sub), 0.1, "rise", 0.55));
    const box = s.title;
    s.ticks.push((lt, dur) => {
      box.style.transform = `scale(${1 + clamp(lt / dur) * 0.035})`;
    });
  },
  cta(s, b) {
    const box = node("title-box center");
    const name = b.name || s.brand.name;
    const nameLines = addTitle(s, [name], { at: () => 0.05, center: true, box, max: 220, accentLast: false });
    if (b.lines && b.lines.length) {
      box.appendChild(node("title-sub", esc(b.lines.join(" ")), 0.45, "rise", 0.6));
    }
    const pill = node("url-pill", esc(s.brand.displayUrl), 0.75, "scale", 0.5);
    box.appendChild(pill);
    s.el.appendChild(box);
    s.fit = () => {
      fitTitle(nameLines, 936, 220);
      const fontSize = parseFloat(getComputedStyle(pill).fontSize);
      const inner = pill.getBoundingClientRect().width - 96;
      if (inner > 840) pill.style.fontSize = `${Math.floor((fontSize * 840) / inner)}px`;
    };
  },
  walkthrough(s, b, assets) {
    addShot(s, b, assets[b.img]);
  },
  callout(s, b, assets) {
    addShot(s, b, assets[b.img]);
  },
  poster(s, b, assets) {
    const img = assets[b.img];
    img.className = "poster";
    s.el.appendChild(img);
    s.ticks.push((lt, dur) => {
      const e = easeOut(clamp(lt / 0.8));
      const u = clamp(lt / dur);
      img.style.opacity = e;
      img.style.transform = `perspective(1800px) rotateY(${lerp(-18, -5, e) + u * 8}deg) rotateX(${lerp(7, 2, e)}deg) scale(${lerp(0.88, 1, e) + u * 0.04})`;
    });
  },
  clip(s, b) {
    const c = document.createElement("canvas");
    c.className = "clip-canvas";
    c.width = 1080;
    c.height = 1920;
    s.el.appendChild(c);
    s.full = true;
    s.clip = { c, dir: b.clipDir, last: -1, frames: Math.max(1, b.clipFrames) };
  },
};

function addShot(s, b, img) {
  const portrait = img.naturalWidth / img.naturalHeight <= 0.7;
  const full = b.frame ? b.frame === "full" : portrait;
  s.full = full;
  if (full) {
    const v = node("viewport");
    s.el.appendChild(v);
    s.ticks.push(shotLayer(v, img, b, W, H, 0, 0));
    return;
  }
  const f = node("inset");
  const v = node("viewport");
  f.appendChild(v);
  s.el.appendChild(f);
  s.ticks.push(shotLayer(v, img, b, 964, 1104, 58, 188));
}

function addTitle(s, lines, opts) {
  const box = opts.box || node(`title-box${opts.center ? " center" : ""}`);
  const spans = [];
  lines.forEach((text, i) => {
    const mask = node("mask");
    const line = node("title-line", esc(text), opts.at(i), "line", 0.75);
    if (opts.italic && i === lines.length - 1) line.classList.add("italic");
    if (opts.accentLast !== false && lines.length > 1 && i === lines.length - 1) line.classList.add("accent");
    mask.appendChild(line);
    box.appendChild(mask);
    spans.push(line);
  });
  if (!opts.box) s.el.appendChild(box);
  s.title = box;
  s.titleLines = spans;
  if (!opts.box) s.fit = () => fitTitle(spans, 936, opts.max || 180);
  return spans;
}

function fitTitle(spans, maxWidth, maxSize) {
  let size = maxSize;
  for (const sp of spans) {
    sp.style.fontSize = `${maxSize}px`;
    size = Math.min(size, (maxSize * maxWidth) / Math.max(1, sp.getBoundingClientRect().width));
  }
  for (const sp of spans) sp.style.fontSize = `${Math.floor(size)}px`;
}

// Splits caption text into short phrases, timed in proportion to their length.
function chunks(text) {
  const MAX = 42;
  const out = [];
  let cur = "";
  for (const word of String(text).trim().split(/\s+/)) {
    const next = `${cur} ${word}`.trim();
    if (next.length > MAX && cur) {
      out.push(cur);
      cur = word;
    } else {
      cur = next;
      if (/[.?!,:;]$/.test(word) && cur.length > 18) {
        out.push(cur);
        cur = "";
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

function buildScene(b, brand, assets) {
  const el = node(`scene s-${b.scene}`);
  el.style.display = "none";
  scenesEl.appendChild(el);
  const s = { b, el, start: b.start, dur: b.dur, ticks: [], brand, full: false, fit: null, anim: [] };
  SCENES[b.scene](s, b, assets);
  s.anim = [...el.querySelectorAll("[data-at]")];
  s.caps = b.caption ? chunks(b.caption) : [];
  const total = s.caps.reduce((a, x) => a + x.length, 0) || 1;
  let acc = 0;
  s.capTimes = s.caps.map((x) => {
    const r = [acc / total, (acc + x.length) / total];
    acc += x.length;
    return r;
  });
  s.capStart = b.voiceStart ?? 0.15;
  s.capEnd = b.voiceEnd ?? Math.max(s.capStart + 0.5, b.dur - 0.2);
  return s;
}

async function initStage(spec) {
  document.documentElement.setAttribute("lang", "en");
  applyBrand(spec.brand);
  const fontWarnings = await loadFonts(spec.fonts);
  for (let i = 0; i < 2; i++) {
    const g = node("glow");
    bg.appendChild(g);
    glows.push(g);
  }
  // Decode every image up front so a seek never waits or shows a half-loaded screen.
  const srcs = [...new Set(spec.beats.flatMap((b) => (b.img ? [b.img] : [])))];
  const assets = Object.fromEntries(
    await Promise.all(srcs.map(async (s) => [s, await loadImage(spec.assetUrls[s])])),
  );
  // An image used twice needs its own element.
  const seen = new Set();
  const scoped = (b) => {
    if (!b.img) return assets;
    if (seen.has(b.img)) return { ...assets, [b.img]: assets[b.img].cloneNode() };
    seen.add(b.img);
    return assets;
  };
  timeline = spec.beats.map((b) => buildScene(b, spec.brand, scoped(b)));
  TOTAL = spec.total;
  // Sizes can only be measured while a scene is laid out.
  for (const s of timeline) {
    if (!s.fit) continue;
    s.el.style.display = "block";
    s.fit();
    s.el.style.display = "none";
  }
  await document.fonts.ready;
  return { total: TOTAL, fontWarnings };
}

async function loadFonts(fonts) {
  const warnings = [];
  await Promise.all(
    fonts.urls.map(
      (href) =>
        new Promise((resolve) => {
          const l = document.createElement("link");
          l.rel = "stylesheet";
          l.href = href;
          l.onload = l.onerror = resolve;
          document.head.appendChild(l);
        }),
    ),
  );
  // Loading each weight by name is what stops weights from rendering as blank text.
  await Promise.all(fonts.faces.map((face) => document.fonts.load(face, "Abc 123 #$%&").catch(() => [])));
  await document.fonts.ready;
  for (const face of fonts.faces) if (!document.fonts.check(face, "Abc")) warnings.push(face);
  return warnings;
}

async function drawClip(clip, lt) {
  const i = Math.min(clip.frames, Math.max(1, Math.floor(lt * FPS) + 1));
  if (clip.last === i) return;
  clip.last = i;
  const r = await fetch(`/frames/${clip.dir}/${String(i).padStart(4, "0")}.jpg`);
  const bm = await createImageBitmap(await r.blob());
  clip.c.getContext("2d").drawImage(bm, 0, 0, 1080, 1920);
  bm.close();
}

function drawCaption(s, lt) {
  let text = "";
  let p = 0;
  if (s.caps.length) {
    const f = (lt - s.capStart) / (s.capEnd - s.capStart);
    s.capTimes.forEach((r, i) => {
      if (f >= r[0] && f < r[1] + 0.02) {
        text = s.caps[i];
        p = easeOut(clamp((f - r[0]) * (s.capEnd - s.capStart) * 6));
      }
    });
  }
  if (capEl.textContent !== text) capEl.textContent = text;
  capEl.style.opacity = text ? p : 0;
  capEl.style.transform = `translateY(${(1 - p) * 16}px)`;
}

async function seek(t) {
  let main = null;
  let bgNeeded = false;
  let flash = 0;
  for (let i = 0; i < timeline.length; i++) {
    const s = timeline[i];
    const lt = t - s.start;
    const within = lt >= 0 && lt < s.dur;
    // The previous scene stays underneath while the next one fades in.
    const on = within || (lt >= s.dur && lt < s.dur + CROSSFADE);
    s.el.style.display = on ? "block" : "none";
    if (!on) continue;
    if (!s.full) bgNeeded = true;
    if (within) main = s;
    s.el.style.opacity = i === 0 ? 1 : easeInOut(clamp(lt / CROSSFADE));
    if (i > 0 && lt < CROSSFADE) flash = Math.max(flash, 0.22 * (1 - Math.abs(lt / CROSSFADE - 0.5) * 2));
    for (const e of s.anim) {
      applyFx(e, easeOut(clamp((lt - Number(e.dataset.at)) / Number(e.dataset.d))), e.dataset.fx);
    }
    for (const f of s.ticks) f(lt, s.dur);
    if (s.clip) await drawClip(s.clip, lt);
  }
  bg.style.display = bgNeeded ? "block" : "none";
  if (bgNeeded) {
    glows.forEach((g, i) => {
      const a = t * 0.2 + i * 2.1;
      g.style.transform = `translate(${Math.sin(a) * 120 + (i ? 200 : -80)}px, ${Math.cos(a) * 100 + (i ? 500 : -60)}px)`;
    });
  }
  bloom.style.opacity = flash;
  if (main) drawCaption(main, t - main.start);
  else capEl.style.opacity = 0;
  return true;
}

window.initStage = initStage;
window.seek = seek;
app.dataset.ready = "1";
