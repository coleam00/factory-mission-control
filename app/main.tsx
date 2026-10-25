import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { appRoutes, type RouteModule } from './routing';
import './styles.css';

const router = createBrowserRouter(
  appRoutes(
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
