import type { ReactNode } from 'react';
import { stateInk } from '../../lib/states';

/** A failed step's error, with the actions that answer it. */
export function ErrorPanel({
  title,
  error,
  actions,
}: {
  title: string;
  error: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mt-2 grid gap-2.5 rounded-[9px] border border-[color:var(--v3-failed-line)] bg-[var(--v3-failed-wash)] px-3.5 py-3">
      <div
        className="text-[length:var(--v3-t-meta)] font-semibold"
        style={{ color: stateInk('failed') }}
      >
        {title}
      </div>
      <pre className="m-0 overflow-x-auto rounded-[var(--v3-radius-control)] border border-[color:var(--v3-failed-line)] bg-[var(--v3-sunk)] px-3 py-2 font-mono text-[length:var(--v3-t-meta)] whitespace-pre-wrap text-[color:var(--v3-fg-2)]">
        {error}
      </pre>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}
