import type { ReactElement } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { EmptyState } from './components/EmptyState';

function HomeLink(): ReactElement {
  return (
    <Link to="/" className="text-sm text-accent hover:text-accent-hover">
      Go to home
    </Link>
  );
}

/** Any path no file in `routes/` serves. */
export function NotFound(): ReactElement {
  return (
    <main className="mx-auto max-w-6xl px-6">
      <EmptyState title="Nothing is at this address." action={<HomeLink />} />
    </main>
  );
}

/** Replaces React Router's developer error page, which uses colors outside the console tokens. */
export function RouteError(): ReactElement {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  return (
    <main className="mx-auto max-w-6xl px-6">
      <EmptyState title="This page failed to load." action={<HomeLink />} />
    </main>
  );
}
