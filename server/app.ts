import { join, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { type Live, liveBootScript, liveRoutes } from './live';

interface AppOptions {
  buildId: string;
  /** The built browser app: `index.html` plus its assets. */
  distDir: string;
  /** Absent when the environment holds no Realtime configuration: the live routes answer 503. */
  live?: Live;
}

export function createApp({ buildId, distDir, live }: AppOptions): Hono {
  const root = resolve(distDir);
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.get('/api/build-id', (c) => c.text(buildId));
  liveRoutes(app, live);
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
    const html = (await index.text()).replace('<head>', `<head>${liveBootScript(live)}`);
    return c.html(html);
  });

  return app;
}
