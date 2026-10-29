import { type ReactElement, useMemo } from 'react';
import { STATE_TOKEN } from '../lib/issue-graph';
import { since } from '../lib/laps';
import { type OwnerItem, type OwnerQueueRow, ownerQueue, waited } from '../lib/owner-queue';
import { LivePanel } from '../live/LivePanel';
import { EmptyState } from './EmptyState';
import { LABEL, MONO, NONE, PanelBody, useNow, utcMinute } from './Lanes';

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
  // Every wait bar shares one scale, the longest wait, so the oldest item reads longest.
  const longest = Math.max(0, ...items.map((item) => since(item.waiting_since, now) ?? 0));
  return (
    <ol className="grid gap-3">
      {items.map((item) => (
        <OwnerEntry key={item.id} item={item} now={now} longest={longest} />
      ))}
    </ol>
  );
}

/** A bar's fill as a share of its track: at least a sliver, so a nonzero value is never invisible. */
const share = (value: number, max: number) =>
  max <= 0 ? '0%' : `${Math.max(2, Math.min(100, (value / max) * 100))}%`;

function OwnerEntry({
  item,
  now,
  longest,
}: {
  item: OwnerItem;
  now: number;
  longest: number;
}): ReactElement {
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
      data-approximate={item.approximate || undefined}
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
          <span data-title className="min-w-0 break-words text-[13px] text-text-primary">
            {item.title}
          </span>
        </span>
      </div>
      <div
        className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[18px]"
        title={
          item.kind === 'question'
            ? 'Since the question was raised'
            : item.approximate
              ? 'Approximate: since the issue was last updated on GitHub, as when it was labelled is not recorded'
              : 'Since the issue was labelled needs-owner'
        }
      >
        <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-surface-inset">
          {wait === null ? null : (
            <div
              className="h-full rounded-full"
              style={{ width: share(wait, longest), backgroundColor: look.color }}
            />
          )}
        </div>
        <span className={`${MONO} text-text-secondary`}>
          waited{' '}
          <span className="font-semibold text-text-primary">
            <span data-waited>{wait === null ? NONE : waited(wait)}</span>
          </span>
        </span>
      </div>
      {item.kind === 'question' ? <QuestionDetail item={item} now={now} /> : null}
    </li>
  );
}

/**
 * A question's options side by side with the default marked, the recommendation, and the run-up
 * to the default as a bar from when it was raised to when the default applies.
 */
function QuestionDetail({ item, now }: { item: OwnerItem; now: number }): ReactElement {
  const untilDefault = item.default_at === null ? null : -(since(item.default_at, now) ?? 0);
  const raised = item.waiting_since?.getTime() ?? null;
  const applies = item.default_at?.getTime() ?? null;
  const elapsed =
    raised === null || applies === null || applies <= raised || item.default_option === null
      ? null
      : Math.min(1, Math.max(0, (now - raised) / (applies - raised)));
  return (
    <>
      {item.options.length === 0 ? null : (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {item.options.map((option) => {
            const isDefault = option.key === item.default_option;
            return (
              <li
                key={option.key}
                data-option={option.key}
                data-default={isDefault || undefined}
                className={`flex items-baseline gap-2.5 rounded-md border px-3 py-2 text-[13px] ${
                  isDefault ? 'bg-warning/[0.08]' : 'bg-surface-elevated'
                }`}
                // Inline: `.console-root *` outranks Tailwind's border color utilities.
                style={isDefault ? { borderColor: 'var(--warning)' } : undefined}
              >
                <span className={`${MONO} w-4 shrink-0 font-bold text-text-primary`}>
                  {option.key}
                </span>
                <span className="min-w-0 flex-1 text-text-primary">{option.text}</span>
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
      <div className="mt-4 grid gap-1">
        <span className={LABEL}>Recommendation</span>
        <p data-recommendation className="min-w-0 text-[13px] text-text-primary">
          {item.recommendation ?? NONE}
        </p>
      </div>
      <div className="mt-4 grid gap-2">
        {/* The date, its UTC and the countdown must all show on a phone: nothing truncates. */}
        {item.default_option === null ? (
          <p data-no-default className={`${MONO} min-w-0 text-text-secondary`}>
            No default: this waits for the owner.
          </p>
        ) : (
          <p className={`${MONO} min-w-0 text-text-secondary`}>
            Default{' '}
            <span className="font-bold text-text-primary">
              <span data-default-option>{item.default_option}</span>
            </span>{' '}
            applies{' '}
            {item.default_at === null || untilDefault === null ? (
              NONE
            ) : (
              <span data-default-at={item.default_at.toISOString()} className="text-text-primary">
                {utcMinute(item.default_at)}{' '}
                <span
                  className="whitespace-nowrap font-semibold"
                  style={{ color: 'var(--warning)' }}
                >
                  {untilDefault > 0 ? `in ${waited(untilDefault)}` : `${waited(-untilDefault)} ago`}
                </span>
              </span>
            )}
          </p>
        )}
        {elapsed === null ? null : (
          <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-surface-inset">
            <div
              className="h-full rounded-full bg-warning"
              style={{ width: `${Math.max(2, elapsed * 100)}%` }}
            />
          </div>
        )}
      </div>
    </>
  );
}
