import { type ComponentType, createElement } from 'react';
import type { RouteObject } from 'react-router';
import { NotFound, RouteError } from './errors';
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

/** A factory screen the shell links to: its path after `/f/:factory/` and its link's name. */
export interface FactoryScreen {
  path: string;
  label: string;
}

/**
 * The factory screens among the routes: every `/f/:factory/...` path with no other parameter, so a
 * screen that needs a step or a lap is left out. Labels come from the path (`versions` is
 * "Versions"), so adding a route file adds its link with no edit to the shell.
 */
export function factoryScreens(routes: readonly RouteObject[]): FactoryScreen[] {
  const screens: FactoryScreen[] = [];
  for (const { path } of routes) {
    const rest = path?.match(/^\/f\/:factory\/(.+)$/)?.[1];
    if (rest === undefined || rest.includes(':')) continue;
    const label = rest
      .split('/')
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ');
    screens.push({ path: rest, label });
  }
  return screens.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Where choosing `factory` goes from `pathname`: the same screen for it when `pathname` is one of
 * `screens`, otherwise its home map (`/f/:factory`). Pass the pathname only: a screen's search
 * names the old factory's versions.
 */
export function factoryPath(
  pathname: string,
  factory: string,
  screens: readonly FactoryScreen[],
): string {
  const home = `/f/${encodeURIComponent(factory)}`;
  const rest = pathname.match(/^\/f\/[^/]+\/(.+)$/)?.[1];
  return screens.some((screen) => screen.path === rest) ? `${home}/${rest}` : home;
}

/**
 * The router's whole tree: the shell, linking every factory screen, around the directory's routes,
 * a not-found catch-all and an error state.
 */
export function appRoutes(modules: Record<string, RouteModule>): RouteObject[] {
  const routes = routesFromModules(modules);
  return [
    {
      element: createElement(Shell, { screens: factoryScreens(routes) }),
      ErrorBoundary: RouteError,
      children: [...routes, { path: '*', Component: NotFound }],
    },
  ];
}
