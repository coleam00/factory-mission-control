import type { ReactElement } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';
import { isSwitched } from '../components/FactorySwitcher';
import { Scorecard } from '../components/Scorecard';

export default function ScorecardScreen(): ReactElement {
  const [search] = useSearchParams();
  const { state } = useLocation();
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <Scorecard
        factory={useParams().factory}
        a={search.get('a') ?? undefined}
        b={search.get('b') ?? undefined}
        switched={isSwitched(state)}
      />
    </main>
  );
}
