import { type ReactElement, useEffect } from 'react';
import { LivePanel, type PanelState } from './LivePanel';

/** A screen's state over its sources: any error is an error, ready once every source is. */
export function overall(states: readonly PanelState[]): PanelState {
  if (states.includes('error')) return 'error';
  return states.every((s) => s === 'ready') ? 'ready' : 'loading';
}

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
  name,
  into,
}: {
  query: string;
  factory: string | undefined;
  args?: readonly string[];
  /** The panel's name where a second reader of the query must not be taken for the first (`LivePanel`). */
  name?: string;
  into: (source: Source<Row>) => void;
}): ReactElement {
  return (
    <LivePanel<Row> query={query} name={name} factory={factory} args={args}>
      {(rows, state) => <Report rows={rows} state={state} into={into} />}
    </LivePanel>
  );
}
