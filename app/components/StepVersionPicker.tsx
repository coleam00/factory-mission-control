import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';
import { type StepVersionRow, stepVersions } from '../lib/step-detail';
import { LivePanel, type PanelState } from '../live/LivePanel';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const NOTE = 'px-3 py-2 text-sm text-text-secondary';

function Entries({
  rows,
  state,
  at,
  href,
  onChoose,
}: {
  rows: readonly StepVersionRow[] | undefined;
  state: PanelState;
  at: string | null;
  href: (at: string | null) => string;
  onChoose: () => void;
}): ReactElement {
  if (state === 'error') return <p className={NOTE}>Live data is unavailable.</p>;
  if (rows === undefined) return <p className={NOTE}>Loading versions.</p>;
  if (rows.length === 0) return <p className={NOTE}>No version with architecture is recorded.</p>;
  return (
    <ul className="flex flex-col py-1">
      {stepVersions(rows).map((version) => {
        const shown = at === null ? version.current : version.sha === at;
        return (
          <li key={version.sha} data-version-entry={version.sha}>
            <Link
              to={href(version.current ? null : version.sha)}
              onClick={onChoose}
              title={version.reason}
              aria-current={shown ? 'true' : undefined}
              className={`flex items-center justify-between gap-6 px-3 py-1.5 font-mono text-sm tabular-nums hover:bg-surface-inset ${
                shown ? 'text-text-primary' : 'text-text-secondary'
              }`}
            >
              <span>{version.label}</span>
              {version.current ? <span>current</span> : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A screen's version choice: the version shown, and when open every version with architecture,
 * newest first, each opening the screen at it. The current one opens the address without a
 * version, so it follows the next pin live.
 */
export function StepVersionPickerBody({
  rows,
  state,
  at,
  href,
  open,
  onToggle,
}: {
  rows: readonly StepVersionRow[] | undefined;
  state: PanelState;
  /** The pin the address names, or null for the current version. */
  at: string | null;
  /** The screen's address at a version's pin, or at the current version for null. */
  href: (at: string | null) => string;
  open: boolean;
  onToggle: (open: boolean) => void;
}): ReactElement {
  const versions = stepVersions(rows ?? []);
  const shown = versions.find((version) => (at === null ? version.current : version.sha === at));
  const name = shown ? `${shown.label}${shown.current ? ' current' : ''}` : (at ?? '-');
  return (
    <details
      data-step-version=""
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="relative"
    >
      <summary className="flex cursor-pointer items-center gap-3">
        <span className={LABEL}>Version</span>
        <span className="font-mono text-sm tabular-nums text-text-primary [overflow-wrap:anywhere]">
          {name}
        </span>
      </summary>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-2 min-w-64 rounded-md border border-border bg-surface">
          <Entries rows={rows} state={state} at={at} href={href} onChoose={() => onToggle(false)} />
        </div>
      ) : null}
    </details>
  );
}

/** The versions of `step-versions.sql`, live, as a screen's version choice. */
export function StepVersionPicker({
  factory,
  at,
  href,
}: {
  factory: string | undefined;
  at: string | null;
  href: (at: string | null) => string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <LivePanel<StepVersionRow> query="step-versions" factory={factory} className="mb-6">
      {(rows, state) => (
        <StepVersionPickerBody
          rows={rows}
          state={state}
          at={at}
          href={href}
          open={open}
          onToggle={setOpen}
        />
      )}
    </LivePanel>
  );
}
