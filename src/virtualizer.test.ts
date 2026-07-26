import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeVisibleRange, Virtualizer } from './virtualizer.js';

describe('computeVisibleRange (pure)', () => {
  test('empty list yields an empty range', () => {
    const range = computeVisibleRange({
      scrollOffset: 0,
      viewportSize: 500,
      count: 0,
      itemSize: 35,
      overscan: 5,
    });
    assert.deepEqual(range, { startIndex: 0, endIndex: -1 });
  });

  test('zero viewport size (e.g. container not yet measured) yields an empty range', () => {
    const range = computeVisibleRange({
      scrollOffset: 0,
      viewportSize: 0,
      count: 100,
      itemSize: 35,
      overscan: 5,
    });
    assert.deepEqual(range, { startIndex: 0, endIndex: -1 });
  });

  test('scrolled to the very top includes overscan only on the trailing edge', () => {
    const range = computeVisibleRange({
      scrollOffset: 0,
      viewportSize: 100,
      count: 1000,
      itemSize: 10,
      overscan: 2,
    });
    // visible without overscan: items 0..10 (floor(0/10)=0, floor(100/10)=10)
    assert.deepEqual(range, { startIndex: 0, endIndex: 12 });
  });

  test('mid-list scroll applies overscan symmetrically', () => {
    const range = computeVisibleRange({
      scrollOffset: 25,
      viewportSize: 50,
      count: 20,
      itemSize: 10,
      overscan: 2,
    });
    // firstVisible=floor(25/10)=2, lastVisible=floor(75/10)=7
    assert.deepEqual(range, { startIndex: 0, endIndex: 9 });
  });

  test('near the end, endIndex clamps to count - 1', () => {
    const range = computeVisibleRange({
      scrollOffset: 190,
      viewportSize: 50,
      count: 20,
      itemSize: 10,
      overscan: 5,
    });
    assert.equal(range.endIndex, 19);
  });

  test('single item list', () => {
    const range = computeVisibleRange({
      scrollOffset: 0,
      viewportSize: 500,
      count: 1,
      itemSize: 35,
      overscan: 5,
    });
    assert.deepEqual(range, { startIndex: 0, endIndex: 0 });
  });

  test('scroll offset past the end of the content produces no crash and no items', () => {
    // Only reachable if a caller sets scrollTop beyond [0, totalSize - viewportSize]
    // (browsers normally clamp this themselves) — startIndex ends up past endIndex,
    // which the caller's render loop naturally treats as "nothing to render".
    const range = computeVisibleRange({
      scrollOffset: 10_000,
      viewportSize: 50,
      count: 20,
      itemSize: 10,
      overscan: 1,
    });
    assert.ok(range.startIndex > range.endIndex);
  });
});

/**
 * Minimal stand-in for a DOM element, so core tests need no jsdom. It only
 * implements the handful of members the core actually touches (scrollTop,
 * clientHeight, add/removeEventListener); `asElement` casts it to satisfy
 * Virtualizer's `HTMLElement | null` option type at the boundary.
 */
class FakeScrollElement {
  scrollTop = 0;
  clientHeight: number;
  private readonly listeners = new Set<() => void>();

  constructor(clientHeight: number) {
    this.clientHeight = clientHeight;
  }

  addEventListener(_type: 'scroll', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'scroll', listener: () => void): void {
    this.listeners.delete(listener);
  }

  dispatchScroll(): void {
    for (const listener of this.listeners) listener();
  }

  get asElement(): HTMLElement {
    return this as unknown as HTMLElement;
  }
}

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('Virtualizer', () => {
  test('getTotalSize is count * itemSize', () => {
    const el = new FakeScrollElement(500);
    const v = new Virtualizer({ count: 1000, itemSize: 35, getScrollElement: () => el.asElement });
    assert.equal(v.getTotalSize(), 35_000);
  });

  test('getVirtualItems reflects current scrollTop/clientHeight with default overscan', () => {
    const el = new FakeScrollElement(100);
    el.scrollTop = 200;
    const v = new Virtualizer({
      count: 1000,
      itemSize: 10,
      overscan: 0,
      getScrollElement: () => el.asElement,
    });
    const items = v.getVirtualItems();
    assert.equal(items[0]?.index, 20);
    assert.equal(items.at(-1)?.index, 30);
    assert.equal(items[0]?.start, 200);
    assert.equal(items[0]?.size, 10);
  });

  test('getVirtualItems is empty when there is no scroll element yet', () => {
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => null });
    assert.deepEqual(v.getVirtualItems(), []);
  });

  test('construction has no side effects: a scroll event before mount() does not notify', async () => {
    const el = new FakeScrollElement(100);
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => el.asElement });
    let calls = 0;
    v.subscribe(() => {
      calls += 1;
    });

    el.dispatchScroll(); // no-op: mount() was never called, so no listener is attached
    await nextFrame();
    assert.equal(calls, 0);
  });

  test('mount() notifies once, immediately, so a late-arriving scroll element is picked up', () => {
    const el = new FakeScrollElement(100);
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => el.asElement });
    let calls = 0;
    v.subscribe(() => {
      calls += 1;
    });

    v.mount();
    assert.equal(calls, 1);
  });

  test('mount() is idempotent: a second call does not re-trigger the mount notification', () => {
    const el = new FakeScrollElement(100);
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => el.asElement });
    let calls = 0;
    v.subscribe(() => {
      calls += 1;
    });

    v.mount();
    v.mount();
    assert.equal(
      calls,
      1,
      'second mount() call should be a no-op, since the element is already attached',
    );
  });

  test('a scroll event notifies subscribers (throttled to one recompute per frame)', async () => {
    const el = new FakeScrollElement(100);
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => el.asElement });
    v.mount();
    let calls = 0;
    v.subscribe(() => {
      calls += 1;
    });

    el.scrollTop = 50;
    el.dispatchScroll();
    el.scrollTop = 60;
    el.dispatchScroll();
    el.scrollTop = 70;
    el.dispatchScroll();

    assert.equal(calls, 0, 'should not notify synchronously');
    await nextFrame();
    assert.equal(
      calls,
      1,
      'three scroll events in one frame should coalesce into one notification',
    );
  });

  test('unsubscribe stops further notifications', async () => {
    const el = new FakeScrollElement(100);
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => el.asElement });
    v.mount();
    let calls = 0;
    const unsubscribe = v.subscribe(() => {
      calls += 1;
    });
    unsubscribe();

    el.dispatchScroll();
    await nextFrame();
    assert.equal(calls, 0);
  });

  test('destroy() detaches the scroll listener', async () => {
    const el = new FakeScrollElement(100);
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => el.asElement });
    v.mount();
    let calls = 0;
    v.subscribe(() => {
      calls += 1;
    });
    v.destroy();

    el.dispatchScroll();
    await nextFrame();
    assert.equal(calls, 0);
  });

  test('scrollToOffset clamps to [0, totalSize - clientHeight]', () => {
    const el = new FakeScrollElement(100);
    const v = new Virtualizer({ count: 10, itemSize: 10, getScrollElement: () => el.asElement }); // total = 100

    v.scrollToOffset(-50);
    assert.equal(el.scrollTop, 0);

    v.scrollToOffset(9999);
    assert.equal(el.scrollTop, 0); // totalSize (100) - clientHeight (100) = 0

    const el2 = new FakeScrollElement(40);
    const v2 = new Virtualizer({ count: 10, itemSize: 10, getScrollElement: () => el2.asElement }); // total = 100
    v2.scrollToOffset(9999);
    assert.equal(el2.scrollTop, 60);
  });

  test('scrollToIndex "start" places the item at the top of the viewport', () => {
    const el = new FakeScrollElement(100);
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => el.asElement });
    v.scrollToIndex(50, 'start');
    assert.equal(el.scrollTop, 500);
  });

  test('scrollToIndex "end" places the item at the bottom of the viewport', () => {
    const el = new FakeScrollElement(100);
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => el.asElement });
    v.scrollToIndex(50, 'end');
    // item 50 spans [500, 510); bottom-aligned means viewport ends at 510
    assert.equal(el.scrollTop, 410);
  });

  test('scrollToIndex "center" centers the item in the viewport', () => {
    const el = new FakeScrollElement(100);
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => el.asElement });
    v.scrollToIndex(50, 'center');
    // item 50 starts at 500, itemSize/2=5, clientHeight/2=50 -> 500 - 50 + 5
    assert.equal(el.scrollTop, 455);
  });

  test('scrollToIndex "auto" does nothing if the item is already fully visible', () => {
    const el = new FakeScrollElement(100);
    el.scrollTop = 400;
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => el.asElement });
    v.scrollToIndex(45, 'auto'); // item spans [450, 460), inside [400, 500)
    assert.equal(el.scrollTop, 400);
  });

  test('scrollToIndex "auto" scrolls up to reveal an item above the viewport', () => {
    const el = new FakeScrollElement(100);
    el.scrollTop = 400;
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => el.asElement });
    v.scrollToIndex(10, 'auto'); // item spans [100, 110), above viewStart 400
    assert.equal(el.scrollTop, 100);
  });

  test('scrollToIndex "auto" scrolls down to reveal an item below the viewport', () => {
    const el = new FakeScrollElement(100);
    el.scrollTop = 0;
    const v = new Virtualizer({ count: 1000, itemSize: 10, getScrollElement: () => el.asElement });
    v.scrollToIndex(50, 'auto'); // item ends at 510, past viewEnd 100
    assert.equal(el.scrollTop, 410);
  });

  test('scrollToIndex clamps out-of-range indices', () => {
    const el = new FakeScrollElement(100);
    const v = new Virtualizer({ count: 10, itemSize: 10, getScrollElement: () => el.asElement }); // total = 100
    v.scrollToIndex(9999, 'start');
    assert.equal(el.scrollTop, 0); // clamped to last index (9), then offset clamped by scrollToOffset
  });
});
