import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { isRunId, NoLap, OneLap } from '../components/OneLap';

export default function Lap(): ReactElement {
  const { factory, runId = '' } = useParams();
  // An address that is not a run id names no lap: no query could find one, so none is asked.
  if (!isRunId(runId)) {
    return (
      <main className="mx-auto grid max-w-6xl gap-8 px-6 py-6">
        <NoLap runId={runId} />
      </main>
    );
  }
  return (
    <main className="mx-auto grid max-w-6xl gap-8 px-6 py-6">
      <OneLap factory={factory} runId={runId} />
    </main>
  );
}
