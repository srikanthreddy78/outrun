# Daybreak (template)

A calm, minimal morning-routine app, stripped down to a clean template: no backend, no accounts, no analytics. All state lives in a single `localStorage` key (`"daybreak"`).

Next.js 16 (App Router) · React 19 · Tailwind v4 · Framer Motion.

## Run it

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
npx tsc --noEmit # type-check
```

## What's inside

- **Routine** — step through a morning routine (greeting, weather, quote, breathe, gratitude, intention, notes, stretches, exercise, water, plus custom prompts/timers/confirms).
- **Builder** — create and reorder routines and elements.
- **Ambient view** — the resting form of the routine once it's done for the day.
- **Schedule** — assign routines to days; optional "add to Google Calendar" links.

See `CLAUDE.md` for architecture and design conventions. Haptics and notifications (`lib/haptics.ts`, `lib/notifications.ts`) are intentionally inert stubs in this web-only template.

Built by Matthew Huang.
