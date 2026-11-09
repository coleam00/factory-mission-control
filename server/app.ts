import { join, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { type Actions, actionsRoutes } from './actions';
import { type Live, liveBootScript, liveConfig, liveRoutes } from './live';
import { type Manager, managerRoutes } from './manager';

interface AppOptions {
  buildId: string;
  /** The built browser app: `index.html` plus its assets. */
  distDir: string;
  /** Absent when the environment holds no Realtime configuration: the live routes answer 503. */
  live?: Live;
  /** Absent without MC_DATABASE_URL: the Manager routes answer 503. */
  manager?: Manager;
  /** Absent without MC_DATABASE_URL: no action is offered and the POST answers 503. */
  actions?: Actions;
}

export function createApp({ buildId, distDir, live, manager, actions }: AppOptions): Hono {
  const root = resolve(distDir);
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.get('/api/build-id', (c) => c.text(buildId));
  liveRoutes(app, live);
  managerRoutes(app, manager);
  actionsRoutes(app, actions);
  app.all('/api/*', (c) => c.notFound());

  // Every other GET is either a built asset or a client-side route the app's router resolves.
  app.get('*', async (c) => {
    const asset = resolve(root, `.${c.req.path}`);
    if (asset.startsWith(root + sep)) {
      const file = Bun.file(asset);
      if (await file.exists()) return new Response(file);
    }
    const index = Bun.file(join(root, 'index.html'));
    if (!live) return new Response(index);
    const html = (await index.text()).replace(
      '<head>',
      `<head>${liveBootScript(liveConfig(live))}`,
    );
    return c.html(html);
  });

  return app;
}
