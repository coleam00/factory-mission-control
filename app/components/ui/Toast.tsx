import type { ReactNode } from 'react';
import { Button } from './Button';

/** A confirmation with Undo. It runs no timer: what Undo does is the caller's. */
export function Toast({ children, onUndo }: { children: ReactNode; onUndo: () => void }) {
  return (
    <div
      role="status"
      className="fixed bottom-[22px] left-1/2 flex -translate-x-1/2 items-center gap-3.5 rounded-[9px] border border-[color:var(--v3-line-2)] bg-[var(--v3-raised)] px-3.5 py-2.5 shadow-[0_8px_30px_var(--v3-sunk)]"
    >
      <span className="text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg)]">{children}</span>
      <span className="h-[3px] w-[120px] bg-[var(--v3-line)]">
        <span
          className="block h-full bg-[var(--v3-you)]"
          style={{ animation: 'v3-toast-bar 5s linear forwards' }}
        />
      </span>
      <Button variant="text" onClick={onUndo}>
        Undo
      </Button>
    </div>
  );
}
