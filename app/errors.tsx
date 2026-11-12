import type { ReactElement } from 'react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { Column } from './components/Column';
import { EmptyState } from './components/EmptyState';
import { ROOT_ADDRESS } from './lib/places';

function HomeLink(): ReactElement {
  return (
    <Link to={ROOT_ADDRESS} className="text-sm text-accent hover:text-accent-hover">
      Go to home
    </Link>
  );
}

/** Any path no file in `routes/` serves. */
export function NotFound(): ReactElement {
  return (
    <Column className="px-6">
      <EmptyState title="Nothing is at this address." action={<HomeLink />} />
    </Column>
  );
}

/** Replaces React Router's developer error page, which uses colors outside the console tokens. */
export function RouteError(): ReactElement {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  return (
    <Column className="px-6">
      <EmptyState title="This page failed to load." action={<HomeLink />} />
    </Column>
  );
}
