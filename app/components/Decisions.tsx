import { type ReactElement, type ReactNode, useMemo } from 'react';
import {
  type AttentionItem,
  type AttentionRow,
  attentionItems,
  attentionOrigin,
  attentionQuestion,
  attentionTitle,
  recommendedChoice,
} from '../lib/attention';
import {
  failedLaps,
  type HealthRunRow,
  type HealthStepRow,
  type HealthWorkableRow,
  overdueSteps,
  waitingRuns,
} from '../lib/health';
import { since } from '../lib/laps';
import { consoleUrl } from '../lib/one-lap';
import { type OwnerItem, type OwnerQueueRow, ownerQueue, waited } from '../lib/owner-queue';
import { LivePanel } from '../live/LivePanel';
import { EmptyState } from './EmptyState';
import { Failures, OverdueList, WaitingList, Workable } from './Health';
import { LABEL, MONO, NONE, PanelBody, useNow, utcMinute } from './Lanes';

/** The mockup's wording (docs/design/v2/mockup.html), word for word. */
export const CAPTION =
  'Decisions the manager brought you, each with its recommended answer. You answer in the Archon console or Slack; this page only shows them.';
export const FOOTER =
  'Answer in the Archon console or Slack. If the same call comes up again, it should become a line in the policy files.';

const PERSON = 'var(--role-person)';
const PERSON_SOFT = 'var(--role-person-soft)';
const LINK =
  'shrink-0 text-[13px] text-accent-bright underline decoration-border-bright underline-offset-2 hover:decoration-accent-bright';
const FOOT = 'text-[12.5px] text-text-secondary';

function Chip({
  children,
  ...data
}: { children: ReactNode } & Record<string, string>): ReactElement {
  return (
    <span
      {...data}
      className="shrink-0 rounded px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-[0.04em]"
      style={{ color: PERSON, backgroundColor: PERSON_SOFT }}
    >
      {children}
    </span>
  );
}

/** The mockup's `.panel`: a head with where it came from, the question and a link, then a body. */
function Panel({
  label,
  question,
  link,
  children,
  data,
}: {
  label: ReactNode;
  question: ReactNode;
  link: ReactNode;
  children: ReactNode;
  /** The `data-*` attributes the live checks read, by name. */
  data: Record<`data-${string}`, string | undefined>;
}): ReactElement {
  return (
    <li {...data} className="overflow-hidden rounded-[12px] border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-border px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className={LABEL}>{label}</div>
          <h3
            data-question
            className="mt-1 max-w-[80ch] text-[15px] font-semibold text-text-primary"
          >
            {question}
          </h3>
        </div>
        {link}
      </div>
      <div className="grid gap-3 px-4 py-3.5">{children}</div>
    </li>
  );
}

/** One run paused on a `wait: attention` node, with the console as the place to answer it. */
export function AttentionPanel({ item, now }: { item: AttentionItem; now: number }): ReactElement {
  const wait = since(item.waiting_since, now);
  const title = attentionTitle(item.message);
  const recommended = recommendedChoice(item.message, item.options);
  return (
    <Panel
      data={{
        'data-attention-item': item.run_id,
        'data-waiting-since': item.waiting_since.toISOString(),
      }}
      label={
        <>
          {attentionOrigin(item)}
          {title === null ? null : ` · ${title}`} · waiting{' '}
          <span data-waited>{wait === null ? NONE : waited(wait)}</span>
        </>
      }
      question={attentionQuestion(item.message)}
      link={
        <a data-console href={consoleUrl(item.console, item.run_id)} className={LINK}>
          Open in console
        </a>
      }
    >
      {item.options.length === 0 ? null : (
        <ul className="grid gap-1.5 text-[13px] text-text-primary">
          {item.options.map((option) => (
            <li key={option.id} data-choice={option.id} className="flex items-baseline gap-2">
              {option.id === recommended ? <Chip data-recommended="">recommended</Chip> : null}
              {option.label ?? option.id}
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>{FOOTER}</p>
    </Panel>
  );
}

/**
 * One item of a factory still on the old loop, answered on GitHub. A `needs-owner` issue is its
 * number, title, wait and thread; the screen carries the DOM contract `scripts/live/owner.ts` reads.
 */
export function OwnerItemPanel({ item, now }: { item: OwnerItem; now: number }): ReactElement {
  const wait = since(item.waiting_since, now);
  const question = item.kind === 'question';
  return (
    <Panel
      data={{
        'data-owner-item': item.id,
        'data-kind': item.kind,
        'data-issue': String(item.issue_number),
        'data-question-number':
          item.question_number === null ? undefined : String(item.question_number),
        'data-url': item.url ?? undefined,
        'data-waiting-since': item.waiting_since?.toISOString(),
        'data-approximate': item.approximate ? 'true' : undefined,
      }}
      label={
        <>
          {question
            ? `Owner question · #${item.issue_number} · Q${item.question_number}`
            : `Needs owner · #${item.issue_number}`}
          {' · waiting '}
          <span data-waited>{wait === null ? NONE : waited(wait)}</span>
        </>
      }
      question={<span data-title>{item.title}</span>}
      link={
        item.url === null ? null : (
          <a data-thread href={item.url} className={LINK}>
            Answer on its GitHub thread
          </a>
        )
      }
    >
      {question ? <OwnerQuestionDetail item={item} /> : null}
    </Panel>
  );
}

/** A question's options with the default marked, its recommendation, and when the default applies. */
function OwnerQuestionDetail({ item }: { item: OwnerItem }): ReactElement {
  return (
    <>
      {item.options.length === 0 ? null : (
        <ul className="grid gap-1.5 text-[13px] text-text-primary">
          {item.options.map((option) => {
            const isDefault = option.key === item.default_option;
            return (
              <li
                key={option.key}
                data-option={option.key}
                data-default={isDefault || undefined}
                className="flex items-baseline gap-2.5"
              >
                <span className={`${MONO} w-4 shrink-0 font-bold`}>{option.key}</span>
                <span className="min-w-0 flex-1">{option.text}</span>
                {isDefault ? <Chip>default</Chip> : null}
              </li>
            );
          })}
        </ul>
      )}
      <p data-recommendation className="text-[13px] text-text-primary">
        {item.recommendation ?? NONE}
      </p>
      {item.default_option === null ? null : (
        <p className={`${MONO} text-text-secondary`}>
          Default <span data-default-option>{item.default_option}</span> applies{' '}
          {item.default_at === null ? (
            NONE
          ) : (
            <span data-default-at={item.default_at.toISOString()}>
              {utcMinute(item.default_at)}
            </span>
          )}
        </p>
      )}
    </>
  );
}

/** Attention items first, then the old loop's owner items, each longest-waiting first. */
export function WaitingItems({
  attention,
  owner,
  now: fixed,
}: {
  attention: readonly AttentionRow[];
  owner: readonly OwnerQueueRow[];
  /** A fixed clock, for tests; the screen uses the browser's. */
  now?: number;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const attentionSorted = useMemo(() => attentionItems(attention), [attention]);
  const ownerSorted = useMemo(() => ownerQueue(owner), [owner]);
  if (attentionSorted.length === 0 && ownerSorted.length === 0) {
    return <EmptyState title="Nothing is waiting on you." />;
  }
  return (
    <ol className="grid gap-3">
      {attentionSorted.map((item) => (
        <AttentionPanel key={item.run_id} item={item} now={now} />
      ))}
      {ownerSorted.map((item) => (
        <OwnerItemPanel key={item.id} item={item} now={now} />
      ))}
    </ol>
  );
}

/** What waits on the owner: Archon's attention items, and the old loop's questions and issues. */
export function WaitingOnYou({ factory }: { factory: string | undefined }): ReactElement {
  return (
    <section className="grid gap-3">
      <h1 className="sr-only">Decisions</h1>
      <p className="text-sm text-text-secondary">{CAPTION}</p>
      <LivePanel<AttentionRow> query="attention-items" factory={factory}>
        {(attention, attentionState) => (
          <PanelBody
            rows={attention}
            state={attentionState}
            factory={factory}
            what="what is waiting on you"
          >
            {(loadedAttention) => (
              <LivePanel<OwnerQueueRow> query="owner-queue" factory={factory}>
                {(owner, ownerState) => (
                  <PanelBody
                    rows={owner}
                    state={ownerState}
                    factory={factory}
                    what="the owner queue"
                  >
                    {(loadedOwner) => (
                      <WaitingItems attention={loadedAttention} owner={loadedOwner} />
                    )}
                  </PanelBody>
                )}
              </LivePanel>
            )}
          </PanelBody>
        )}
      </LivePanel>
    </section>
  );
}

/** Pending and paused runs, overdue steps and failed laps; one sentence when there are none. */
export function HealthDrawn({
  runs,
  steps,
  factory,
  now: fixed,
}: {
  runs: readonly HealthRunRow[];
  steps: readonly HealthStepRow[];
  factory: string;
  /** A fixed clock, for tests; the screen uses the browser's. */
  now?: number;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const quiet =
    waitingRuns(runs).length === 0 &&
    overdueSteps(steps, now).length === 0 &&
    failedLaps(runs).length === 0;
  if (quiet)
    return (
      <p data-healthy className="text-sm text-text-primary">
        The factory is healthy.
      </p>
    );
  return (
    <>
      <WaitingList rows={runs} factory={factory} now={now} color={PERSON} />
      <OverdueList rows={steps} factory={factory} now={now} />
      <Failures rows={runs} factory={factory} />
    </>
  );
}

/** The factory's health (PRD 4.8), drawn, under what waits on the owner. */
export function DecisionsHealth({ factory }: { factory: string | undefined }): ReactElement {
  return (
    <section className="grid gap-8">
      <h2 className={LABEL}>Factory health</h2>
      <LivePanel<HealthRunRow> query="health-runs" factory={factory} className="grid gap-8">
        {(runs, runsState) => (
          <PanelBody rows={runs} state={runsState} factory={factory} what="waiting and failed runs">
            {(loadedRuns, name) => (
              <LivePanel<HealthStepRow>
                query="health-steps"
                factory={factory}
                className="grid gap-8"
              >
                {(steps, stepsState) => (
                  <PanelBody rows={steps} state={stepsState} factory={factory} what="running steps">
                    {(loadedSteps) => (
                      <HealthDrawn runs={loadedRuns} steps={loadedSteps} factory={name} />
                    )}
                  </PanelBody>
                )}
              </LivePanel>
            )}
          </PanelBody>
        )}
      </LivePanel>
      <LivePanel<HealthWorkableRow> query="health-workable" factory={factory}>
        {(rows, state) => (
          <PanelBody rows={rows} state={state} factory={factory} what="workable issues">
            {(loaded) => <Workable rows={loaded} />}
          </PanelBody>
        )}
      </LivePanel>
    </section>
  );
}
