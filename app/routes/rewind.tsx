import type { ReactElement } from 'react';
import { RewindBranches } from '../components/RewindList';
import { useFactory } from '../live/FactoryProvider';
import { useLive } from '../live/LiveProvider';

export default function Rewind(): ReactElement {
  const live = useLive();
  return (
    <main className="mx-auto max-w-6xl px-6 py-6">
      <RewindBranches factory={useFactory()} shown={live.status === 'ready' ? live.rewind : null} />
    </main>
  );
}
