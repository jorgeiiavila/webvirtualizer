/**
 * Milestone 1: fixed-size vertical core.
 * Every item has the same height, so offset(index) = index * itemSize —
 * no measurement, no prefix-sum cache. That machinery arrives in M2 when
 * item sizes become variable.
 */

export interface VirtualizerOptions {
  count: number;
  getScrollElement: () => HTMLElement | null;
  itemSize: number;
  overscan?: number;
}

export interface VirtualItem {
  index: number;
  start: number;
  end: number;
  size: number;
  key: number;
}

type Listener = () => void;

const DEFAULT_OVERSCAN = 5;

// Node has no requestAnimationFrame; fall back to a frame-rate timer so the
// same core runs (and is unit-testable) outside a browser.
const scheduleFrame: (cb: () => void) => number =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (cb) => setTimeout(cb, 16) as unknown as number;

const cancelFrame: (handle: number) => void =
  typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame
    : (handle) => clearTimeout(handle);

/**
 * Pure range computation, kept separate from the class so it can be
 * exhaustively unit tested without touching the DOM.
 */
export function computeVisibleRange(params: {
  scrollOffset: number;
  viewportSize: number;
  count: number;
  itemSize: number;
  overscan: number;
}): { startIndex: number; endIndex: number } {
  const { scrollOffset, viewportSize, count, itemSize, overscan } = params;

  if (count <= 0 || itemSize <= 0 || viewportSize <= 0) {
    return { startIndex: 0, endIndex: -1 };
  }

  const firstVisible = Math.floor(scrollOffset / itemSize);
  const lastVisible = Math.floor((scrollOffset + viewportSize) / itemSize);

  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(count - 1, lastVisible + overscan);

  return { startIndex, endIndex };
}

export class Virtualizer {
  private readonly options: Required<VirtualizerOptions>;
  private readonly listeners = new Set<Listener>();
  private readonly onScroll: Listener;
  private scrollElement: HTMLElement | null = null;
  private frameHandle: number | null = null;

  constructor(options: VirtualizerOptions) {
    this.options = { overscan: DEFAULT_OVERSCAN, ...options };
    this.onScroll = () => {
      // Coalesce bursts of scroll events into one recompute per frame.
      if (this.frameHandle != null) return;
      this.frameHandle = scheduleFrame(() => {
        this.frameHandle = null;
        this.notify();
      });
    };
    // No DOM side effects here on purpose: construction can happen during a
    // React render (which must stay pure and can be discarded/retried), and
    // getScrollElement() backed by a ref would return null before commit
    // anyway. Attaching is a separate, explicit step — see mount().
  }

  /**
   * Attach the scroll listener. Must be called explicitly once the scroll
   * element actually exists — e.g. from a React mount effect, not during
   * render. Safe to call more than once (e.g. React StrictMode's
   * mount→cleanup→mount in dev); a second call while already mounted is a
   * no-op.
   */
  mount(): void {
    if (this.scrollElement) return;
    const el = this.options.getScrollElement();
    if (!el) return;
    el.addEventListener('scroll', this.onScroll, { passive: true });
    this.scrollElement = el;
    // The element may have just become available (e.g. right after a ref
    // committed) with a scroll position getVirtualItems() never saw yet.
    this.notify();
  }

  /** Detach DOM listeners. Call when the consumer (e.g. a component) unmounts. */
  destroy(): void {
    this.scrollElement?.removeEventListener('scroll', this.onScroll);
    this.scrollElement = null;
    if (this.frameHandle != null) {
      cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.listeners.clear();
  }

  // Arrow field, not a method: adapters (e.g. useSyncExternalStore(instance.subscribe, ...))
  // pass this by bare reference, so it can't rely on being called as instance.subscribe(...).
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  getTotalSize(): number {
    return this.options.count * this.options.itemSize;
  }

  // Also an arrow field: this is the getSnapshot passed to useSyncExternalStore.
  getVirtualItems = (): VirtualItem[] => {
    const el = this.options.getScrollElement();
    const { count, itemSize, overscan } = this.options;

    const { startIndex, endIndex } = computeVisibleRange({
      scrollOffset: el?.scrollTop ?? 0,
      viewportSize: el?.clientHeight ?? 0,
      count,
      itemSize,
      overscan,
    });

    const items: VirtualItem[] = [];
    for (let index = startIndex; index <= endIndex; index++) {
      const start = index * itemSize;
      items.push({ index, start, end: start + itemSize, size: itemSize, key: index });
    }
    return items;
  };

  scrollToOffset(offset: number): void {
    const el = this.options.getScrollElement();
    if (!el) return;
    const maxOffset = Math.max(0, this.getTotalSize() - el.clientHeight);
    el.scrollTop = Math.min(Math.max(0, offset), maxOffset);
  }

  scrollToIndex(index: number, align: 'start' | 'center' | 'end' | 'auto' = 'auto'): void {
    const el = this.options.getScrollElement();
    const { itemSize, count } = this.options;
    if (!el || count === 0) return;

    const clampedIndex = Math.min(Math.max(0, index), count - 1);
    const itemStart = clampedIndex * itemSize;
    const itemEnd = itemStart + itemSize;

    if (align === 'start') {
      this.scrollToOffset(itemStart);
      return;
    }
    if (align === 'end') {
      this.scrollToOffset(itemEnd - el.clientHeight);
      return;
    }
    if (align === 'center') {
      this.scrollToOffset(itemStart - el.clientHeight / 2 + itemSize / 2);
      return;
    }

    // 'auto': only move the scroll position if the item isn't already fully visible.
    const viewStart = el.scrollTop;
    const viewEnd = viewStart + el.clientHeight;
    if (itemStart < viewStart) {
      this.scrollToOffset(itemStart);
    } else if (itemEnd > viewEnd) {
      this.scrollToOffset(itemEnd - el.clientHeight);
    }
  }
}
