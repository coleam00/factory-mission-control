import type { ReactElement } from 'react';
import { Link } from 'react-router';
import { placeAddress, ROOT_ADDRESS } from '../lib/places';
import { EmptyState } from './EmptyState';
import { Column } from './Column';

/**
 * A factory screen whose URL key is not a factory (#79): it names the key as typed, so a mistyped
 * or stale URL never reads as a live-data outage, and links to the default factory's Attention. The
 * empty key (`/f/`) names no factory at all, so it says that and links home. One sentence and one
 * link, as every empty state is (#131); the switcher above still lists the real factories.
 */
export function UnknownFactory({
  factory,
  fallback,
}: {
  factory: string;
  /** The default factory, once the server's configuration is in. */
  fallback: string | undefined;
}): ReactElement {
  const target = factory === '' ? undefined : fallback;
  const home = target === undefined ? ROOT_ADDRESS : placeAddress(target, '');
  return (
    <Column data-unknown-factory={factory} className="px-6 [overflow-wrap:anywhere]">
      <EmptyState
        title={
          factory === ''
            ? 'No factory is named in this address.'
            : `No factory is named "${factory}".`
        }
        action={
          <Link to={home} className="text-sm text-accent hover:text-accent-hover">
            {target === undefined ? 'Go to home' : `Go to ${target}'s Attention`}
          </Link>
        }
      />
    </Column>
  );
}
