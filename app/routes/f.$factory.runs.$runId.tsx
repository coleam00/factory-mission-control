import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { isRunId, NoRun, OneRun } from '../components/OneRun';

export default function Run(): ReactElement {
  const { factory, runId = '' } = useParams();
  // An address that is not a run id names no run: no query could find one, so none is asked.
  if (!isRunId(runId)) {
    return (
      <main className="mx-auto grid max-w-6xl gap-8 px-6 py-6">
        <NoRun runId={runId} />
      </main>
    );
  }
  // Wide enough for the loop's graph and the step panel beside it.
  return (
    <main className="mx-auto grid max-w-[1840px] gap-8 px-6 py-6">
      <OneRun factory={factory} runId={runId} />
    </main>
  );
}
