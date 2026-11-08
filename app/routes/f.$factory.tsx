import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { WaitingOnYou } from '../components/Decisions';

export default function Attention(): ReactElement {
  const { factory } = useParams();
  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-6 py-6">
      <WaitingOnYou factory={factory} />
    </main>
  );
}
