import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatCost, formatCount } from '../lib/format';
import { lapHref } from '../lib/one-lap';
import {
  RUN_CHIPS,
  RUNS_PAGE_SIZE,
  type RunRow,
  type RunsFilter,
  type RunsRow,
  runsArgs,
  runsView,
  stopLine,
  subLine,
  took,
} from '../lib/runs';
import { STATES, stateInk } from '../lib/states';
import { LivePanel } from '../live/LivePanel';
import { PanelBody, useNow } from './panel';
import { Chip } from './ui/Chip';
import { StateDot } from './ui/StateDot';

const SEARCH_DEBOUNCE_MS = 300;

/** The columns of a run: what it is and why it stopped, the item, took and cost. */
const COLUMNS =
  'grid grid-cols-[minmax(0,1fr)_auto] min-[761px]:grid-cols-[minmax(0,1fr)_72px_72px_80px]';

const NUMBER = 'font-mono text-[length:var(--v3-t-meta)] tabular-nums text-right';

/** Everything the page's address says about what to show; a value it cannot read falls back to the default. */
function filterOf(params: URLSearchParams): RunsFilter {
  const state = params.get('state');
  const page = Number.parseInt(params.get('page') ?? '', 10);
  return {
    q: params.get('q') ?? '',
    state: STATES.find((s) => s === state) ?? '',
    hideIdle: params.get('idle') !== 'show',
    page: page >= 1 ? page : 1,
  };
}

/** Every run of the factory, newest first, one page of it, with the chips' counts from the same query. */
export function Runs({ factory }: { factory: string | undefined }): ReactElement {
  const [params, setParams] = useSearchParams();
  const filter = filterOf(params);
  const [draft, setDraft] = useState(filter.q);

  const change = (next: Partial<RunsFilter>) => {
    const to = { ...filter, page: 1, ...next };
    const query = new URLSearchParams();
    if (to.q !== '') query.set('q', to.q);
    if (to.state !== '') query.set('state', to.state);
    if (!to.hideIdle) query.set('idle', 'show');
    if (to.page > 1) query.set('page', String(to.page));
    setParams(query);
  };

  // The address follows the box after a pause, so a run of keystrokes is one search.
  useEffect(() => setDraft(filter.q), [filter.q]);
  useEffect(() => {
    if (draft === filter.q) return;
    const timer = setTimeout(() => change({ q: draft }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  return (
    <LivePanel<RunsRow> query="runs" factory={factory} args={runsArgs(filter)}>
      {(rows, state) => {
        const view = rows === undefined ? undefined : runsView(rows);
        return (
          <>
            <RunFilters
              counts={view?.counts}
              filter={filter}
              draft={draft}
              onDraft={setDraft}
              onChange={change}
            />
            <PanelBody rows={view?.runs} state={state} factory={factory} what="runs">
              {(runs, name) => (
                <>
                  <RunList runs={runs} factory={name} searching={filter.q !== ''} />
                  <Pager counts={view?.counts} filter={filter} onChange={change} />
                </>
              )}
            </PanelBody>
          </>
        );
      }}
    </LivePanel>
  );
}

/** The head: the title, the search, the chips with their counts and the idle-poll toggle. */
export function RunFilters({
  counts,
  filter,
  draft,
  onDraft,
  onChange,
}: {
  /** Undefined while the page's subscription seals: the counts show nothing, never the last filter's. */
  counts: RunsRow | undefined;
  filter: RunsFilter;
  draft: string;
  onDraft: (value: string) => void;
  onChange: (next: Partial<RunsFilter>) => void;
}): ReactElement {
  return (
    <div className="mb-4 grid gap-4">
      <div>
        <h1 className="text-[length:var(--v3-t-title)] font-bold text-[color:var(--v3-fg)]">
          Runs
        </h1>
        <p className="mt-1 text-[length:var(--v3-t-body)] text-[color:var(--v3-fg-2)]">
          Every queue and check, newest first. The counts and the rows come from the same query.
        </p>
      </div>
      <input
        type="search"
        aria-label="Search runs"
        placeholder="Search workflow, item, run id, error text"
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        className="w-full rounded-[var(--v3-radius-control)] border border-[color:var(--v3-line)] bg-[color:var(--v3-panel)] px-3 py-2 text-[length:var(--v3-t-body)] text-[color:var(--v3-fg)] placeholder:text-[color:var(--v3-fg-3)]"
      />
      <div className="flex flex-wrap items-center gap-2">
        {RUN_CHIPS.map((chip) => (
          <Chip
            key={chip.label}
            pressed={filter.state === chip.state}
            onClick={() => onChange({ state: chip.state })}
            count={counts?.[chip.count]}
            state={chip.state === '' ? undefined : chip.state}
          >
            {chip.label}
          </Chip>
        ))}
        <IdleToggle
          hidden={filter.hideIdle}
          count={counts?.idle_polls}
          onClick={() => onChange({ hideIdle: !filter.hideIdle })}
        />
      </div>
    </div>
  );
}

function IdleToggle({
  hidden,
  count,
  onClick,
}: {
  hidden: boolean;
  count: number | undefined;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={hidden}
      onClick={onClick}
      className="ml-auto inline-flex cursor-pointer items-center gap-2 bg-transparent text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)]"
    >
      <span
        aria-hidden="true"
        className="relative inline-block h-4 w-7 rounded-full"
        style={{ background: hidden ? 'var(--v3-you)' : 'var(--v3-line-2)' }}
      >
        <span
          className="absolute top-0.5 size-3 rounded-full bg-[color:var(--v3-fg)]"
          style={{ left: hidden ? '14px' : '2px' }}
        />
      </span>
      Hide idle polls{count === undefined ? '' : ` (${formatCount(count)})`}
    </button>
  );
}

/** The rows of one page, each opening its run. */
export function RunList({
  runs,
  factory,
  searching,
  now: fixed,
}: {
  runs: readonly RunRow[];
  factory: string;
  searching: boolean;
  /** A fixed clock, for tests; the screen uses the browser's. */
  now?: number;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  if (runs.length === 0) {
    return (
      <p className="text-[length:var(--v3-t-body)] text-[color:var(--v3-fg-2)]">
        {searching ? 'No run matches.' : 'No runs yet.'}
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-[var(--v3-radius-card)] border border-[color:var(--v3-line)] bg-[color:var(--v3-panel)]">
      <div
        className={`${COLUMNS} gap-x-4 border-b border-[color:var(--v3-line)] px-4 py-2 text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)]`}
      >
        <span>Workflow · what · why it stopped</span>
        <span className="text-right max-[760px]:hidden">Item</span>
        <span className="text-right">Took</span>
        <span className="text-right max-[760px]:hidden">Cost</span>
      </div>
      <ol>
        {runs.map((run) => (
          <RunItem key={run.run_id} run={run} factory={factory} now={now} />
        ))}
      </ol>
    </div>
  );
}

function RunItem({
  run,
  factory,
  now,
}: {
  run: RunRow;
  factory: string;
  now: number;
}): ReactElement {
  const sub = useMemo(() => subLine(run), [run]);
  const stop = stopLine(run);
  const duration = took(run, now);
  const cost = run.cost_usd === null ? null : formatCost(Number(run.cost_usd));
  const item = run.issue_number === null ? '-' : `#${run.issue_number}`;
  return (
    <li className="border-b border-[color:var(--v3-line)] last:border-b-0">
      <Link
        to={lapHref(factory, run.run_id)}
        data-run={run.run_id}
        data-state={run.state}
        data-step={run.stop_step ?? run.step_id ?? undefined}
        data-stop={stop ?? undefined}
        data-cost={run.cost_usd ?? undefined}
        data-idle-poll={run.idle_poll ? '' : undefined}
        className={`${COLUMNS} items-start gap-x-4 gap-y-1 px-4 py-3 hover:bg-[color:var(--v3-raised)]`}
      >
        <span className="flex min-w-0 items-start gap-3">
          <span className="mt-1.5">
            <StateDot state={run.state} />
          </span>
          <span className="min-w-0">
            <span className="block font-mono text-[length:var(--v3-t-body)] font-bold text-[color:var(--v3-fg)] [overflow-wrap:anywhere]">
              {run.workflow_name}
            </span>
            {sub === '' ? null : (
              <span className="block font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)] [overflow-wrap:anywhere]">
                {sub}
                <span className="min-[761px]:hidden">{` · ${item}`}</span>
              </span>
            )}
            {stop === null ? null : (
              <span
                className="mt-0.5 block text-[length:var(--v3-t-meta)] [overflow-wrap:anywhere]"
                style={{ color: stateInk(run.state) }}
              >
                {stop}
              </span>
            )}
          </span>
        </span>
        <span className={`${NUMBER} text-[color:var(--v3-fg-2)] max-[760px]:hidden`}>{item}</span>
        <span className={`${NUMBER} text-[color:var(--v3-fg-2)] max-[760px]:row-span-2`}>
          {duration ?? '-'}
          <span className="block min-[761px]:hidden">{cost ?? '-'}</span>
        </span>
        <span className={`${NUMBER} text-[color:var(--v3-fg-2)] max-[760px]:hidden`}>
          {cost ?? '-'}
        </span>
      </Link>
    </li>
  );
}

function Pager({
  counts,
  filter,
  onChange,
}: {
  counts: RunsRow | undefined;
  filter: RunsFilter;
  onChange: (next: Partial<RunsFilter>) => void;
}): ReactElement | null {
  const chip = RUN_CHIPS.find((c) => c.state === filter.state);
  const total = counts && chip ? counts[chip.count] : 0;
  if (total <= RUNS_PAGE_SIZE) return null;
  const first = (filter.page - 1) * RUNS_PAGE_SIZE + 1;
  const last = Math.min(total, filter.page * RUNS_PAGE_SIZE);
  const button = 'cursor-pointer bg-transparent text-[color:var(--v3-fg-2)] disabled:opacity-40';
  return (
    <nav
      aria-label="Pages"
      className="mt-3 flex items-center justify-end gap-4 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]"
    >
      <button
        type="button"
        className={button}
        disabled={filter.page <= 1}
        onClick={() => onChange({ page: filter.page - 1 })}
      >
        Newer
      </button>
      <span className="font-mono tabular-nums">
        {formatCount(first)}–{formatCount(last)} of {formatCount(total)}
      </span>
      <button
        type="button"
        className={button}
        disabled={last >= total}
        onClick={() => onChange({ page: filter.page + 1 })}
      >
        Older
      </button>
    </nav>
  );
}
