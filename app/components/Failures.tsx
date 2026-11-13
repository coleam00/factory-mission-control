import { type ReactElement, useState } from 'react';
import { Link } from 'react-router';
import {
  type FailureCard,
  failureCards,
  failureWhen,
  FAILURES_QUERY,
  RETRIED_QUERY,
  retriedArgs,
  retriedLine,
} from '../lib/failure-view';
import { type FailureGroupRow, failuresSince, type RetriedRunRow } from '../lib/failures';
import { clock, shortRunId } from '../lib/format';
import { lapHref } from '../lib/one-lap';
import { AWAITED, Feed, type Source } from '../live/Feed';
import { LivePanel } from '../live/LivePanel';
import { useHour } from '../live/use-hour';
import { useToday } from '../live/use-today';
import { PanelBody, useNow } from './panel';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Pill, StateDot } from './ui/StateDot';

/** One failure cause: the state dot and class pill are the only red; the error is one muted mono line, whole in the run. */
export function FailureCardView({ card, now }: { card: FailureCard; now: number }): ReactElement {
  return (
    <Card
      data-failure={card.key}
      data-failures={card.failures}
      className="mb-2.5 grid grid-cols-[14px_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-4"
    >
      <span className="mt-[7px]">
        <StateDot state="failed" />
      </span>
      <h3 className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-[length:var(--v3-t-head)] leading-[1.35] font-semibold text-[color:var(--v3-fg)]">
        <Link to={card.href} data-title className="min-w-0 break-words hover:underline">
          {card.title}
        </Link>
        <span
          data-when
          className="ml-auto text-[length:var(--v3-t-meta)] font-normal text-[color:var(--v3-fg-3)]"
        >
          {failureWhen(card, now)}
        </span>
      </h3>
      <div className="col-start-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">
        <span className="font-mono text-[color:var(--v3-fg-2)]">{card.workflow}</span>
        {card.step === null ? null : <span>· step {card.step}</span>}
        <span aria-hidden="true">·</span>
        <Pill state={card.pill.state}>{card.pill.label}</Pill>
      </div>
      {card.line === null ? null : (
        <p
          data-error
          title={card.line}
          className="col-start-2 m-0 mt-1 truncate font-mono text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]"
        >
          {card.line}
        </p>
      )}
    </Card>
  );
}

/** The retried transient failures as list rows, newest first. */
export function RetriedRuns({
  factory,
  rows,
}: {
  factory: string;
  rows: readonly RetriedRunRow[];
}): ReactElement {
  return (
    <ul className="m-0 mt-2 list-none p-0">
      {rows.map((row) => (
        <li
          key={row.run_id}
          className="flex flex-wrap items-center gap-x-2 py-1 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)]"
        >
          <StateDot state="failed" />
          <span>{row.workflow_name}</span>
          <Link
            to={lapHref(factory, row.run_id)}
            className="font-mono text-[color:var(--v3-you-2)] hover:underline"
          >
            {shortRunId(row.run_id)}
          </Link>
          {row.line === null ? null : (
            <span className="truncate font-mono text-[color:var(--v3-fg-3)]">{row.line}</span>
          )}
          <span className="ml-auto font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)]">
            {clock(row.stopped_at)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The transient failures a later run of their workflow retried, as one muted line that is never a card; nothing when there is none or the read failed. */
function Retried({
  factory,
  source,
}: {
  factory: string;
  source: Source<RetriedRunRow>;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const rows = source.state === 'error' ? [] : (source.rows ?? []);
  if (rows.length === 0) return null;
  return (
    <div data-retried className="mt-[26px] border-t border-[color:var(--v3-line)] pt-3.5">
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">
        <StateDot state="done" />
        {retriedLine(rows.length)}
        <Button variant="text" aria-expanded={open} onClick={() => setOpen(!open)}>
          See them
        </Button>
      </div>
      {open ? <RetriedRuns factory={factory} rows={rows} /> : null}
    </div>
  );
}

/** The cards then the folded transient line; exported with a fixed clock for tests. */
export function FailuresBody({
  factory,
  groups,
  retried = AWAITED,
  now: fixed,
}: {
  factory: string;
  groups: readonly FailureGroupRow[];
  retried?: Source<RetriedRunRow>;
  now?: number;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const cards = failureCards(groups, factory);
  return (
    <section data-failures-view>
      {cards.length === 0 ? (
        <p className="text-[length:var(--v3-t-body)] text-[color:var(--v3-fg-2)]">
          No unresolved failures.
        </p>
      ) : (
        cards.map((card) => <FailureCardView key={card.key} card={card} now={now} />)
      )}
      <Retried factory={factory} source={retried} />
    </section>
  );
}

/** Runs > Failures: the unresolved failure causes, from `failure-groups`. */
export function Failures({ factory }: { factory: string | undefined }): ReactElement {
  const hour = useHour();
  const today = useToday();
  const [retried, setRetried] = useState<Source<RetriedRunRow>>(AWAITED);
  return (
    <>
      <Feed<RetriedRunRow>
        query={RETRIED_QUERY}
        factory={factory}
        args={retriedArgs(today)}
        into={setRetried}
      />
      <LivePanel<FailureGroupRow>
        query={FAILURES_QUERY}
        factory={factory}
        args={[failuresSince(hour)]}
      >
        {(rows, state) => (
          <PanelBody rows={rows} state={state} factory={factory} what="failures">
            {(groups, name) => <FailuresBody factory={name} groups={groups} retried={retried} />}
          </PanelBody>
        )}
      </LivePanel>
    </>
  );
}
