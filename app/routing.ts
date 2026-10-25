import type { ComponentType } from 'react';
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

/**
 * The router's whole tree: the shell around the directory's routes, a not-found catch-all and an
 * error state.
 */
export function appRoutes(modules: Record<string, RouteModule>): RouteObject[] {
  return [
    {
      Component: Shell,
      ErrorBoundary: RouteError,
      children: [...routesFromModules(modules), { path: '*', Component: NotFound }],
    },
  ];
}
