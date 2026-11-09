import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { Runs as RunsScreen } from '../components/Runs';

export default function Runs(): ReactElement {
  const { factory } = useParams();
  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-6 py-6">
      <RunsScreen factory={factory} />
    </main>
  );
}
