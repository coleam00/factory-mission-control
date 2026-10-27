import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { LapChecks, LapHeader, LapSteps } from '../components/OneLap';

export default function Lap(): ReactElement {
  const { factory, runId = '' } = useParams();
  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-6 py-6">
      <LapHeader factory={factory} runId={runId} />
      <LapSteps factory={factory} runId={runId} />
      <LapChecks factory={factory} runId={runId} />
    </main>
  );
}
