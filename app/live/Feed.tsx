import { type ReactElement, useEffect } from 'react';
import { LivePanel, type PanelState } from './LivePanel';

/** A live query's rows and state, handed up from the panel that reads them. */
export interface Source<Row> {
  rows: readonly Row[] | undefined;
  state: PanelState;
}

/** A source whose query has not answered yet. */
export const AWAITED = { rows: undefined, state: 'loading' } as const;

/** Hands a panel's rows and state up, so the panel never wraps the screen and remounts it. */
function Report<Row>({
  rows,
  state,
  into,
}: Source<Row> & { into: (source: Source<Row>) => void }): null {
  useEffect(() => into({ rows, state }), [rows, state, into]);
  return null;
}

export function Feed<Row>({
  query,
  factory,
  args,
  into,
}: {
  query: string;
  factory: string | undefined;
  args?: readonly string[];
  into: (source: Source<Row>) => void;
}): ReactElement {
  return (
    <LivePanel<Row> query={query} factory={factory} args={args}>
      {(rows, state) => <Report rows={rows} state={state} into={into} />}
    </LivePanel>
  );
}
