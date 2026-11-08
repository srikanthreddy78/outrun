import { storage } from "@/lib/storage";

// Daybreak's sound language: "barely-there air" — every cue is a soft band of
// filtered noise (breath/texture more than pitch) with a gentle attack, a long
// decay, and a touch of reverb for space. Deliberately subliminal so the app
// stays calm. All cues are gated by the `soundEnabled` setting.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let reverb: ConvolverNode | null = null;

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      ctx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.7;
      master.connect(ctx.destination);

      // Algorithmic reverb (decaying-noise impulse) for a sense of air/space.
      const len = Math.floor(ctx.sampleRate * 2.2);
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
      reverb = ctx.createConvolver();
      reverb.buffer = buf;
      const wet = ctx.createGain();
      wet.gain.value = 0.2;
      reverb.connect(wet);
      wet.connect(master);
    } catch {
      return null;
    }
  }
  // Browsers suspend the context until a user gesture; resume on first cue.
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function noiseBuffer(c: AudioContext, dur: number): AudioBuffer {
  const n = Math.max(1, Math.floor(c.sampleRate * dur));
  const b = c.createBuffer(1, n, c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

// A soft pitched partial — pure sine, slow bloom attack, hard low-pass so it's
// round and warm with no bright edge. Used only for the big reward moment, which
// wants a warmer bell than the breathy air cues.
function partialSoft(freq: number, dur: number, vol: number, detune: number, filt: number, startAt = 0): void {
  const c = ensure();
  if (!c || !master || !reverb) return;
  const t = c.currentTime + startAt;
  const osc = c.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  osc.detune.value = detune;
  const f = c.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = filt;
  f.Q.value = 0.4;
  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(f);
  f.connect(g);
  g.connect(master);
  g.connect(reverb);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

// Warm round bell — low fundamental + quiet octave + a whisper of shimmer.
function softBell(freq: number, dur: number, vol: number, startAt = 0): void {
  partialSoft(freq, dur, vol, -2, 1400, startAt);
  partialSoft(freq * 2, dur * 0.8, vol * 0.26, 4, 1700, startAt);
  partialSoft(freq * 2.76, dur * 0.6, vol * 0.08, 0, 1900, startAt);
}

// One "air note" — a bandpass sweep over white noise, enveloped soft→gone.
function airNote(freq: number, dur: number, vol: number, startAt = 0): void {
  const c = ensure();
  if (!c || !master || !reverb) return;
  const t = c.currentTime + startAt;

  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, dur + 0.15);

  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = 7;
  f.frequency.setValueAtTime(freq * 2, t);
  f.frequency.exponentialRampToValueAtTime(freq * 3.1, t + dur);

  const g = c.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.09);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  src.connect(f);
  f.connect(g);
  g.connect(master);
  g.connect(reverb);
  src.start(t);
  src.stop(t + dur + 0.15);
}

function soundEnabled(): boolean {
  return storage.getSettings().soundEnabled ?? true;
}

// ─── Breathing ───────────────────────────────────────────────────────────────
export function playInhale(): void {
  if (!soundEnabled()) return;
  airNote(440, 0.85, 0.22);
}
export function playExhale(): void {
  if (!soundEnabled()) return;
  airNote(330, 0.95, 0.22);
}

// ─── Routine flow ────────────────────────────────────────────────────────────
export function playStep(): void {
  if (!soundEnabled()) return;
  airNote(528, 0.5, 0.24);
}
export function playTimerDone(): void {
  if (!soundEnabled()) return;
  airNote(660, 0.7, 0.26);
  airNote(528, 1.0, 0.22, 0.23);
}
export function playComplete(): void {
  if (!soundEnabled()) return;
  airNote(528, 0.9, 0.26);
  airNote(792, 1.5, 0.24, 0.26);
}

// ─── UI cues ──────────────────────────────────────────────────────────────────
export function playTap(): void {
  if (!soundEnabled()) return;
  airNote(600, 0.3, 0.16);
}
export function playToggle(): void {
  if (!soundEnabled()) return;
  airNote(520, 0.3, 0.18);
}
export function playConfirm(): void {
  if (!soundEnabled()) return;
  airNote(560, 0.55, 0.22);
  airNote(700, 0.8, 0.18, 0.14);
}
export function playNavigate(): void {
  if (!soundEnabled()) return;
  airNote(680, 0.28, 0.14);
}

// The one big moment — a soft, low rising third (a warm bell blooming upward)
// timed to land on the reveal's particle burst. Warmer than the air cues on
// purpose: this is the reward beat, not an ambient whisper.
export function playReveal(): void {
  if (!soundEnabled()) return;
  softBell(196, 2.6, 0.28);
  softBell(262, 2.8, 0.26, 0.55);
}
