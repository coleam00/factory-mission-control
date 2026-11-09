import { join } from 'node:path';
import type { RouteModule } from './routing';

/** What main.tsx's `import.meta.glob` over `./routes/` yields, read from disk. */
export async function globRoutes(routesDir: string): Promise<Record<string, RouteModule>> {
  const modules: Record<string, RouteModule> = {};
  for (const file of new Bun.Glob('*.tsx').scanSync(routesDir)) {
    if (file.endsWith('.test.tsx')) continue;
    modules[`./routes/${file}`] = await import(join(routesDir, file));
  }
  return modules;
}
