import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';
import { NotFound, RouteError } from './errors';

export interface RouteModule {
  default: ComponentType;
}

/**
 * One route per file in `routes/`: `index.tsx` serves `/`, `<name>.tsx` serves `/<name>`.
 * Keys are module paths as `import.meta.glob` returns them.
 */
export function routesFromModules(modules: Record<string, RouteModule>): RouteObject[] {
  return Object.entries(modules).map(([file, module]) => {
    const name = file.replace(/^.*\//, '').replace(/\.tsx$/, '');
    return { path: name === 'index' ? '/' : `/${name}`, Component: module.default };
  });
}

/** The router's whole tree: the directory's routes, a not-found catch-all and an error state. */
export function appRoutes(modules: Record<string, RouteModule>): RouteObject[] {
  return [
    {
      ErrorBoundary: RouteError,
      children: [...routesFromModules(modules), { path: '*', Component: NotFound }],
    },
  ];
}
