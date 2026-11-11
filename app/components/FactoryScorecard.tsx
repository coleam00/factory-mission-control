import { type ReactElement, useEffect, useState } from 'react';
import {
  type Comparison,
  type FactoryScorecardRow,
  formatChange,
  formatValue,
  type MeasureFormat,
  msToUtcMidnight,
  type ScorecardWindow,
  scorecardMeasures,
  scorecardUntil,
} from '../lib/factory-scorecard';
import { LivePanel, type PanelState } from '../live/LivePanel';
import { Card } from './ui/Card';
import { Segmented } from './ui/Segmented';

const WINDOWS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
] as const satisfies readonly { value: ScorecardWindow; label: string }[];

const NOTE = 'text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]';
const CELL = 'px-2 py-2 align-top';

function Period({ format, value, n }: { format: MeasureFormat; value: number | null; n: number }) {
  return (
    <>
      <span className="tabular-nums text-[color:var(--v3-fg)]">{formatValue(format, value)}</span>
      <span className="block font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)] tabular-nums">
        n {n}
      </span>
    </>
  );
}

function Cells({ format, c }: { format: MeasureFormat; c: Comparison }) {
  return (
    <>
      <td className={CELL}>
        <Period format={format} value={c.now} n={c.nNow} />
      </td>
      <td className={CELL}>
        <Period format={format} value={c.before} n={c.nBefore} />
      </td>
      <td className={`${CELL} tabular-nums`}>
        {c.tooFew ? (
          <span className="text-[color:var(--v3-fg-3)]">Too few to compare</span>
        ) : c.change === null ? null : (
          formatChange(format, c.change)
        )}
      </td>
    </>
  );
}

/** The scorecard once its rows are known; `rows` is undefined until the query has answered. */
export function FactoryScorecardBody({
  rows,
  state,
  window,
  onWindow,
}: {
  rows: readonly FactoryScorecardRow[] | undefined;
  state: PanelState;
  window: ScorecardWindow;
  onWindow: (window: ScorecardWindow) => void;
}): ReactElement {
  const say = (text: string) => <p className={`m-0 ${NOTE}`}>{text}</p>;
  return (
    <Card className="p-4" aria-label="Scorecard">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-[length:var(--v3-t-head)] font-semibold text-[color:var(--v3-fg)]">
          Scorecard
        </h2>
        <Segmented label="Period" options={WINDOWS} value={window} onChange={onWindow} />
      </div>
      {state === 'error' ? (
        say('Live data is unavailable.')
      ) : rows === undefined ? (
        say('Loading the scorecard.')
      ) : rows.length === 0 ? (
        say('No metric records yet: Archon writes them when archon-metrics-prs runs.')
      ) : (
        <>
          <p className={`mb-3 mt-0 ${NOTE}`}>
            From Archon’s metric records, by UTC day, beside the period before. n is how many
            records each number rests on.
          </p>
          <table className="w-full table-fixed border-collapse text-left text-[length:var(--v3-t-meta)]">
            <thead>
              <tr className="text-[color:var(--v3-fg-3)]">
                <th className={`${CELL} w-[38%] font-normal`}>Measure</th>
                <th className={`${CELL} w-[17%] font-normal`}>Now</th>
                <th className={`${CELL} w-[17%] font-normal`}>Before</th>
                <th className={`${CELL} font-normal`}>Change</th>
              </tr>
            </thead>
            <tbody>
              {scorecardMeasures(rows, window).flatMap((measure) => [
                <tr key={measure.name} className="border-t border-[color:var(--v3-line)]">
                  <th
                    className={`${CELL} font-normal text-[color:var(--v3-fg)] [overflow-wrap:anywhere]`}
                  >
                    {measure.label}
                  </th>
                  <Cells format={measure.format} c={measure} />
                </tr>,
                ...measure.routeRows.map((route) => (
                  <tr key={`${measure.name}.${route.route}`}>
                    <th
                      className={`${CELL} pl-6 font-mono font-normal text-[color:var(--v3-fg-2)]`}
                    >
                      {route.route}
                    </th>
                    <Cells format={measure.format} c={route} />
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

/** The browser's clock, moved on at each UTC midnight, when the scorecard's windows move a day. */
function useUtcDay(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), msToUtcMidnight(now));
    return () => clearTimeout(timer);
  }, [now]);
  return now;
}

/** The factory's scorecard (#630): Archon's metric records for the last 7 or 30 days, live. */
export function FactoryScorecard({ factory }: { factory: string | undefined }): ReactElement {
  const [window, setWindow] = useState<ScorecardWindow>('7');
  const until = scorecardUntil(useUtcDay());
  return (
    <LivePanel<FactoryScorecardRow> query="factory-scorecard" factory={factory} args={[until]}>
      {(rows, state) => (
        <FactoryScorecardBody rows={rows} state={state} window={window} onWindow={setWindow} />
      )}
    </LivePanel>
  );
}
