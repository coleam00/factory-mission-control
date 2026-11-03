import type { ReactElement } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Changes } from '../components/Changes';
import { pairSearch } from '../lib/changes';

export default function ChangesScreen(): ReactElement {
  const [search, setSearch] = useSearchParams();
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <Changes
        factory={useParams().factory}
        a={search.get('a')}
        b={search.get('b')}
        // Picking is not a place to go Back to.
        onPick={(pair) => setSearch((was) => pairSearch(was, pair), { replace: true })}
      />
    </main>
  );
}
