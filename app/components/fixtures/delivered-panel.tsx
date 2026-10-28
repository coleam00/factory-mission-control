import type { ReactElement, ReactNode } from 'react';

export type PanelState = 'loading' | 'ready' | 'error';

/** What each query's panel delivers, set by the page that renders panels over this module. */
export const delivered: Record<string, { rows: readonly unknown[]; state: PanelState }> = {};

/** Stands in for `LivePanel`: hands its children the rows set for its query, at once. */
export function LivePanel<Row>({
  query,
  className,
  children,
}: {
  query: string;
  className?: string;
  children: (rows: readonly Row[] | undefined, state: PanelState) => ReactNode;
}): ReactElement {
  const { rows, state } = delivered[query] ?? { rows: [], state: 'ready' };
  return (
    <section data-live={query} data-state={state} className={className}>
      {children(rows as readonly Row[], state)}
    </section>
  );
}
