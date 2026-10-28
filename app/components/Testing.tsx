import { type ReactElement, type ReactNode, useId, useMemo } from 'react';
import { Link } from 'react-router';
import { shortRunId } from '../lib/format';
import { issueUrl } from '../lib/one-lap';
import {
  type CheckRow,
  type DefaultHoldoutRow,
  defaultBranch,
  type KindBar,
  kindBars,
  type Line,
  type RouteGrid as Grid,
  type RouteRow,
  routeGrid,
  type ScenarioTile,
  scenarioTiles,
  type VerdictTone,
  verdictTone,
} from '../lib/testing';
import { LivePanel, type PanelState } from '../live/LivePanel';
import { LABEL, MONO, PanelBody, utcMinute } from './Lanes';

const LINK = 'underline decoration-border-bright underline-offset-2 hover:decoration-text-primary';
const NOT_PICKED = 'not picked';

const lapPath = (factory: string, run: string) => `/f/${encodeURIComponent(factory)}/laps/${run}`;

/** Each tone's token: status colors only (teal success, red failed, amber unfinished). */
const TONE: Record<VerdictTone, `--${string}`> = {
  success: '--success',
  error: '--error',
  warning: '--warning',
  neutral: '--text-secondary',
};
const toneOf = (verdict: string) => `var(${TONE[verdictTone(verdict)]})`;
/** A token at `percent` opacity: the same color the probe knows, only see-through. */
const tint = (color: string, percent: number) =>
  `color-mix(in oklch, ${color} ${percent}%, transparent)`;

const plural = (n: number, noun: string) => `${n} ${n === 1 ? noun : `${noun}s`}`;

/** The words a tile or segment is read by: `17 PASS, 1 FAIL`. */
const countsText = (groups: readonly { verdict: string; lines: readonly Line[] }[]) =>
  groups.map((g) => `${g.lines.length} ${g.verdict}`).join(', ');

/** A section of the screen: a mono label, a quiet summary on its right, then the body. */
function Section({
  title,
  summary,
  className = '',
  children,
}: {
  title: string;
  summary?: ReactNode;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className={`grid min-w-0 content-start gap-3 ${className}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className={LABEL}>{title}</h2>
        {summary === undefined ? null : (
          <div className={`${MONO} flex flex-wrap items-center gap-x-3 text-text-secondary`}>
            {summary}
          </div>
        )}
      </header>
      {children}
    </section>
  );
}

function Swatch({ verdict }: { verdict: string }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block size-2 rounded-[2px]"
        style={{ background: toneOf(verdict) }}
      />
      {verdict}
    </span>
  );
}

/**
 * A card that opens over the screen when its button is clicked, listing what a number was made
 * from. A native popover: it is in the page from the first render, closes on Escape or a click
 * outside, and keeps its place through a live update.
 */
function Popover({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      id={id}
      popover="auto"
      className="m-auto max-h-[70vh] w-[min(520px,calc(100vw-32px))] overflow-auto rounded-[10px] border border-border-bright bg-surface-elevated p-0 text-text-primary backdrop:bg-[color:color-mix(in_oklch,var(--background)_60%,transparent)]"
    >
      <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-border bg-surface-elevated px-4 py-2.5">
        <p className={`${MONO} font-semibold text-text-primary`}>{title}</p>
        <button
          type="button"
          popoverTarget={id}
          popoverTargetAction="hide"
          aria-label="Close"
          className={`${MONO} cursor-pointer rounded-md border border-border bg-surface px-2 py-0.5 text-text-secondary hover:text-text-primary`}
        >
          Esc
        </button>
      </div>
      <div className="grid gap-4 px-4 py-3">{children}</div>
    </div>
  );
}

/** Lines of one verdict, each opening the lap it is in. */
function LineList({
  factory,
  verdict,
  lines,
  ...data
}: {
  factory: string;
  verdict: string;
  lines: readonly Line[];
} & Record<`data-${string}`, string | number | boolean>): ReactElement {
  return (
    <section {...data} className="grid gap-1.5">
      <h3 className={`${MONO} font-semibold`} style={{ color: toneOf(verdict) }}>
        {verdict} · {plural(lines.length, 'line')}
      </h3>
      <ol className="grid gap-1">
        {lines.map((line) => (
          <li
            key={`${line.run} ${line.position}`}
            data-lap={line.run}
            data-position={line.position}
            className={`${MONO} text-[11px] text-text-secondary`}
          >
            <Link to={lapPath(factory, line.run)} className={`text-text-primary ${LINK}`}>
              {shortRunId(line.run)}
            </Link>{' '}
            line {line.position},{' '}
            {line.pr === null ? 'no pull request' : `pull request #${line.pr}`}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A hover card above a tile: what the tile's color and numbers mean, in words. */
function Tip({ children }: { children: ReactNode }): ReactElement {
  return (
    <span
      role="tooltip"
      className={`${MONO} pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden w-max max-w-[260px] -translate-x-1/2 rounded-md border border-border-bright bg-surface-elevated px-2.5 py-1.5 text-[11px] text-text-primary group-focus-within:block group-hover:block`}
    >
      {children}
    </span>
  );
}

/** The screen: holdouts at pull-request time and on main, app-check lines, routes and depths. */
export function Testing({ factory }: { factory: string | undefined }): ReactElement {
  return (
    <div className="grid gap-x-10 gap-y-7 lg:grid-cols-2">
      <h1 className={`${LABEL} lg:col-span-2`}>Testing</h1>
      <LivePanel<CheckRow> query="testing-app-check" factory={factory} className="contents">
        {(rows, state) => <AppCheckPanel rows={rows} state={state} factory={factory} />}
      </LivePanel>
      <LivePanel<DefaultHoldoutRow> query="testing-holdouts" factory={factory} className="contents">
        {(rows, state) => (
          <Section
            title="Holdouts on the default branch"
            className="order-2 lg:col-span-2"
            summary={rows && state === 'ready' ? <BranchSummary rows={rows} /> : undefined}
          >
            <PanelBody
              rows={rows}
              state={state}
              factory={factory}
              what="the default branch's holdouts"
            >
              {(loaded) => <DefaultBranchHoldouts rows={loaded} />}
            </PanelBody>
          </Section>
        )}
      </LivePanel>
      <LivePanel<RouteRow> query="testing-routes" factory={factory} className="contents">
        {(rows, state) => (
          <Section
            title="Routes and check depth"
            className="order-4"
            summary={rows && state === 'ready' ? plural(rows.length, 'lap') : undefined}
          >
            <PanelBody rows={rows} state={state} factory={factory} what="the routes">
              {(loaded, name) => <RouteGrid rows={loaded} factory={name} />}
            </PanelBody>
          </Section>
        )}
      </LivePanel>
    </div>
  );
}

/** One query, two sections: the holdout grid across the top, the kind bars below it. */
function AppCheckPanel({
  rows,
  state,
  factory,
}: {
  rows: readonly CheckRow[] | undefined;
  state: PanelState;
  factory: string | undefined;
}): ReactElement {
  const body = (render: (loaded: readonly CheckRow[], name: string) => ReactNode) => (
    <PanelBody rows={rows} state={state} factory={factory} what="the app checks">
      {render}
    </PanelBody>
  );
  const ready = rows !== undefined && state === 'ready';
  return (
    <>
      <Section
        title="Holdouts at pull-request time"
        className="order-1 lg:col-span-2"
        summary={ready ? <TilesSummary rows={rows} /> : undefined}
      >
        {body((loaded, name) => (
          <PrHoldouts rows={loaded} factory={name} />
        ))}
      </Section>
      <Section
        title="App-check lines"
        className="order-3"
        summary={ready ? plural(rows.length, 'line') : undefined}
      >
        {body((loaded, name) => (
          <CheckBars rows={loaded} factory={name} />
        ))}
      </Section>
    </>
  );
}

function TilesSummary({ rows }: { rows: readonly CheckRow[] }): ReactElement {
  const tiles = useMemo(() => scenarioTiles(rows), [rows]);
  const lines = tiles.reduce((n, t) => n + t.total, 0);
  return (
    <>
      <span>
        {plural(tiles.length, 'scenario')} · {plural(lines, 'line')}
      </span>
      <Swatch verdict="PASS" />
      <Swatch verdict="FAIL" />
      <Swatch verdict="INCOMPLETE" />
    </>
  );
}

/** Both app-check sections, for a caller that has the rows already (tests, other screens). */
export function AppChecks({
  rows,
  factory,
}: {
  rows: readonly CheckRow[];
  factory: string;
}): ReactElement {
  return (
    <div className="grid gap-8">
      <AppCheckPanel rows={rows} state="ready" factory={factory} />
    </div>
  );
}

/** One tile per scenario id: its id, its line count per verdict, and a stacked bar of them. */
export function PrHoldouts({
  rows,
  factory,
}: {
  rows: readonly CheckRow[];
  factory: string;
}): ReactElement {
  const tiles = useMemo(() => scenarioTiles(rows), [rows]);
  const id = useId();
  if (tiles.length === 0) {
    return <p className="text-sm text-text-secondary">No holdout line in any app check yet.</p>;
  }
  return (
    <ol className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-1.5">
      {tiles.map((tile) => (
        <HoldoutTile
          key={tile.scenario}
          tile={tile}
          factory={factory}
          popover={`${id}pr-${tile.scenario}`}
        />
      ))}
    </ol>
  );
}

function HoldoutTile({
  tile,
  factory,
  popover,
}: {
  tile: ScenarioTile;
  factory: string;
  popover: string;
}): ReactElement {
  const words = `${tile.scenario}: ${plural(tile.total, 'line')}, ${countsText(tile.verdicts)}`;
  return (
    <li
      data-scenario-tile
      data-scenario={tile.scenario}
      data-count={tile.total}
      className={`group relative ${tile.scenario === 'unidentified' ? 'col-span-2' : ''}`}
    >
      <button
        type="button"
        popoverTarget={popover}
        aria-label={`${words}. Open its lines.`}
        className="grid w-full cursor-pointer gap-1.5 rounded-md border border-border bg-surface px-2.5 pt-1.5 pb-2 text-left transition-colors hover:border-border-bright hover:bg-surface-hover"
      >
        <span className={`${MONO} flex items-baseline justify-between gap-2`}>
          <span className="font-semibold text-text-primary">{tile.scenario}</span>
          <span className="flex gap-1.5 text-[11px]">
            {tile.verdicts.map((v) => (
              <span key={v.verdict} style={{ color: toneOf(v.verdict) }}>
                {v.lines.length}
              </span>
            ))}
          </span>
        </span>
        <span aria-hidden className="flex h-1.5 gap-px overflow-hidden rounded-full">
          {tile.verdicts.map((v) => (
            <span
              key={v.verdict}
              className="h-full"
              style={{ flexGrow: v.lines.length, flexBasis: 0, background: toneOf(v.verdict) }}
            />
          ))}
        </span>
      </button>
      <Tip>
        {tile.scenario} · {countsText(tile.verdicts)}
      </Tip>
      <Popover
        id={popover}
        title={`${tile.scenario} at pull-request time · ${plural(tile.total, 'line')}`}
      >
        {tile.verdicts.map((v) => (
          <LineList
            key={v.verdict}
            factory={factory}
            verdict={v.verdict}
            lines={v.lines}
            data-pr-holdout
            data-scenario={tile.scenario}
            data-verdict={v.verdict}
            data-count={v.lines.length}
          />
        ))}
      </Popover>
    </li>
  );
}

/** One stacked bar per kind of app-check line, one segment per verdict, each opening its lines. */
export function CheckBars({
  rows,
  factory,
}: {
  rows: readonly CheckRow[];
  factory: string;
}): ReactElement {
  const bars = useMemo(() => kindBars(rows), [rows]);
  const id = useId();
  if (bars.length === 0) {
    return (
      <p className="text-sm text-text-secondary">No app check has reported in this factory.</p>
    );
  }
  return (
    <ul className="grid gap-2.5">
      {bars.map((bar) => (
        <KindRow key={bar.kind} bar={bar} factory={factory} id={`${id}kind-${bar.kind}`} />
      ))}
    </ul>
  );
}

function KindRow({
  bar,
  factory,
  id,
}: {
  bar: KindBar;
  factory: string;
  id: string;
}): ReactElement {
  return (
    <li
      data-kind-bar
      data-kind={bar.kind}
      data-count={bar.total}
      className={`${MONO} grid grid-cols-[76px_minmax(0,1fr)_40px] items-center gap-3`}
    >
      <span className="text-text-primary">{bar.kind}</span>
      <span className="flex min-w-0 flex-wrap gap-0.5">
        {bar.verdicts.map((v) => {
          const popover = `${id}-${v.verdict}`;
          const color = toneOf(v.verdict);
          return (
            <span
              key={v.verdict}
              data-check-mix
              data-kind={v.kind}
              data-verdict={v.verdict}
              data-count={v.lines.length}
              className="flex min-w-fit"
              style={{ flexGrow: v.lines.length, flexBasis: 0 }}
            >
              <button
                type="button"
                popoverTarget={popover}
                aria-label={`${bar.kind}: ${plural(v.lines.length, 'line')} ${v.verdict}. Open them.`}
                className="flex h-8 w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-[4px] border-l-[3px] px-2 text-left whitespace-nowrap text-text-primary transition-[filter] hover:brightness-125"
                style={{ borderLeftColor: color, background: tint(color, 16) }}
              >
                <span className="font-semibold">{v.lines.length}</span>
                <span className="text-[10px] tracking-[0.04em] text-text-secondary">
                  {v.verdict}
                </span>
              </button>
              <Popover id={popover} title={`${bar.kind} lines · ${v.verdict}`}>
                <LineList factory={factory} verdict={v.verdict} lines={v.lines} />
              </Popover>
            </span>
          );
        })}
      </span>
      <span className="text-right text-text-secondary">{bar.total}</span>
    </li>
  );
}

/** Routes as rows, check depths as columns, each cell shaded by its lap count. */
export function RouteGrid({
  rows,
  factory,
}: {
  rows: readonly RouteRow[];
  factory: string;
}): ReactElement {
  const grid = useMemo(() => routeGrid(rows), [rows]);
  const id = useId();
  if (grid.total === 0) {
    return <p className="text-sm text-text-secondary">No laps in this factory yet.</p>;
  }
  const columns = {
    gridTemplateColumns: `minmax(64px,auto) repeat(${grid.depths.length}, minmax(0,1fr)) 36px`,
  };
  return (
    <div className={`${MONO} grid gap-1`} style={columns}>
      <span />
      {grid.depths.map((depth) => (
        <span
          key={depth ?? ''}
          className="pb-0.5 text-center text-[11px] leading-tight text-text-secondary"
        >
          {depth ?? NOT_PICKED}
        </span>
      ))}
      <span />
      {grid.routes.map((route) => (
        <RouteRowCells key={route ?? ''} grid={grid} route={route} factory={factory} id={id} />
      ))}
    </div>
  );
}

function RouteRowCells({
  grid,
  route,
  factory,
  id,
}: {
  grid: Grid;
  route: string | null;
  factory: string;
  id: string;
}): ReactElement {
  const total = grid.depths.reduce((n, depth) => n + grid.laps(route, depth).length, 0);
  const routeName = route ?? NOT_PICKED;
  return (
    <>
      <span
        className={`self-center pr-2 ${route === null ? 'text-text-secondary' : 'text-text-primary'}`}
      >
        {routeName}
      </span>
      {grid.depths.map((depth) => {
        const laps = grid.laps(route, depth);
        const key = depth ?? '';
        if (laps.length === 0) {
          return <span key={key} className="h-9 rounded-md bg-surface-inset" />;
        }
        const popover = `${id}route-${route ?? ''}-${key}`;
        const depthName = depth ?? NOT_PICKED;
        // At least a sixth of full strength, so a single lap still reads as a filled cell.
        const share = Math.max(laps.length / grid.most, 1 / 6);
        return (
          <span
            key={key}
            data-route-mix
            data-route={route ?? ''}
            data-depth={depth ?? ''}
            data-count={laps.length}
            className="flex"
          >
            <button
              type="button"
              popoverTarget={popover}
              aria-label={`${routeName} route, ${depthName} depth: ${plural(laps.length, 'lap')}. Open them.`}
              className="h-9 w-full cursor-pointer rounded-md border border-border font-semibold text-text-primary transition-colors hover:border-border-bright"
              style={{ background: tint('var(--text-primary)', Math.round(5 + 23 * share)) }}
            >
              {laps.length}
            </button>
            <Popover
              id={popover}
              title={`${routeName} route, ${depthName} depth · ${plural(laps.length, 'lap')}`}
            >
              <ol className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-x-3 gap-y-1">
                {laps.map((run) => (
                  <li key={run} data-lap={run} className={`${MONO} text-[11px]`}>
                    <Link to={lapPath(factory, run)} className={`text-text-primary ${LINK}`}>
                      {shortRunId(run)}
                    </Link>
                  </li>
                ))}
              </ol>
            </Popover>
          </span>
        );
      })}
      <span className="self-center text-right text-text-secondary">{total || ''}</span>
    </>
  );
}

function BranchSummary({ rows }: { rows: readonly DefaultHoldoutRow[] }): ReactElement | null {
  const branch = useMemo(() => defaultBranch(rows), [rows]);
  if (branch === null) return null;
  const counts = new Map<string, number>();
  for (const v of branch.verdicts) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
  return (
    <>
      {[...counts].map(([verdict, n]) => (
        <span key={verdict} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-2 rounded-[2px]"
            style={{ background: toneOf(verdict) }}
          />
          {n} {verdict}
        </span>
      ))}
    </>
  );
}

/** The newest `holdouts at` line: one tile per scenario, colored by its verdict on main. */
export function DefaultBranchHoldouts({
  rows,
}: {
  rows: readonly DefaultHoldoutRow[];
}): ReactElement {
  const branch = useMemo(() => defaultBranch(rows), [rows]);
  if (branch === null) {
    return <p className="text-sm text-text-secondary">No holdouts line for this factory yet.</p>;
  }
  return (
    <div className="grid gap-2.5">
      <p data-holdouts-at={branch.sha} className={`${MONO} text-text-secondary`}>
        From the holdouts line at <span className="text-text-primary">{branch.sha}</span> on{' '}
        {utcMinute(branch.at)} in #{branch.issue}
        {branch.failing.length === 0 ? '. No scenario fails on the default branch.' : null}
      </p>
      <ol className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-1.5">
        {branch.verdicts.map((v) => (
          <BranchTile key={v.scenario_id} row={v} />
        ))}
      </ol>
    </div>
  );
}

function BranchTile({ row }: { row: DefaultHoldoutRow }): ReactElement {
  const color = toneOf(row.verdict);
  const issueTitle =
    row.issue_number === null
      ? null
      : `#${row.issue_number}${row.issue_title === null ? '' : ` ${row.issue_title}`}`;
  return (
    <li
      data-default-holdout
      data-failing={row.verdict === 'FAIL' ? true : undefined}
      data-scenario={row.scenario_id}
      data-verdict={row.verdict}
      data-issue={row.issue_number ?? undefined}
      className={`${MONO} group relative flex h-8 items-center justify-between gap-1.5 whitespace-nowrap rounded-md border px-2.5 transition-colors`}
      style={{ background: tint(color, 14), borderColor: tint(color, 50) }}
    >
      <span className="font-semibold text-text-primary">{row.scenario_id}</span>
      {row.issue_number === null ? null : (
        <a
          data-link="issue"
          href={row.issue_url ?? issueUrl(row.repository, row.issue_number)}
          aria-label={`${row.scenario_id} ${row.verdict}, tracked by ${issueTitle}`}
          className="text-[11px] font-semibold text-text-primary underline decoration-dotted underline-offset-2 after:absolute after:inset-0 after:content-['']"
        >
          {`#${row.issue_number}`}
        </a>
      )}
      <Tip>
        {row.scenario_id} {row.verdict}
        {issueTitle === null ? '' : ` · ${issueTitle}`}
      </Tip>
    </li>
  );
}
