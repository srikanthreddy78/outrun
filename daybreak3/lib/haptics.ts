// Haptic feedback layer — the tactile companion to lib/audio.ts.
//
// This template is web-only, so these are intentionally no-ops. The exports are
// kept so call sites stay unchanged; wire them to a native haptics API
// (e.g. navigator.vibrate or a native wrapper) if you ship a native build.

// A light tap — routine step advance, toggles, ordinary buttons.
export function hapticLight(): void {}

// A settled "success" pattern — routine completion, finished timers.
export function hapticSuccess(): void {}
