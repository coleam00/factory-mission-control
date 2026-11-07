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

/** Mounts the map at `url` and waits until its camera is placed. */
export async function mount(url: string, historyState?: unknown) {
  current?.unmount();
  const router = createMemoryRouter([{ path: '/f/:factory', element: <Screen /> }], {
    initialEntries: [{ ...parsed(url), state: historyState }],
  });
  const container = document.createElement('div');
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
