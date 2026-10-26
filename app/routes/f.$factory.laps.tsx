import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { Lanes, RecentLaps } from '../components/Lanes';

export default function Laps(): ReactElement {
  const { factory } = useParams();
  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-6 py-6">
      <Lanes factory={factory} />
      <RecentLaps factory={factory} />
    </main>
  );
}
