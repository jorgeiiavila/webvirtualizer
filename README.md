# webvirtualizer

A minimal, framework-agnostic list virtualization ("windowing") core, built
from scratch to understand the mechanics behind libraries like
[TanStack Virtual](https://tanstack.com/virtual) and
[react-window](https://github.com/bvaughn/react-window) — not to replace them.

Rendering thousands of DOM nodes is slow, and a viewport can only ever show a
handful of rows at once. This library computes which items are actually
visible (plus a small overscan buffer) so only those get mounted, while a
spacer element keeps the scrollbar sized as if the full list were there.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design rationale,
algorithm walkthrough, and milestone roadmap.

## Status

**Milestone 1 (fixed-size vertical core)** is implemented: constant-time
offset math, a `requestAnimationFrame`-throttled scroll listener, range
computation, and `scrollToIndex`/`scrollToOffset`. Variable-size item support
and horizontal axis support are planned — see
[`docs/DESIGN.md`](docs/DESIGN.md#6-milestones) for what's next.

This package stays framework-agnostic on purpose: no React (or other
framework) adapter lives here. A separate package will depend on this one
to provide framework-specific bindings (a React adapter first).

## Install

```sh
npm install webvirtualizer
```

## Usage

```ts
import { Virtualizer } from 'webvirtualizer';

const scrollElement = document.querySelector('#scroll-container');

const virtualizer = new Virtualizer({
  count: 100_000,
  itemSize: 35,
  overscan: 5,
  getScrollElement: () => scrollElement,
});

virtualizer.mount();

function render() {
  const items = virtualizer.getVirtualItems();
  // Position each item at `item.start` (e.g. via `transform: translateY(...)`)
  // inside a spacer sized to `virtualizer.getTotalSize()`.
}

virtualizer.subscribe(render);
render();
```

See [`example/index.html`](example/index.html) and
[`example/main.ts`](example/main.ts) for a complete working demo.

## Development

```sh
npm install       # install dependencies
npm run build     # compile TypeScript to dist/
npm test          # build, then run the unit tests via node:test
npm run lint      # lint with oxlint
npm run format    # format with Prettier
npm run demo      # build, then serve example/ at http://localhost:4173
```

## License

[MIT](LICENSE)
