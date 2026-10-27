import { type ReactElement, type ReactNode, useMemo } from 'react';
import { Link } from 'react-router';
import { shortRunId } from '../lib/format';
import { issueUrl, VERDICT_TOKEN } from '../lib/one-lap';
import {
  type CheckRow,
  checkMix,
  type DefaultHoldoutRow,
  defaultBranch,
  type Line,
  prHoldouts,
  type RouteRow,
  routeMix,
} from '../lib/testing';
import { LivePanel } from '../live/LivePanel';
import { LABEL, MONO, PanelBody, utcMinute } from './Lanes';

const CARD = 'rounded-[10px] border border-border bg-surface';
const LINK = 'underline decoration-border-bright underline-offset-2 hover:decoration-text-primary';
const TAG = 'font-mono text-[11px] font-semibold uppercase tracking-[0.05em]';
const ROW = `${MONO} grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-[18px] gap-y-1 border-b border-border/40 px-[18px] py-[11px] last:border-b-0 sm:grid-cols-[140px_120px_minmax(0,1fr)]`;
const NOT_PICKED = 'not picked yet';

const lapPath = (factory: string, run: string) => `/f/${encodeURIComponent(factory)}/laps/${run}`;

function Verdict({ verdict }: { verdict: string }): ReactElement {
  const token = VERDICT_TOKEN[verdict];
  return (
    <span
      className={`${TAG} text-text-secondary`}
      style={token === undefined ? undefined : { color: `var(${token})` }}
    >
      {verdict}
    </span>
  );
}

/** A count that opens onto the laps or lines it was made from, one `li[data-lap]` each. */
function Counted({
  n,
  noun,
  children,
}: {
  n: number;
  noun: 'lap' | 'line';
  children: ReactNode;
}): ReactElement {
  return (
    <details className="col-span-2 min-w-0 sm:col-span-1">
      <summary
        className={`${MONO} cursor-pointer list-none text-text-primary underline decoration-dotted underline-offset-2 [&::-webkit-details-marker]:hidden`}
      >
        {n} {n === 1 ? noun : `${noun}s`}
      </summary>
      <ol className="mt-2 flex flex-col gap-1">{children}</ol>
    </details>
  );
}

function LineItem({ factory, line }: { factory: string; line: Line }): ReactElement {
  return (
    <li
      data-lap={line.run}
      data-position={line.position}
      className="text-[11px] text-text-secondary"
    >
      <Link to={lapPath(factory, line.run)} className={`text-text-primary ${LINK}`}>
        {shortRunId(line.run)}
      </Link>{' '}
      line {line.position}, {line.pr === null ? 'no pull request' : `pull request #${line.pr}`}
    </li>
  );
}

/** The screen: routes and depths, app-check lines, and holdouts at pull-request time and on main. */
export function Testing({ factory }: { factory: string | undefined }): ReactElement {
  return (
    <div className="grid gap-8">
      <h1 className={LABEL}>Testing</h1>
      <LivePanel<RouteRow> query="testing-routes" factory={factory}>
        {(rows, state) => (
          <section className="grid gap-3">
            <h2 className={LABEL}>Routes and check depth</h2>
            <PanelBody rows={rows} state={state} factory={factory} what="the routes">
              {(loaded, name) => <RouteList rows={loaded} factory={name} />}
            </PanelBody>
          </section>
        )}
      </LivePanel>
      <LivePanel<CheckRow> query="testing-app-check" factory={factory}>
        {(rows, state) => (
          <PanelBody rows={rows} state={state} factory={factory} what="the app checks">
            {(loaded, name) => <AppChecks rows={loaded} factory={name} />}
          </PanelBody>
        )}
      </LivePanel>
      <LivePanel<DefaultHoldoutRow> query="testing-holdouts" factory={factory}>
        {(rows, state) => (
          <PanelBody
            rows={rows}
            state={state}
            factory={factory}
            what="the default branch's holdouts"
          >
            {(loaded) => <DefaultBranchHoldouts rows={loaded} />}
          </PanelBody>
        )}
      </LivePanel>
    </div>
  );
}

export function RouteList({
  rows,
  factory,
}: {
  rows: readonly RouteRow[];
  factory: string;
}): ReactElement {
  const groups = useMemo(() => routeMix(rows), [rows]);
  if (groups.length === 0) {
    return <p className="text-sm text-text-secondary">No laps in this factory yet.</p>;
  }
  return (
    <ol className={`${CARD} overflow-hidden`}>
      {groups.map((g) => (
        <li
          key={`${g.route} ${g.depth}`}
          data-route-mix
          data-route={g.route ?? ''}
          data-depth={g.depth ?? ''}
          data-count={g.laps.length}
          className={ROW}
        >
          <span className={g.route === null ? 'text-text-secondary' : 'text-text-primary'}>
            {g.route ?? NOT_PICKED}
          </span>
          <span className="text-text-secondary">{g.depth ?? NOT_PICKED}</span>
          <Counted n={g.laps.length} noun="lap">
            {g.laps.map((run) => (
              <li key={run} data-lap={run} className="text-[11px]">
                <Link to={lapPath(factory, run)} className={`text-text-primary ${LINK}`}>
                  {shortRunId(run)}
                </Link>
              </li>
            ))}
          </Counted>
        </li>
      ))}
    </ol>
  );
}

/** The app-check lines by kind and verdict, then their holdout lines by scenario id. */
export function AppChecks({
  rows,
  factory,
}: {
  rows: readonly CheckRow[];
  factory: string;
}): ReactElement {
  const mix = useMemo(() => checkMix(rows), [rows]);
  const holdouts = useMemo(() => prHoldouts(rows), [rows]);
  return (
    <div className="grid gap-8">
      <section className="grid gap-3">
        <h2 className={LABEL}>App-check lines</h2>
        {mix.length === 0 ? (
          <p className="text-sm text-text-secondary">No app check has reported in this factory.</p>
        ) : (
          <ol className={`${CARD} overflow-hidden`}>
            {mix.map((g) => (
              <li
                key={`${g.kind} ${g.verdict}`}
                data-check-mix
                data-kind={g.kind}
                data-verdict={g.verdict}
                data-count={g.lines.length}
                className={ROW}
              >
                <span className="text-text-primary">{g.kind}</span>
                <Verdict verdict={g.verdict} />
                <Counted n={g.lines.length} noun="line">
                  {g.lines.map((line) => (
                    <LineItem key={`${line.run} ${line.position}`} factory={factory} line={line} />
                  ))}
                </Counted>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="grid gap-3">
        <h2 className={LABEL}>Holdouts at pull-request time</h2>
        {holdouts.length === 0 ? (
          <p className="text-sm text-text-secondary">No holdout line in any app check yet.</p>
        ) : (
          <ol className={`${CARD} overflow-hidden`}>
            {holdouts.map((g) => (
              <li
                key={`${g.scenario} ${g.verdict}`}
                data-pr-holdout
                data-scenario={g.scenario}
                data-verdict={g.verdict}
                data-count={g.lines.length}
                className={ROW}
              >
                <span className="text-text-primary">{g.scenario}</span>
                <Verdict verdict={g.verdict} />
                <Counted n={g.lines.length} noun="line">
                  {g.lines.map((line) => (
                    <LineItem key={`${line.run} ${line.position}`} factory={factory} line={line} />
                  ))}
                </Counted>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function IssueLink({ row }: { row: DefaultHoldoutRow }): ReactElement {
  if (row.issue_number === null)
    return <span className="text-text-secondary">no tracking issue</span>;
  const label = `#${row.issue_number}${row.issue_title === null ? '' : ` ${row.issue_title}`}`;
  return (
    <a
      data-link="issue"
      href={row.issue_url ?? issueUrl(row.repository, row.issue_number)}
      className={`min-w-0 text-text-primary [overflow-wrap:anywhere] ${LINK}`}
    >
      {label}
    </a>
  );
}

/** The newest `holdouts at` line: each scenario's verdict, then the ones failing with their issue. */
export function DefaultBranchHoldouts({
  rows,
}: {
  rows: readonly DefaultHoldoutRow[];
}): ReactElement {
  const branch = useMemo(() => defaultBranch(rows), [rows]);
  return (
    <div className="grid gap-8">
      <section className="grid gap-3">
        <h2 className={LABEL}>Holdouts on the default branch</h2>
        {branch === null ? (
          <p className="text-sm text-text-secondary">No holdouts line for this factory yet.</p>
        ) : (
          <>
            <p data-holdouts-at={branch.sha} className={`${MONO} text-text-secondary`}>
              From the holdouts line at <span className="text-text-primary">{branch.sha}</span> on{' '}
              {utcMinute(branch.at)} in #{branch.issue}
            </p>
            <ol className={`${CARD} overflow-hidden`}>
              {branch.verdicts.map((v) => (
                <li
                  key={v.scenario_id}
                  data-default-holdout
                  data-scenario={v.scenario_id}
                  data-verdict={v.verdict}
                  data-issue={v.issue_number ?? undefined}
                  className={ROW}
                >
                  <span className="text-text-primary">{v.scenario_id}</span>
                  <Verdict verdict={v.verdict} />
                  <span className="col-span-2 min-w-0 sm:col-span-1">
                    {v.issue_number === null ? null : <IssueLink row={v} />}
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
      <section className="grid gap-3">
        <h2 className={LABEL}>Failing on the default branch</h2>
        {branch === null || branch.failing.length === 0 ? (
          <p className="text-sm text-text-secondary">No scenario fails on the default branch.</p>
        ) : (
          <ol className={`${CARD} overflow-hidden`}>
            {branch.failing.map((v) => (
              <li
                key={v.scenario_id}
                data-failing
                data-scenario={v.scenario_id}
                data-issue={v.issue_number ?? undefined}
                className={ROW}
              >
                <span className="text-text-primary">{v.scenario_id}</span>
                <Verdict verdict={v.verdict} />
                <span className="col-span-2 min-w-0 sm:col-span-1">
                  <IssueLink row={v} />
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
