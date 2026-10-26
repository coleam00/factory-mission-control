import type { ReactElement } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Scorecard } from '../components/Scorecard';

export default function ScorecardScreen(): ReactElement {
  const [search] = useSearchParams();
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <Scorecard
        factory={useParams().factory}
        a={search.get('a') ?? undefined}
        b={search.get('b') ?? undefined}
      />
    </main>
  );
}
