@AGENTS.md

# Daybreak

A calm, minimal morning routine PWA. No backend — all state lives in a single localStorage key (`"daybreak"`). Next.js 16 App Router, React 19, Tailwind v4, Framer Motion v12.

## Commands

```bash
npm run dev       # dev server
npm run build     # production build
npx tsc --noEmit  # type-check (use this to verify changes — no test suite)
npm run lint      # eslint
```

**Always run `npx tsc --noEmit` after changes.** There are no automated tests — type checking is the primary correctness signal.

## Architecture

### Storage
Single `localStorage` key `"daybreak"` via `lib/storage.ts`. All reads/writes go through the `storage` object — never touch `localStorage` directly. The `read()` function in storage.ts handles migrations for breaking schema changes; add new migrations there.

Key date type: `DayKey = string` (ISO date, e.g. `"2026-05-22"`) from `getTodayKey()` in `lib/time.ts`. Daily entries (intentions, gratitude, journal) are keyed by DayKey and reset naturally each new day.

### Routing / Modes
`app/page.tsx` runs `getMode()` which returns:
- `"settings"` — if no userName set (first run)
- `"ambient"` — if `lastCompletedDate === today` (routine already done)
- `"routine"` — otherwise (run the routine)

### Routine execution
`RoutineContainer` loads the active routine from storage, filters out `"reflection"` elements and unresolvable custom elements, then steps through with `stepIndex`. The final step is always `<Launch />`. Progress dots at the top are tappable to go back to previous steps.

### Element types
Built-in: `greeting`, `weather`, `quote`, `breathe`, `gratitude`, `intention`, `notes`, `stretches`, `exercise`, `water`. (`reflection` exists in storage/types for migration compat but is filtered at runtime and removed from the builder library.)

Custom elements live in `storage.customElements[]` and are referenced by ID from routine elements. Four subtypes: `prompt`, `timer`, `confirm`, `reflection`.

### Builder
`RoutineBuilder` → `ElementCard` (reorder/select) + `ElementSettings` (settings panel) + `ElementLibrary` (add new) + `CustomElementList` + `CreateCustomForm`.

`DurationPicker` (`components/builder/DurationPicker.tsx`) is the shared preset-chips + freeform min/sec input used by stretches, exercise, and custom timer settings.

## Conventions

### Design system ("hybrid")
The app's visual language is **editorial structure lit by an Open-style aura**. Depth comes from light + hairlines + type contrast — **not from cards/boxes** (avoid adding card surfaces for static content; cards are reserved for genuinely interactive affordances like the builder's draggable element list).
- **Atmosphere** is global: a warm aura bloom → warm-to-lavender gradient in `globals.css` (`body` + `.gradient-screen`), plus a paper-grain overlay mounted once in `app/layout.tsx` (`<Grain>`). Screens stay transparent (`dawn-gradient`) and show it through — never add a per-screen background fill.
- **Shared atoms** live in `components/ui/kit.tsx`: `fraunces(weight, italic)` style helper, `Label` (tiny tracked uppercase), `Rule` (warm hairline), `CircleButton` + `ArrowRightIcon` (cream FAB — the primary affordance). Prefer these over re-inlining.
- **Type scale**: masthead greeting/heading ≈ `text-[40px]` Fraunces 300 with a small italic lead line above; serif values ≈ `text-[22px]`; labels are `Label` (11px). Big-vs-tiny contrast is the point.
- **Screen header pattern**: masthead (lead + large name) → `<Rule/>` → hairline-separated sections.

### Styling
- Tailwind v4 — utility classes only, no `@apply`
- Brand colors: `#2A1F18` (dark brown, primary text), `#6B5544` (muted brown, secondary); warm aura→lavender atmosphere via `globals.css` (shown through the transparent `dawn-gradient` class)
- Fonts: `var(--font-fraunces)` for headings/display/serif moments (loaded via `next/font`), `font-[Inter]` for UI text
- Fraunces is always set via inline `style` prop: use `fraunces()` from the kit, or `{ fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 300 }`
- Opacity for hierarchy: labels/secondary text use `opacity-40`–`opacity-60`; never use pure black

### Animations
Framer Motion v12. Routine step transitions use `AnimatePresence mode="wait"` with `enter/center/exit` variants (`opacity + y`). Component-level animations use `motion.div` with inline `initial/animate/transition`.

### Component patterns
- Routine elements receive `{ onNext, onSkip }` — both advance the step (skip just doesn't save)
- Content-entry steps (intention, gratitude, notes) save on `onBlur`, not on Continue
- Section labels: use `Label` from `components/ui/kit.tsx` (`text-[11px] font-[Inter] font-medium uppercase tracking-[0.24em] text-[#6B5544]/70`)
- Empty/placeholder states use `opacity-30`–`opacity-40` on placeholder text

### Data displayed in ambient view
The ambient view is the resting form of the active routine: after the greeting row, `AmbientContainer` walks the active routine's elements **in order** and renders each module that has something to carry through the day — `intention` ("today is for"), `gratitude` ("grateful for"), custom `prompt`s (their label), `weather` ("outside", persisted via `getWeatherForToday`), and `quote`. Modules with no resting form (breathe, water, exercise, timers, confirms…) contribute nothing. Each section only appears if its element is in the routine — including the quote, which follows its element rather than always showing. Past mornings + footer nav close it out.

### No auto-advance
Steps must not auto-advance. The breathing module (`Breathe.tsx`) completes all cycles then shows a Continue button — it does not call `onNext` automatically.
Do not touch parts of the code that do not need to be modified for the given change to occur.

### Google Calendar integration
`CalendarSync` (`components/schedule/CalendarSync.tsx`) generates per-day weekly recurring GCal events. Each assigned day gets its own time picker and "add →" link, producing a `RRULE:FREQ=WEEKLY;BYDAY=XX` event. Calendar event titles use the format `{routineName} · Daybreak` — the `·` separator matches the app's existing detail-text convention.