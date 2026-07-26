# webvirtualizer — Design Doc

## 1. Motivation

Rendering a list of 10,000 DOM nodes is slow: layout, paint, and memory cost scale
with the number of live nodes, not with what's actually visible on screen. A
viewport can only ever show ~20-40 rows at once. **List virtualization**
("windowing") exploits this: only mount the DOM nodes for items currently
in (or near) the viewport, and fake the presence of the rest with an empty
spacer that gives the scrollbar the correct total size.

The goal of this project is to build a minimal version of what TanStack
Virtual / react-window do, primarily to understand the mechanics, not to
compete with them on features. This doc lays out the concepts involved and
the design decisions for a from-scratch implementation.

## 2. Core concepts

### 2.1 The windowing illusion

Three things have to work together to make virtualization invisible to the user:

1. **A scroll container** with a fixed height/width and `overflow: auto`,
   containing an inner element sized to the _full_ (virtual) content size.
2. **A visible range**: given the current scroll offset and viewport size,
   compute which item indices are (approximately) visible.
3. **Positioning**: render only those items' DOM nodes, each placed at its
   correct offset within the full-size inner container.

The browser's native scrollbar operates on the inner container's full
height, so scrolling feels identical to a non-virtualized list — the user
is scrolling a normal 50,000px-tall div, we're just lying about what's
inside it.

### 2.2 Measuring items: fixed vs. variable size

This is the central design fork for any virtualizer.

- **Fixed size**: every item has the same known height. Trivial math:
  `offset(index) = index * itemSize`, and the visible range is a
  constant-time division. No DOM measurement needed at all.
- **Variable/dynamic size**: item height is unknown until rendered (text
  wrapping, images, user content). This requires:
  - An **estimate function** to guess sizes before measuring (so we can
    compute an approximate scrollbar size and range on first render).
  - A **measurement mechanism** (`ResizeObserver`, or a `getBoundingClientRect`
    read after mount) to record the _real_ size once an item is in the DOM.
  - A **cache** from index → measured size, and a way to recompute cumulative
    offsets once entries in that cache are invalidated (e.g. content changed).

Real-world lists (chat messages, tweets, comments) are almost always
variable-size, so that's the case worth designing for — fixed-size is a
subset/optimization of it (estimate == actual, never remeasure).

### 2.3 Offset lookup: prefix sums + binary search

To turn "scrollTop = 4213px" into "which item indices are visible," you need
a mapping from offset → index. Naively summing sizes from index 0 every
scroll event is O(n) per frame — too slow for large lists.

Standard approach:

- Maintain a **prefix-sum array** `offsets[i] = sum of sizes[0..i-1]`,
  rebuilt incrementally only for indices at or after the first one that
  changed (a "dirty index" watermark), not the whole array.
- To find the item at a given scroll offset, **binary search** the prefix-sum
  array (O(log n)) instead of scanning linearly.

This is the same trick used by TanStack Virtual and react-window's
`VariableSizeList`. It's the one piece of real "algorithm" in an otherwise
mostly-DOM-plumbing project, which is part of why it's worth implementing
by hand rather than just reading about it.

### 2.4 Overscan

Rendering _exactly_ the visible items causes a visible pop-in flash of
blank space during fast scrolls or key-repeat scrolling, because mount +
measure + paint isn't instant. **Overscan** renders N extra items beyond
each edge of the viewport as a buffer. Trade-off: higher overscan = smoother
scroll but more live DOM nodes (defeats some of the purpose if set too high).
A typical default is 3-5 items.

### 2.5 Positioning strategy: transform vs. top/margin

Two ways to place a virtual item at its computed offset inside the spacer:

- `top: Npx` (with `position: absolute`) — simple, but triggers layout
  (reflow) on every position change since `top` participates in layout.
- `transform: translateY(Npx)` — compositor-only in most browsers, doesn't
  trigger layout/paint, much cheaper during scroll.

Decision: use `transform`. This is the same choice TanStack Virtual makes,
and it's the single biggest "why is my homegrown list janky" gotcha people
hit when they build this naively with `top`.

### 2.6 Total size / spacer element

The inner scrollable content needs a real height equal to the _sum of all
item sizes_ (using estimates for unmeasured items) so the native scrollbar
thumb size/position is accurate. As items get measured and their real size
differs from the estimate, total size is recalculated and the spacer
resizes — this is what causes scrollbar "jitter" on lists with bad size
estimates, which is an accepted, documented trade-off (TanStack Virtual has
the same behavior) rather than a bug to eliminate.

### 2.7 Scroll tracking

Two implementation choices:

- Listen to the container's native `scroll` event.
- Track scroll position via `IntersectionObserver` on sentinel elements.

Decision: native `scroll` event with a **passive listener**, throttled to
`requestAnimationFrame` (recompute the visible range at most once per
frame, not once per event — scroll events can fire much faster than the
display refresh rate). IntersectionObserver is a poor fit here because it
doesn't give a continuous offset, only enter/exit booleans, and its
callback timing isn't tied to frames.

### 2.8 Framework-agnostic core + thin adapter

TanStack Virtual's architecture (and the one this project will copy) splits
into:

- **Core** (`@tanstack/virtual-core` equivalent): a plain TS class with no
  framework dependency. Holds config, scroll offset, measurement cache,
  computes the visible range, exposes an observable "notify me when output
  changes" hook.
- **Adapter** (`@tanstack/react-virtual` equivalent): a thin wrapper —
  a `useState`/`useSyncExternalStore` binding that instantiates the core,
  subscribes to it, and re-renders the consuming component when it changes.

Reasoning: this forces a clean separation between "the algorithm" (range
computation, measurement, offset caching) and "the rendering," which is
exactly the part worth understanding deeply. It also means a Vue or Svelte
adapter is a few dozen lines later, if wanted, without touching core logic.

**This repo ships the core only, deliberately with zero framework
dependency** — no `react`/`react-dom`, no JSX config, nothing. The first
adapter (React) will live in a separate package (e.g. `webvirtualizer-react`)
that depends on this one, rather than inside this repo. That keeps this
package installable anywhere a plain scroll container exists, and keeps
"the algorithm" and "the rendering" separated at the package boundary, not
just the file boundary.

## 3. Public API sketch

Modeled closely on TanStack Virtual's `useVirtualizer`, since matching a
known-good API shape is a useful check on the underlying design as it's
built (if the design doesn't naturally support this API, either the API
doesn't fit or the design has a gap).

```ts
interface VirtualizerOptions {
  count: number; // total item count
  getScrollElement: () => Element | null; // the scrollable container
  estimateSize: (index: number) => number; // px estimate before measuring
  overscan?: number; // default 5
  scrollMargin?: number; // offset of list start within scroll container
  horizontal?: boolean; // axis
}

interface VirtualItem {
  index: number;
  start: number; // px offset from top of virtual content
  end: number;
  size: number;
  key: number | string;
}

class Virtualizer {
  constructor(options: VirtualizerOptions);
  getVirtualItems(): VirtualItem[];
  getTotalSize(): number;
  measureElement(el: Element, index: number): void; // called via ref callback
  scrollToIndex(index: number, opts?: { align?: 'start' | 'center' | 'end' | 'auto' }): void;
  scrollToOffset(offset: number): void;
  subscribe(callback: () => void): () => void; // unsubscribe fn
}
```

A React adapter consuming this package (built separately — see §2.8) would
look like:

```tsx
function useVirtualizer(options: VirtualizerOptions) {
  const instance = useMemo(() => new Virtualizer(options), []);
  const items = useSyncExternalStore(instance.subscribe, instance.getVirtualItems);
  return instance;
}
```

`useSyncExternalStore` is the right primitive here (over plain `useState` +
`useEffect`) because the core mutates outside of React's render cycle
(scroll events, ResizeObserver callbacks) — this is exactly the "external
store" case the hook was added for, and it avoids tearing during concurrent
rendering. This sketch lives here only because it's a useful check on the
core's API shape (§3 intro); the actual implementation belongs in the
adapter package, not this one.

## 4. Algorithm walkthrough

### 4.1 Computing the visible range

```
function getVisibleRange(scrollOffset, viewportSize, offsets, sizes):
    startIndex = binarySearch(offsets, scrollOffset)       // first item whose end > scrollOffset
    endIndex = binarySearch(offsets, scrollOffset + viewportSize)
    return [max(0, startIndex - overscan), min(count - 1, endIndex + overscan)]
```

### 4.2 Measurement flow

1. Item `i` renders using `estimateSize(i)` — a guess.
2. Its DOM node mounts; a ref callback calls `measureElement(el, i)`.
3. `measureElement` reads the real size (`getBoundingClientRect().height`,
   already the layout-settled value at this point) and, if it differs from
   the cached value, stores it and marks index `i` as the new "dirty
   watermark."
4. On the next range computation, prefix sums from the watermark onward are
   recalculated before doing the binary search.
5. `ResizeObserver` on each mounted item's element re-triggers step 3 if the
   item's size changes later (e.g. async image load, font swap) without a
   remount.

### 4.3 Scroll-anchoring problem

If an item _above_ the viewport gets remeasured to a different size after
initial estimate (common with async content), every item below it shifts,
which can yank the currently-visible content up or down mid-scroll — this
is the most user-visible failure mode of naive dynamic-size virtualizers.
Mitigation: when a size change occurs for an index that's fully above the
current viewport, adjust `scrollTop` by the same delta in the same
`ResizeObserver` callback (before paint) so the currently-visible items
stay visually anchored in place. This is the same technique used for "chat
scroll stays pinned to bottom while older messages above resize."

## 5. Non-goals / explicit simplifications for v1

To keep this buildable and understandable rather than turning into a
feature-complete library clone:

- **No grid/2D virtualization** (rows _and_ columns) — vertical list only
  first, horizontal as a straightforward generalization once vertical
  works, grid deferred indefinitely.
- **No sticky headers / grouping** — a real feature in production
  virtualizers, but orthogonal to the core windowing logic.
- **No SSR-specific rendering path** — assume client-only rendering for v1;
  SSR would mean rendering a server-guessed range with no measurement.
- **No drag-to-reorder / dynamic insertion animation** — item count can
  change, but no special-cased transition handling.

## 6. Milestones

1. **Fixed-size vertical core**: constant-time offset math, scroll listener,
   range computation, spacer div, `transform`-positioned items. No
   measurement yet. Validates the plumbing end-to-end.
2. **Variable-size support**: estimate function, prefix-sum array with dirty
   watermark, binary search, `measureElement` via ref + `ResizeObserver`.
3. **Polish**: overscan tuning, `scrollToIndex`/`scrollToOffset`, scroll
   anchoring fix for above-viewport resizes.
4. **Stretch**: horizontal axis support.

This repo's roadmap stops at the core. A React adapter (and, if wanted,
further framework adapters later) is out of scope here and will be built as
a separate package depending on this one — see §2.8. That package will need
to solve one problem specific to it, noted here since it stems directly from
this core's `mount()` design (§ above, "No DOM work in the constructor"):

> **Callout for the future React adapter — mount timing:** the core's
> `mount()` (which attaches the scroll listener and reads the scroll element
> for the first time) must be called from an effect, since refs aren't
> populated until React's commit phase, after render. Refs _are_ guaranteed
> set by the time any effect runs (`useLayoutEffect` and `useEffect` both
> fire after ref attachment), but `useEffect` runs after the browser paints —
> so a plain `useEffect` means the first paint happens with
> `getScrollElement()` still returning `null` (empty item list), followed by
> a corrected paint once the effect fires and `mount()`'s `notify()` triggers
> a re-render: a one-frame flash of empty content. Use `useLayoutEffect` for
> the `mount()` call instead — it runs synchronously in the commit phase,
> before paint, so the corrected render happens before anything is shown.
> (Needs an isomorphic-layout-effect fallback to plain `useEffect` under SSR,
> where `useLayoutEffect` warns because there's no DOM — same technique
> TanStack Virtual uses.)

## 7. Testing strategy

- **Core logic (pure, no DOM)**: unit tests for the prefix-sum/dirty-watermark
  recomputation and the binary search range function — these are pure
  functions of arrays and numbers, easy to test exhaustively including edge
  cases (empty list, single item, scroll offset past the end, all-same-size,
  wildly different sizes).
- **Integration**: the vanilla-JS demo in `example/` exercised manually and,
  if time allows, with Playwright — assert the right number of DOM nodes
  exist at a given scroll position, and that scrolling to the end doesn't
  throw or render a wrong range.
