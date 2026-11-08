import type { ReactNode } from 'react';

/** The Manager's note: the "A" avatar and a line, with its key facts in the caller's `<b>`. */
export function ManagerNote({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[20px_1fr] gap-2.5 text-[length:var(--v3-t-body)] leading-[1.55] text-[color:var(--v3-fg)]">
      <span
        aria-hidden="true"
        className="grid size-5 place-items-center rounded-[5px] border border-[color:var(--v3-you-line)] bg-[var(--v3-you-wash)] font-mono text-[length:var(--v3-t-micro)] font-semibold text-[color:var(--v3-you-2)]"
      >
        A
      </span>
      <div>{children}</div>
    </div>
  );
}
