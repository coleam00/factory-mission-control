import { createRoot } from 'react-dom/client';
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router';
import { FACTORY_MAP } from '../../map/factory-map';
import { FactoryMap } from '../FactoryMap';
import { FlowProvider, FlowToggle, useFlow } from '../FlowToggle';
import { useMapPath } from '../useMapPath';

/** The header bar as `Shell` lays it out: the toggle sits in the provider, outside the routes. */
function Bar() {
  return (
    <FlowProvider>
      <header>
        <Link to="/f/x">Factory</Link>
        <Link to="/f/x/board">Board</Link>
        <FlowToggle />
      </header>
      <Outlet />
    </FlowProvider>
  );
}

/** The map as `Home` wires it to the toggle. */
function Home() {
  const [path, onPath] = useMapPath(FACTORY_MAP);
  const { flow, setDrawn } = useFlow();
  return (
    <FactoryMap
      map={FACTORY_MAP}
      live={new Map()}
      factory="x"
      at={null}
      flow={flow}
      onDrawn={setDrawn}
      path={path}
      onPath={onPath}
      steps={undefined}
    />
  );
}

let current: { unmount: () => void } | undefined;

/** Mounts the bar and its routes at `url` and waits until the router has rendered. */
export async function mount(url: string) {
  current?.unmount();
  const router = createMemoryRouter(
    [
      {
        element: <Bar />,
        children: [
          { path: '/f/:factory', element: <Home /> },
          { path: '/f/:factory/board', element: <p>Board</p> },
        ],
      },
    ],
    { initialEntries: [url] },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  root.render(<RouterProvider router={router} />);
  current = {
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

export const shown = () => ({
  toggle: document.querySelector('header button[aria-label="Flow animation"]') !== null,
  flow: document.querySelector<HTMLElement>('[data-map-stage]')?.dataset.flow ?? null,
});

export const clickToggle = () =>
  document.querySelector<HTMLButtonElement>('header button[aria-label="Flow animation"]')?.click();

export const goBoard = () => {
  const link = [...document.querySelectorAll<HTMLAnchorElement>('header a')].find(
    (a) => a.textContent === 'Board',
  );
  link?.click();
};
