import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';

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
