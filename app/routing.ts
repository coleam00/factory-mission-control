import { type ComponentType, createElement } from 'react';
import {
  type LoaderFunction,
  Navigate,
  type RouteObject,
  redirect,
  useParams,
  useSearchParams,
} from 'react-router';
import { EmptyState } from './components/EmptyState';
import { NotFound, RouteError } from './errors';
import { homeHref } from './lib/home-map';
import { lapHref } from './lib/one-lap';
import { PLACES, type PlacePath, placeAddress } from './lib/places';
import { stepHref } from './lib/step-detail';
import { useFactory } from './live/FactoryProvider';
import { useLive } from './live/LiveProvider';
import { FROM_PARAM, VIEW_PARAM } from './map/factory-map';
import { Shell } from './Shell';

export interface RouteModule {
  default: ComponentType;
}

/**
 * A route file's path from its name: `index` is `/`; otherwise `.` separates segments and a `$name`
 * segment is the parameter `:name`, so `f.$factory.versions` is `/f/:factory/versions`.
 */
export function routePath(name: string): string {
  if (name === 'index') return '/';
  const segments = name.split('.');
  if (segments.some((segment) => segment === '' || segment === '$')) {
    throw new Error(`route file "${name}.tsx" has an empty path segment`);
  }
  return `/${segments.map((segment) => (segment.startsWith('$') ? `:${segment.slice(1)}` : segment)).join('/')}`;
}

/**
 * One route per file in `routes/`, at the path its name encodes (`routePath`). Two files that map
 * to the same path are refused. Keys are module paths as `import.meta.glob` returns them.
 */
export function routesFromModules(modules: Record<string, RouteModule>): RouteObject[] {
  const fileByPath = new Map<string, string>();
  return Object.entries(modules).map(([file, module]) => {
    const path = routePath(file.replace(/^.*\//, '').replace(/\.tsx$/, ''));
    // Parameter names do not change which URLs match: `/f/:a` and `/f/:b` are the same path.
    const shape = path.replace(/:[^/]*/g, ':');
    const other = fileByPath.get(shape);
    if (other !== undefined) {
      throw new Error(`route files ${other} and ${file} both serve ${path}`);
    }
    fileByPath.set(shape, file);
    return { path, Component: module.default };
  });
}

/**
 * Where choosing `factory` goes from `pathname` and its `search`: the same place for it when
 * `pathname` is one of `PLACES`, Runs from a run's page, a step's page as it is (the pinned version stays), otherwise its
 * home, Attention (`/f/:factory`). A place's search names the old factory's items, so it is not kept.
 */
const RUN_PAGE = new RegExp(`^/f/[^/]+/${'runs' satisfies PlacePath}/[^/]+$`);

export function factoryPath(pathname: string, factory: string, search = ''): string {
  const home = placeAddress(factory, '');
  if (RUN_PAGE.test(pathname)) return placeAddress(factory, 'runs');
  const step = pathname.match(/^\/f\/[^/]+\/(steps\/[^/]+\/[^/]+)$/)?.[1];
  if (step !== undefined) return `${home}/${step}${search}`;
  const rest = pathname.match(/^\/f\/[^/]+\/(.+)$/)?.[1];
  const paths: readonly string[] = PLACES.map((place) => place.path);
  if (rest === undefined || !paths.includes(rest)) return home;
  return `${home}/${rest}`;
}

/**
 * Where each removed screen's address goes now, under the same factory: a `PLACES` path, '' being
 * Attention. `laps/:runId` is not here, it carries the run id (`lapsRunRedirect`).
 */
export const REMOVED_SCREENS: Readonly<Record<string, PlacePath>> = {
  changes: 'map',
  decisions: '',
  diff: 'map',
  health: '',
  issues: 'board',
  ledger: '',
  owner: '',
  rewind: 'map',
  scorecard: 'map',
  testing: 'board',
  versions: 'map',
};

/** The redirect from a removed address to `to` (a `PLACES` path) under the same factory. */
const redirectTo =
  (to: PlacePath): LoaderFunction =>
  ({ params: { factory = '' } }) =>
    redirect(placeAddress(factory, to));

/** `laps/:runId`, to the run's page, whose address `lapHref` alone writes. */
const lapsRunRedirect: LoaderFunction = ({ params: { factory = '', runId = '' } }) =>
  redirect(lapHref(factory, runId));

/**
 * Where `/` goes: the map, with them, when the address carries an old map link's `at`, `view` or
 * `from`; otherwise the factory's Attention.
 */
export function homeAddressTarget(factory: string, search: URLSearchParams): string {
  const oldMapLink = ['at', VIEW_PARAM, FROM_PARAM].some((name) => search.has(name));
  return oldMapLink ? homeHref(factory, search.get('at'), search) : placeAddress(factory, '');
}

/**
 * `/`, which named no factory: the Attention of the factory the switcher remembers, else the default
 * one. A server that is ready and serves none has nowhere to go, so it says so (#215).
 */
export function HomeAddress(): ReturnType<typeof createElement> | null {
  const factory = useFactory();
  const live = useLive();
  const [search] = useSearchParams();
  if (factory === undefined) {
    return live.status === 'ready' && live.factories.length === 0
      ? createElement(EmptyState, { title: 'No factory is configured.' })
      : null;
  }
  return createElement(Navigate, { to: homeAddressTarget(factory, search), replace: true });
}

/**
 * A step's old address, `/steps/:workflow/:step`, which named no factory: the same step, at the same
 * `?at=`, in the factory the switcher remembers, else the default one.
 */
export function OldStepAddress(): ReturnType<typeof createElement> | null {
  const { workflow = '', step = '' } = useParams();
  const [search] = useSearchParams();
  const factory = useFactory();
  if (factory === undefined) return null;
  return createElement(Navigate, {
    to: stepHref(factory, workflow, step, search.get('at')),
    replace: true,
  });
}

const removedRoutes = (): RouteObject[] => [
  ...Object.entries(REMOVED_SCREENS).map(([from, to]) => ({
    path: `/f/:factory/${from}`,
    loader: redirectTo(to),
  })),
  { path: '/f/:factory/laps', loader: redirectTo('runs') },
  { path: '/f/:factory/laps/:runId', loader: lapsRunRedirect },
  { path: '/', element: createElement(HomeAddress) },
  { path: '/steps/:workflow/:step', element: createElement(OldStepAddress) },
  { path: '/rewind', element: createElement(Navigate, { to: '/', replace: true }) },
];

/**
 * The router's whole tree: the shell, with its fixed places, around the directory's routes, every
 * old address's redirect, a not-found catch-all and an error state.
 */
export function appRoutes(modules: Record<string, RouteModule>): RouteObject[] {
  const routes = routesFromModules(modules);
  return [
    {
      element: createElement(Shell),
      ErrorBoundary: RouteError,
      children: [...routes, ...removedRoutes(), { path: '*', Component: NotFound }],
    },
  ];
}
