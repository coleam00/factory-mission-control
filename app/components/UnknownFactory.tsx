import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { EmptyState } from './EmptyState';

/**
 * A factory screen whose URL key is not a factory (#79): it names the key as typed, so a mistyped
 * or stale URL never reads as a live-data outage, and links to the default factory's map.
 */
export function UnknownFactory({
  factory,
  fallback,
}: {
  factory: string;
  /** The default factory, once the server's configuration is in. */
  fallback: string | undefined;
}): ReactElement {
  const home = fallback === undefined ? '/' : `/f/${encodeURIComponent(fallback)}`;
  return (
    <main
      data-unknown-factory={factory}
      className="mx-auto max-w-6xl px-6 [overflow-wrap:anywhere]"
    >
      <EmptyState
        title={`No factory is named "${factory}".`}
        hint="Choose a factory from the switcher above."
        action={
          <Link to={home} className="text-sm text-accent hover:text-accent-hover">
            {fallback === undefined ? 'Go to home' : `Go to ${fallback}'s map`}
          </Link>
        }
      />
    </main>
  );
}
