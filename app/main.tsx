import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { type RouteModule, routesFromModules } from './routing';
import './styles.css';

const router = createBrowserRouter(
  routesFromModules(
    import.meta.glob<RouteModule>(['./routes/*.tsx', '!./routes/*.test.tsx'], { eager: true }),
  ),
);

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
