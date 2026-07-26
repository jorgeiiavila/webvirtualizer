import { Virtualizer } from '../dist/index.js';

const ITEM_SIZE = 35;
const COUNT = 100_000;

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Demo markup is missing "${selector}"`);
  return el;
}

const scrollElement = requireElement<HTMLDivElement>('#scroll-container');
const spacer = requireElement<HTMLDivElement>('#spacer');
const statusEl = requireElement<HTMLDivElement>('#status');
const jumpButton = requireElement<HTMLButtonElement>('#jump-to-50000');

const virtualizer = new Virtualizer({
  count: COUNT,
  itemSize: ITEM_SIZE,
  overscan: 5,
  getScrollElement: () => scrollElement,
});
// #scroll-container is a real DOM element by the time this module-level code
// runs (module scripts execute after the document is parsed), so mounting
// immediately is safe here — a React adapter would instead do this inside a
// mount effect, since refs aren't populated until after commit.
virtualizer.mount();

function render(): void {
  spacer.style.height = `${virtualizer.getTotalSize()}px`;

  const virtualItems = virtualizer.getVirtualItems();
  spacer.replaceChildren(
    ...virtualItems.map((item) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.transform = `translateY(${item.start}px)`;
      row.style.height = `${item.size}px`;
      row.textContent = `Row #${item.index}`;
      return row;
    }),
  );

  statusEl.textContent = `${virtualItems.length} DOM nodes mounted out of ${COUNT.toLocaleString()} rows`;
}

virtualizer.subscribe(render);
render();

jumpButton.addEventListener('click', () => {
  virtualizer.scrollToIndex(50_000, 'start');
});
