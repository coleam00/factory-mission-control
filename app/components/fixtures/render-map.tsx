import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { FACTORY_MAP, selectOnArrival } from '../../map/factory-map';
import { FactoryMap } from '../FactoryMap';
import { useMapPath } from '../useMapPath';

/** The map as `Home` mounts it: the address names the view, and a level change is a navigation. */
function Screen() {
  const [path, onPath] = useMapPath(FACTORY_MAP);
  const select = selectOnArrival(useLocation().state);
  return (
    <FactoryMap
      map={FACTORY_MAP}
      live={new Map()}
      factory="x"
      at={null}
      flow={false}
      select={select}
      path={path}
      onPath={onPath}
      steps={undefined}
    />
  );
}

async function until(done: () => boolean, what: string): Promise<void> {
  const by = performance.now() + 5000;
  while (!done()) {
    if (performance.now() > by) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const parsed = (url: string) => {
  const { pathname, search } = new URL(url, 'http://test');
  return { pathname, search };
};

/**
 * The fixture loads no stylesheet, so the few rules the map's geometry needs are written here, keyed
 * on data attributes and mirroring the component's classes. The real CSS is proved by the live check.
 */
const GEOMETRY = `
  body { margin: 0; }
  [data-map-stage] { position: relative; overflow: hidden; margin: 0 24px; }
  [data-map-world], [data-map-world] > svg, [data-map-group], [data-card] { position: absolute; }
  [data-map-world], [data-map-world] > svg { top: 0; left: 0; }
  [data-map-world] > svg, [data-map-group] { pointer-events: none; }
  [data-map-details] { position: absolute; overflow-y: auto; z-index: 10; }
  [data-map-controls] { position: absolute; right: 12px; bottom: 12px; display: flex; }
  [data-map-hint] { position: absolute; left: 12px; bottom: 12px; pointer-events: none; }
`;

let current: { router: ReturnType<typeof createMemoryRouter>; unmount: () => void } | undefined;

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const stage = () => q('[data-map-stage]');
const card = (id: string) => q(`[data-card="${id}"]`) as HTMLElement;

export const state = () => ({
  view: stage()?.dataset.view ?? null,
  search: current?.router.state.location.search ?? null,
  selected: q('[data-card][data-selected]')?.dataset.card ?? null,
  flashed: [...document.querySelectorAll('[data-card].animate-map-hit')].map(
    (el) => (el as HTMLElement).dataset.card,
  ),
});

const rect = (el: Element | null) => {
  if (!el) return null;
  const { left, top, right, bottom } = el.getBoundingClientRect();
  return { left, top, right, bottom };
};

/**
 * The map as the person sees it: the frame, the cards and the details panel as measured rects, and
 * the camera as the world's inline transform (the computed one is mid-transition while it moves).
 */
export const geometry = () => {
  const world = q('[data-map-world]') as HTMLElement;
  const [x = 0, y = 0, k = 1] = (world.style.transform.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(
    Number,
  );
  return {
    stage: rect(stage()),
    camera: { x, y, k },
    transition: world.style.transition,
    cards: Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-card]')].map((el) => [
        el.dataset.card,
        rect(el),
      ]),
    ),
    details: rect(q('[data-map-details]')),
    selected: state().selected,
  };
};

/** Mounts the map at `url`, in a column `width` px wide when given, and waits until it is placed. */
export async function mount(url: string, historyState?: unknown, width?: number) {
  current?.unmount();
  if (!document.querySelector('style[data-map-geometry]')) {
    const style = document.createElement('style');
    style.dataset.mapGeometry = '';
    style.textContent = GEOMETRY;
    document.head.append(style);
  }
  const router = createMemoryRouter([{ path: '/f/:factory', element: <Screen /> }], {
    initialEntries: [{ ...parsed(url), state: historyState }],
  });
  const container = document.createElement('div');
  if (width !== undefined) container.style.width = `${width}px`;
  document.body.append(container);
  const root = createRoot(container);
  root.render(<RouterProvider router={router} />);
  current = {
    router,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
  await until(() => q('[data-map-stage][data-placed]') !== null, 'the map to be placed');
  return state();
}

export const waitFor = (view: string) =>
  until(() => stage()?.dataset.view === view, `view ${view}`).then(state);

export const waitFlash = (id: string) =>
  until(() => state().flashed.includes(id), `${id} to flash`).then(state);

export const click = (selector: string) => q(selector)?.click();
export const dblclick = (id: string) => {
  card(id).click();
  card(id).click();
  card(id).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
};
export const enter = (id: string) =>
  card(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
export const key = (name: string) =>
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
export const back = () => current?.router.navigate(-1);
