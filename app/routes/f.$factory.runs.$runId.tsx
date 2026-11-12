import type { ReactElement } from 'react';
import { useParams } from 'react-router';
import { Column } from '../components/Column';
import { NoRun, OneRun } from '../components/OneRun';
import { isRunId } from '../lib/one-lap';

export default function Run(): ReactElement {
  const { factory, runId = '' } = useParams();
  // An address that is not a run id names no run: no query could find one, so none is asked.
  if (!isRunId(runId)) {
    return (
      <Column className="grid gap-8 px-6 py-6">
        <NoRun runId={runId} />
      </Column>
    );
  }
  // Wide enough for the loop's graph and the step panel beside it.
  return (
    <Column width="max-w-[1840px]" className="grid gap-8 px-6 py-6">
      <OneRun factory={factory} runId={runId} />
    </Column>
  );
}
