import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { DecisionsTimeline, ImprovementsLedger } from '../components/DecisionsLedger';

export default function Decisions(): ReactElement {
  const { factory } = useParams();
  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-6 py-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <DecisionsTimeline factory={factory} />
      <ImprovementsLedger factory={factory} />
    </main>
  );
}
