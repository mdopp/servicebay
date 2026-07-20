---
title: ServiceBay UI / design standard for user-facing services
whenToUse: You're building the frontend of a user-facing ServiceBay service and want it to look and behave like ServiceBay's own admin UI — real design tokens (palette, accent, radii, typography, spacing) plus the baseline UX patterns (styled large file picker, streaming progress, responsive/mobile, focus states).
kind: guide
tags: [ui, design, frontend, tokens, palette, typography, accessibility, ux, responsive, mobile, streaming-progress, file-picker]
---

# ServiceBay UI / design standard

A user-facing service should feel like it belongs to ServiceBay even though it
lives on its own subdomain. This is the **descriptive** design language: copy the
tokens below into your own stylesheet (CSS custom properties, a Tailwind theme, or
whatever your stack uses) — there is no hosted/CDN stylesheet to import. The
tokens are extracted from ServiceBay's real admin UI
(`packages/frontend/src/app/globals.css` + `layout.tsx`), so adopting them makes a
service read as native rather than off-brand.

Two rules of thumb: **:root IS dark** (the admin UI's default is dark; a
`prefers-color-scheme: light` block overrides), and **semantic tokens over raw
color literals** — reference `--surface` / `--accent` / `--status-ok`, never a
hard-coded hex, so a theme change is one place.

## Palette (dark default)

Surfaces, borders, and text — the chrome:

| Token | Dark | Purpose |
|---|---|---|
| `--background` | `#050505` | page background (near-black) |
| `--surface` | `#111114` | base panel / card surface |
| `--surface-2` | `#1c1c20` | raised: nested rows, inputs, hover |
| `--surface-muted` | `#0a0a0c` | recessed wells, code blocks, table zebra |
| `--border` | `#2a2a30` | default hairline divider |
| `--border-strong` | `#3a3a42` | emphasized divider / focused control |
| `--text` | `#f0f0f0` | primary text |
| `--text-muted` | `#a1a1aa` | secondary / labels |
| `--text-subtle` | `#6b7280` | placeholders, disabled |

Status (dark-tuned to stay legible on dark surfaces — the 400 ramp):

| Token | Dark | Meaning |
|---|---|---|
| `--status-ok` | `#34d399` | success / healthy |
| `--status-warn` | `#fbbf24` | warning |
| `--status-fail` | `#f87171` | error / failed |
| `--status-info` | `#60a5fa` | informational |

## Accent (brand / primary action)

The ServiceBay accent is **blue-500**. This is the one color that says "primary
action" — the deploy button, the active nav item, the focus ring.

| Token | Value | Purpose |
|---|---|---|
| `--accent` | `#3b82f6` | brand / primary action fill |
| `--accent-strong` | `#2563eb` | hover / active (blue-600) |
| `--on-accent` | `#ffffff` | text / icon on an accent fill |

There's a secondary/gradient accent (`--accent-secondary: #8b5cf6`, violet) used
only for the premium gradient (`linear-gradient(135deg, #3b82f6, #8b5cf6)`) —
decorative, not for primary actions.

## Light mode

Ship a `@media (prefers-color-scheme: light)` override. Radii and spacing are
mode-independent; only surfaces/borders/text and the status ramp shift (status
moves to the darker 500/600 ramp to read on white). Accent is unchanged.

| Token | Light |
|---|---|
| `--background` | `#f8fafc` |
| `--surface` | `#ffffff` |
| `--surface-2` | `#f1f5f9` (slate-100) |
| `--surface-muted` | `#f8fafc` (slate-50) |
| `--border` | `#e2e8f0` (slate-200) |
| `--border-strong` | `#cbd5e1` (slate-300) |
| `--text` | `#0f172a` (slate-900) |
| `--text-muted` | `#475569` (slate-600) |
| `--text-subtle` | `#94a3b8` (slate-400) |
| `--status-ok/warn/fail/info` | `#059669` / `#d97706` / `#dc2626` / `#2563eb` (600 ramp) |

## Typography

- **Sans (UI):** Geist Sans, falling back to Inter, Outfit, then `sans-serif`.
  `--font-sans: "Geist", "Inter", "Outfit", sans-serif;`
- **Mono (code / logs / ids):** Geist Mono, falling back to Fira Code, `monospace`.
  `--font-mono: "Geist Mono", "Fira Code", monospace;`
- Body uses `-webkit-font-smoothing: antialiased`.
- Type scale is Tailwind's default ramp (`text-xs 0.75rem` → `text-sm 0.875rem` →
  `text-base 1rem` → `text-lg 1.125rem` → `text-xl 1.25rem` → `text-2xl 1.5rem`).
  Body copy is `text-sm`/`text-base`; labels are `text-xs`/`text-sm` in
  `--text-muted`.

If you don't want to bundle Geist, Inter is a near-identical free fallback and the
stack already lists it — the UI degrades gracefully.

## Radii

One canonical scale — pick by container size, don't invent per-component values:

| Token | Value | Use |
|---|---|---|
| `--r-chip` | `0.375rem` (6px) | chips, badges, status dots |
| `--r-card` | `0.625rem` (10px) | **DEFAULT** — cards, panels, buttons, inputs |
| `--r-panel` | `0.875rem` (14px) | large containers, modals |

## Spacing

4px base; use only these steps (map them to your framework's scale):

`--space-1` 4px · `--space-2` 8px · `--space-3` 12px · `--space-4` 16px ·
`--space-5` 24px · `--space-6` 32px · `--space-7` 48px · `--space-8` 64px.

Card/panel inner padding is typically `--space-4`/`--space-5`; the gap between
stacked cards is `--space-4`.

## Depth & motion (optional polish)

- Panels use a subtle glass/soft-depth treatment:
  `backdrop-filter: blur(8px)` + a 1px `rgba(255,255,255,0.08)` border on dark.
  Don't overdo it — one blur layer, not stacked.
- Transitions ease with `cubic-bezier(0.16, 1, 0.3, 1)` at ~300ms for
  color/shadow; hover-lift is `translateY(-2px) scale(1.008)`.
- Scrollbars are thin (6px) and low-contrast — a `rgba(148,163,184,.15)` thumb.

---

## UX baseline patterns (required, not just tokens)

Looking native is half the job. These behaviors are what a ServiceBay user
expects, and a service that skips them feels broken on a phone.

### 1. File picker — styled, large tap target (not the native input)

**Never expose the raw `<input type="file">` as the visible control** — it renders
a tiny, unstyled, OS-dependent button that is nearly untappable on mobile and
ignores the palette. Instead:

- Hide the native input (`sr-only` / visually hidden, but keep it in the DOM and
  focusable for accessibility) and drive it from a **styled label/dropzone** with
  a **≥44px tap target** (the accessibility minimum), `--r-card` corners, and a
  `--border`/`--surface-2` fill.
- Support **drag-and-drop** onto the zone on desktop *and* tap-to-open on mobile —
  the same element does both.
- Show the **selected file name + size** after pick, and a clear/replace affordance.
- Give it a visible **focus state** (see §4) and a hover/drag-over state
  (border → `--accent`, fill → a faint accent tint).

### 2. Streaming progress for long operations (not a bare spinner)

A spinner says "something is happening"; it does **not** survive a reload or tell
the user what's left. For anything that can exceed ~10s (bulk scans, per-item
network lookups, imports):

- Show **real, observable progress** — percent / counts / a rough ETA / the
  current item — not an indeterminate spinner. Stream it (SSE / polling by job
  id) as the server reports it.
- Make it **reconnectable**: the frontend reattaches by **job id from the
  server**, never from `localStorage`, so a page reload or a second tab shows the
  same live progress instead of "gone". The server owns the process; the frontend
  is only a view + remote control.
- Offer **cancel** and, where the work is bounded, the choices that avoid wasted
  work up front (scope, top-N, skip-known).
- This is the UI half of the durable-job contract — read `long-running-process`
  for the server side (durable job, resume-on-restart, owner-scoped
  `GET .../latest`).

### 3. Responsive / mobile layout

The box is used from phones. Design mobile-first:

- Single-column stack on narrow screens; multi-column only at a breakpoint.
- Tap targets **≥44px**; don't rely on hover for anything essential (touch has no
  hover).
- Tables → cards (or a horizontal-scroll region with `.no-scrollbar`) below the
  breakpoint; never a fixed-width layout that overflows the viewport.
- Respect safe-area insets and avoid pinning critical controls under a mobile
  browser's bottom chrome.

### 4. Focus states (keyboard + accessibility)

- Every interactive element has a **visible focus ring** — use the accent
  (`--accent`) as an outline/ring, e.g. a 2px `--accent` outline with a small
  offset. Never `outline: none` without a replacement.
- Focus order follows visual order; the hidden file input stays focusable.
- Meet **WCAG AA contrast** — the dark-tuned status ramp above is chosen for this;
  don't drop text to `--text-subtle` for content that must be readable.

---

## Adopt it

Copy the token block into your service's global stylesheet, wire the semantic
names into your framework's theme, and implement the four UX patterns above. The
goal isn't pixel-perfect parity with the admin UI (you're on a different
subdomain) — it's that a user moving between ServiceBay and your service feels one
design language, and your service works on a phone. Referenced from
`create-service` and `new-service-architecture`; also surfaced by
`get_service_standards` (servicebay flavor).
