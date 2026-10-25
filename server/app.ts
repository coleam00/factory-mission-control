import { join, resolve, sep } from 'node:path';
import { Hono } from 'hono';

interface AppOptions {
  buildId: string;
  /** The built browser app: `index.html` plus its assets. */
  distDir: string;
}

export function createApp({ buildId, distDir }: AppOptions): Hono {
  const root = resolve(distDir);
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.get('/api/build-id', (c) => c.text(buildId));
  app.all('/api/*', (c) => c.notFound());

  // Every other GET is either a built asset or a client-side route the app's router resolves.
  app.get('*', async (c) => {
    const asset = resolve(root, `.${c.req.path}`);
    if (asset.startsWith(root + sep)) {
      const file = Bun.file(asset);
      if (await file.exists()) return new Response(file);
    }
    return new Response(Bun.file(join(root, 'index.html')));
  });

  return app;
}
