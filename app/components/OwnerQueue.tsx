import { type ReactElement, useMemo } from 'react';
import { STATE_TOKEN } from '../lib/issue-graph';
import { since } from '../lib/laps';
import { type OwnerItem, type OwnerQueueRow, ownerQueue, waited } from '../lib/owner-queue';
import { LivePanel } from '../live/LivePanel';
import { EmptyState } from './EmptyState';
import { Field, LABEL, MONO, NONE, PanelBody, useNow, utcMinute } from './Lanes';

/** A needs-owner issue reads as on the issue graph; a question is amber, waiting on its default. */
const KIND_LOOK: Record<OwnerItem['kind'], { label: string; color: string }> = {
  issue: { label: 'Needs owner', color: `var(${STATE_TOKEN['needs-owner']})` },
  question: { label: 'Question', color: 'var(--warning)' },
};

const LINK = `${MONO} shrink-0 font-bold text-text-primary underline decoration-border-bright underline-offset-2 hover:decoration-text-primary`;

/**
 * Everything waiting on the owner for one factory, each item linking to its GitHub thread, where
 * it is answered. The screen answers nothing.
 */
export function OwnerQueue({ factory }: { factory: string | undefined }): ReactElement {
  return (
    <LivePanel<OwnerQueueRow> query="owner-queue" factory={factory}>
      {(rows, state) => (
        <>
          <h1 className={`${LABEL} mb-3`}>
            Waiting on the owner
            {rows === undefined ? null : (
              <span data-count={rows.length} className="ml-2 text-text-primary tabular-nums">
                {rows.length}
              </span>
            )}
          </h1>
          <PanelBody rows={rows} state={state} factory={factory} what="the owner queue">
            {(loaded) =>
              loaded.length === 0 ? (
                <EmptyState title="Nothing is waiting on the owner." />
              ) : (
                <OwnerList rows={loaded} />
              )
            }
          </PanelBody>
        </>
      )}
    </LivePanel>
  );
}

export function OwnerList({
  rows,
  now: fixed,
}: {
  rows: readonly OwnerQueueRow[];
  /** A fixed clock, for tests; the screen uses the browser's. */
  now?: number;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const items = useMemo(() => ownerQueue(rows), [rows]);
  return (
    <ol className="grid gap-3">
      {items.map((item) => (
        <OwnerEntry key={item.id} item={item} now={now} />
      ))}
    </ol>
  );
}

function OwnerEntry({ item, now }: { item: OwnerItem; now: number }): ReactElement {
  const look = KIND_LOOK[item.kind];
  const wait = since(item.waiting_since, now);
  return (
    <li
      data-owner-item={item.id}
      data-kind={item.kind}
      data-issue={item.issue_number}
      data-question={item.question_number ?? undefined}
      data-url={item.url ?? undefined}
      data-waiting-since={item.waiting_since?.toISOString()}
      className="relative overflow-hidden rounded-[10px] border border-border bg-surface py-[13px] pr-[18px] pl-[22px]"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ backgroundColor: look.color }}
      />
      <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2">
        <span className="flex items-center gap-[9px]">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: look.color }}
          />
          <span
            className="font-mono text-[11px] font-semibold uppercase tracking-[0.05em]"
            style={{ color: look.color }}
          >
            {look.label}
          </span>
        </span>
        {/* Below sm the title takes its own line under the kind and the wait, so it is never
            squeezed into the gap between them. */}
        <span className="order-last flex min-w-0 basis-full items-baseline gap-2.5 sm:order-none sm:basis-0 sm:flex-1">
          {item.url === null ? (
            <span className={`${MONO} font-bold text-text-primary`}>#{item.issue_number}</span>
          ) : (
            <a href={item.url} data-thread className={LINK}>
              #{item.issue_number}
            </a>
          )}
          {item.question_number === null ? null : (
            <span className={`${MONO} shrink-0 text-text-secondary`}>Q{item.question_number}</span>
          )}
          <span data-title className="min-w-0 break-words text-[12.5px] text-text-primary">
            {item.title}
          </span>
        </span>
        <span
          className={`${MONO} ml-auto shrink-0 text-text-secondary sm:ml-0`}
          title={
            item.kind === 'issue'
              ? 'Since the issue was last updated on GitHub'
              : 'Since the question was raised'
          }
        >
          waited <span data-waited>{wait === null ? NONE : waited(wait)}</span>
        </span>
      </div>
      {item.kind === 'question' ? <QuestionDetail item={item} now={now} /> : null}
    </li>
  );
}

function QuestionDetail({ item, now }: { item: OwnerItem; now: number }): ReactElement {
  const untilDefault = item.default_at === null ? null : -(since(item.default_at, now) ?? 0);
  return (
    <>
      {item.options.length === 0 ? null : (
        <ul className="mt-3 grid gap-1.5">
          {item.options.map((option) => {
            const isDefault = option.key === item.default_option;
            return (
              <li
                key={option.key}
                data-option={option.key}
                data-default={isDefault || undefined}
                className="flex items-baseline gap-2.5 text-[12.5px]"
              >
                <span className={`${MONO} w-4 shrink-0 font-bold text-text-primary`}>
                  {option.key}
                </span>
                <span className="min-w-0 text-text-secondary">{option.text}</span>
                {isDefault ? (
                  <span
                    className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.04em]"
                    style={{ color: 'var(--warning)' }}
                  >
                    Default
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-x-[18px] gap-y-2 sm:grid-cols-[minmax(0,3fr)_minmax(0,1fr)_minmax(0,2fr)]">
        <div className="col-span-2 flex min-w-0 flex-col gap-1 sm:col-span-1">
          <dt className={LABEL}>Recommendation</dt>
          <dd data-recommendation className="min-w-0 text-[12.5px] text-text-primary">
            {item.recommendation ?? NONE}
          </dd>
        </div>
        <Field label="Default">
          <span data-default-option>{item.default_option ?? NONE}</span>
        </Field>
        {/* Not the truncating Field: the date, its UTC and the countdown must all show on a phone. */}
        <div className="col-span-2 flex min-w-0 flex-col gap-1 sm:col-span-1">
          <dt className={LABEL}>Default applies</dt>
          <dd className={`${MONO} min-w-0 text-text-primary`}>
            {item.default_at === null || untilDefault === null ? (
              NONE
            ) : (
              <span data-default-at={item.default_at.toISOString()}>
                {utcMinute(item.default_at)}{' '}
                <span className="whitespace-nowrap text-text-secondary">
                  {untilDefault > 0 ? `in ${waited(untilDefault)}` : `${waited(-untilDefault)} ago`}
                </span>
              </span>
            )}
          </dd>
        </div>
      </dl>
    </>
  );
}
