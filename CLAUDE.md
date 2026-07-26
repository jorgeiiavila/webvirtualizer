# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`webvirtualizer` is a minimal, framework-agnostic list virtualization
("windowing") library, built from scratch to understand the mechanics behind
TanStack Virtual / react-window rather than to compete with them. The full
design rationale, algorithm walkthroughs, and milestone roadmap live in
[`docs/DESIGN.md`](docs/DESIGN.md) — read it before making non-trivial
changes, since most design decisions here are deliberate and explained there
(e.g. why `transform` over `top` for positioning, why `useSyncExternalStore`
over `useState`, why native `scroll` events over `IntersectionObserver`).

## Commands

```sh
npm run build         # compile src/ -> dist/ via tsc
npm test              # build, then run unit tests with node:test
npm run lint          # eslint .
npm run format        # prettier --write .
npm run format:check  # prettier --check .
npm run demo          # build, then serve example/ at http://localhost:4173
```

Run a single test (after `npm run build`, or let `--test` trigger it):

```sh
node --test --test-name-pattern="<name substring>" dist/virtualizer.test.js
```

Tests are written with Node's built-in `node:test` runner (not
Jest/Vitest) and compiled from `.ts` to `.js` before running — there is no
separate ts-node/transform step, so a test-only syntax error will only show
up as a `tsc` failure via `npm test`, not as a test failure.

## Architecture

- **`src/virtualizer.ts`** — the entire core. Two things live here
  deliberately separated:
  - `computeVisibleRange()`: a pure function (no DOM, no class state) mapping
    `(scrollOffset, viewportSize, count, itemSize, overscan)` →
    `{startIndex, endIndex}`. Kept pure so the range math is exhaustively
    unit-testable without mocking the DOM.
  - `Virtualizer`: the stateful class wrapping that pure function with scroll
    listening, a subscriber list, and imperative scroll control
    (`scrollToIndex`/`scrollToOffset`).
- **`src/index.ts`** — the package's public entry point; only re-exports from
  `virtualizer.ts`. Add new public API surface here, not by exporting
  directly from `virtualizer.ts` call sites elsewhere.
- **`src/demo/main.ts`** + **`example/index.html`** — a manual browser demo
  (100k-row list) for exercising the core by hand. Not part of the published
  package (`files` in `package.json` only ships `dist`).

### Core design constraints worth knowing before editing `Virtualizer`

- **No DOM work in the constructor.** Construction can happen during a React
  render (which must stay pure/discardable), and `getScrollElement()` backed
  by a ref returns `null` before commit anyway. All DOM attachment happens in
  the explicit `mount()` method, meant to be called from a mount effect.
- **`mount()` is idempotent** — safe to call twice (React StrictMode's
  mount→cleanup→mount in dev is a real scenario this guards against).
- **`subscribe` and `getVirtualItems` are arrow fields, not prototype
  methods**, because they're passed by bare reference to
  `useSyncExternalStore(instance.subscribe, instance.getVirtualItems)` in the
  planned React adapter — they can't rely on being called as
  `instance.method()`.
- **Scroll handling is rAF-throttled**: the native `scroll` listener
  coalesces bursts into at most one recompute per animation frame, since
  scroll events fire faster than the display refresh rate.
- **`scheduleFrame`/`cancelFrame` fall back to `setTimeout`/`clearTimeout`**
  when `requestAnimationFrame` isn't available, so the core stays unit-testable
  under plain Node (no DOM/browser required).

### Where the project is headed

Per `docs/DESIGN.md`, milestone 1 (fixed-size vertical core — what currently
exists) is done. Upcoming work, in order: variable-size items (prefix-sum
array + dirty watermark + binary search + `measureElement`/`ResizeObserver`),
a React adapter (`useVirtualizer` via `useSyncExternalStore`, needs
`useLayoutEffect` for `mount()` to avoid a one-frame empty-content flash —
see DESIGN.md §6 milestone 3 callout), then overscan/scroll-anchoring polish
and a horizontal axis. `tsconfig.json` already has `jsx: react-jsx` set in
anticipation of the React adapter.
