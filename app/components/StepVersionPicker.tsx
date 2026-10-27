import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';
import { type StepVersionRow, stepHref, stepVersions } from '../lib/step-detail';
import { LivePanel, type PanelState } from '../live/LivePanel';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const NOTE = 'px-3 py-2 text-sm text-text-secondary';

function Entries({
  rows,
  state,
  at,
  workflow,
  path,
  onChoose,
}: {
  rows: readonly StepVersionRow[] | undefined;
  state: PanelState;
  at: string | null;
  workflow: string;
  path: string;
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
              to={stepHref(workflow, path, version.current ? null : version.sha)}
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
 * The step screen's version choice: the version shown, and when open every version with
 * architecture, newest first, each opening this step at it. The current one opens the address
 * without a version, so it follows the next pin live.
 */
export function StepVersionPickerBody({
  rows,
  state,
  at,
  workflow,
  path,
  open,
  onToggle,
}: {
  rows: readonly StepVersionRow[] | undefined;
  state: PanelState;
  /** The pin the address names, or null for the current version. */
  at: string | null;
  workflow: string;
  path: string;
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
          <Entries
            rows={rows}
            state={state}
            at={at}
            workflow={workflow}
            path={path}
            onChoose={() => onToggle(false)}
          />
        </div>
      ) : null}
    </details>
  );
}

/** The versions of `step-versions.sql`, live, as the step screen's version choice. */
export function StepVersionPicker({
  factory,
  at,
  workflow,
  path,
}: {
  factory: string | undefined;
  at: string | null;
  workflow: string;
  path: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <LivePanel<StepVersionRow> query="step-versions" factory={factory} className="mb-6">
      {(rows, state) => (
        <StepVersionPickerBody
          rows={rows}
          state={state}
          at={at}
          workflow={workflow}
          path={path}
          open={open}
          onToggle={setOpen}
        />
      )}
    </LivePanel>
  );
}
