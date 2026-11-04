import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { DecisionsHealth, WaitingOnYou } from '../components/Decisions';

export default function Decisions(): ReactElement {
  const { factory } = useParams();
  return (
    <main data-v1-screen="decisions" className="mx-auto grid max-w-6xl gap-8 px-6 py-6">
      <WaitingOnYou factory={factory} />
      <DecisionsHealth factory={factory} />
    </main>
  );
}
