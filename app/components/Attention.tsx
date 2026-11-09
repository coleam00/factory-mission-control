import { type ReactElement, type ReactNode, useState } from 'react';
import {
  type Action,
  type AttentionCard,
  attentionCount,
  byKind,
  byQueue,
  decideCards,
  fixCards,
  ownerCards,
  unstickCards,
} from '../lib/attention-page';
import type { DecideRow, UnstickRow } from '../lib/attention';
import type { FailureGroupRow } from '../lib/failures';
import { since } from '../lib/laps';
import { type OwnerQueueRow, waited } from '../lib/owner-queue';
import { AWAITED, Feed, type Source } from '../live/Feed';
import { useNow } from './Lanes';
import { usePhone } from './ManagerDock';
import { Button, buttonClass } from './ui/Button';
import { Card } from './ui/Card';
import { ManagerNote } from './ui/ManagerNote';
import { OptionTile } from './ui/OptionTile';
import { Segmented } from './ui/Segmented';
import { Sparkline } from './ui/Sparkline';
import { Pill, StateDot } from './ui/StateDot';

type View = 'kind' | 'queue';

const VIEWS = [
  { value: 'kind', label: 'By kind' },
  { value: 'queue', label: 'By queue' },
] as const;

const NOT_RECORDED = 'not recorded';

/** A copied command's button: "Copied" for two seconds, "Copy failed" when the clipboard refuses. */
function CopyButton({
  label,
  command,
  variant,
}: {
  label: string;
  command: string;
  variant: 'primary' | 'secondary';
}): ReactElement {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  const copy = () => {
    navigator.clipboard.writeText(command).then(
      () => setResult('copied'),
      () => setResult('failed'),
    );
    setTimeout(() => setResult(null), 2000);
  };
  return (
    <Button variant={variant} data-command={command} onClick={copy}>
      {result === 'copied' ? 'Copied' : result === 'failed' ? 'Copy failed' : label}
    </Button>
  );
}

function ActionControl({ action }: { action: Action }): ReactElement {
  if (action.type === 'copy') return <CopyButton {...action} />;
  return (
    <a
      {...action.hooks}
      href={action.href}
      {...(action.external ? { target: '_blank', rel: 'noreferrer' } : {})}
      className={buttonClass(action.variant)}
    >
      {action.label}
    </a>
  );
}

function Age({ card, now }: { card: AttentionCard; now: number }): ReactElement {
  const text =
    'text' in card.age
      ? card.age.text
      : (() => {
          const seconds = since(card.age.since, now);
          return seconds === null ? NOT_RECORDED : waited(seconds);
        })();
  return (
    <span
      data-waited
      className="ml-auto whitespace-nowrap text-[length:var(--v3-t-meta)] font-normal text-[color:var(--v3-fg-3)]"
    >
      {text}
    </span>
  );
}

function Meta({ card }: { card: AttentionCard }): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">
      {card.meta.map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional and never reorder
        <span key={i} className="inline-flex items-center gap-2">
          {i === 0 ? null : <span aria-hidden="true">·</span>}
          {'mono' in part ? (
            <span className="font-mono text-[color:var(--v3-fg-2)]">{part.mono}</span>
          ) : 'pill' in part ? (
            <Pill state={part.state}>{part.pill}</Pill>
          ) : (
            part.text
          )}
        </span>
      ))}
    </div>
  );
}

/** One card, its parts in the README's order: dot, title, age, meta line, the manager's note, options or actions. */
function CardView({ card, now }: { card: AttentionCard; now: number }): ReactElement {
  const [primary, ...rest] = card.actions;
  return (
    <Card
      {...card.hooks}
      className="mb-2.5 grid grid-cols-[14px_1fr] gap-x-3 gap-y-1 px-4 py-4 max-sm:px-3.5 sm:px-[18px]"
    >
      <span className="mt-[7px]">
        <StateDot state={card.dot} />
      </span>
      <h3 className="m-0 flex gap-3 text-[length:var(--v3-t-head)] leading-[1.35] font-semibold text-[color:var(--v3-fg)]">
        <span data-title>{card.title}</span>
        <Age card={card} now={now} />
      </h3>
      <div className="col-start-2">
        <Meta card={card} />
      </div>
      <div className="col-start-2 mt-2">
        <ManagerNote>
          <b>{card.note.lead}</b>
          {card.note.rest === '' ? null : <span data-recommendation> {card.note.rest}</span>}
          {card.note.code === undefined ? null : (
            <code className="mt-1.5 block overflow-x-auto rounded-md bg-[var(--v3-sunk)] px-2.5 py-1.5 font-mono text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)]">
              {card.note.code}
            </code>
          )}
        </ManagerNote>
      </div>
      {card.daily === undefined ? null : (
        <div className="col-start-2">
          <Sparkline counts={card.daily} />
        </div>
      )}
      {card.tiles.length === 0 ? null : (
        <div className="col-start-2 mt-1.5 flex flex-wrap gap-2">
          {card.tiles.map((tile) => (
            <OptionTile
              key={tile.id}
              {...tile.hooks}
              label={tile.label}
              {...(tile.consequence === undefined ? {} : { consequence: tile.consequence })}
              recommended={tile.recommended}
              {...(tile.href === null ? {} : { href: tile.href })}
            />
          ))}
        </div>
      )}
      {card.actions.length === 0 && card.confidence === undefined ? null : (
        <div className="col-start-2 mt-1.5 flex flex-wrap items-center gap-2">
          {primary === undefined ? null : <ActionControl action={primary} />}
          {rest.map((action) => (
            <ActionControl
              key={action.type === 'copy' ? action.command : action.href}
              action={action}
            />
          ))}
          {card.confidence === undefined ? null : (
            <span className="text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">
              {card.confidence}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

function Group({
  name,
  why,
  cards,
  now,
}: {
  name: string;
  why?: string;
  cards: readonly AttentionCard[];
  now: number;
}): ReactElement {
  return (
    <section className="mb-6">
      <h2 className="mb-2.5 flex items-baseline gap-2 text-[length:var(--v3-t-body)] font-bold text-[color:var(--v3-fg)]">
        {name}
        <span className="font-mono text-[length:var(--v3-t-meta)] font-normal text-[color:var(--v3-fg-3)]">
          {cards.length}
        </span>
        {why === undefined ? null : (
          <span className="text-[length:var(--v3-t-meta)] font-normal text-[color:var(--v3-fg-3)]">
            · {why}
          </span>
        )}
      </h2>
      {cards.map((card) => (
        <CardView key={card.key} card={card} now={now} />
      ))}
    </section>
  );
}

/** What each source is, for the line that says its live data is unavailable. */
const SOURCES = ['what is waiting on you', 'the owner queue', 'what stopped moving', 'failures'];

function Head({
  count,
  factory,
  failed,
  view,
  onView,
  phone,
}: {
  count: number | 'loading' | 'unavailable';
  factory: string;
  failed: readonly string[];
  view: View;
  onView: (view: View) => void;
  phone: boolean;
}): ReactElement {
  const title =
    count === 'loading'
      ? 'Loading what needs you.'
      : count === 'unavailable'
        ? 'What needs you'
        : count === 0
          ? 'Nothing needs you'
          : `${count} ${count === 1 ? 'thing needs' : 'things need'} you`;
  const segmented = <Segmented label="Group by" options={VIEWS} value={view} onChange={onView} />;
  return (
    <header className={`mb-[22px] flex items-start gap-4 ${phone ? 'flex-wrap' : ''}`}>
      <div>
        <h1 className="m-0 mb-1.5 text-[length:var(--v3-t-title)] leading-[1.15] font-bold tracking-[-0.015em] text-[color:var(--v3-fg)]">
          {title}
        </h1>
        <p data-sweep className="m-0 max-w-[56ch] text-[color:var(--v3-fg-2)]">
          {factory}. The manager put its recommendation first on each.
        </p>
        {failed.map((what) => (
          <p key={what} className="m-0 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)]">
            Live data for {what} is unavailable.
          </p>
        ))}
        {phone ? <div className="mt-3">{segmented}</div> : null}
      </div>
      {phone ? null : <div className="ml-auto flex flex-none items-center gap-2">{segmented}</div>}
    </header>
  );
}

/** The page over its four sources; exported with a fixed clock and view for tests. */
export function AttentionBody({
  factory,
  decide,
  owner,
  unstick,
  failures,
  now: fixed,
  view: fixedView,
}: {
  factory: string;
  decide: Source<DecideRow>;
  owner: Source<OwnerQueueRow>;
  unstick: Source<UnstickRow>;
  failures: Source<FailureGroupRow>;
  now?: number;
  view?: View;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const phone = usePhone();
  const [chosen, setView] = useState<View>('kind');
  const view = fixedView ?? chosen;
  const sources = [decide, owner, unstick, failures];
  const count = attentionCount(sources);
  const failed = sources.flatMap((s, i) => (s.state === 'error' ? [SOURCES[i] ?? ''] : []));
  // Rows kept through an outage are from before it: a failed source draws no cards.
  const cards: AttentionCard[] = [
    ...(decide.state === 'error' ? [] : decideCards(decide.rows ?? [], factory)),
    ...(owner.state === 'error' ? [] : ownerCards(owner.rows ?? [])),
    ...(unstick.state === 'error' ? [] : unstickCards(unstick.rows ?? [], factory)),
    ...(failures.state === 'error' ? [] : fixCards(failures.rows ?? [], factory)),
  ];
  const groups: ReactNode =
    view === 'kind'
      ? byKind(cards).map((g) => (
          <Group key={g.kind} name={g.name} why={g.why} cards={g.cards} now={now} />
        ))
      : byQueue(cards).map((g) => <Group key={g.queue} name={g.name} cards={g.cards} now={now} />);
  return (
    <section
      data-attention
      data-attention-count={typeof count === 'number' ? count : undefined}
      className={`max-w-[820px] ${phone ? 'px-4 pt-[18px] pb-6' : 'px-8 pt-[30px] pb-20'}`}
    >
      <Head
        count={count}
        factory={factory}
        failed={failed}
        view={view}
        onView={setView}
        phone={phone}
      />
      {groups}
    </section>
  );
}

/** Attention (home): what needs the owner, grouped Decide, Unstick, Fix, each with its recommendation first. */
export function Attention({ factory }: { factory: string }): ReactElement {
  const [decide, setDecide] = useState<Source<DecideRow>>(AWAITED);
  const [owner, setOwner] = useState<Source<OwnerQueueRow>>(AWAITED);
  const [unstick, setUnstick] = useState<Source<UnstickRow>>(AWAITED);
  const [failures, setFailures] = useState<Source<FailureGroupRow>>(AWAITED);
  return (
    <>
      <Feed<DecideRow> query="decide" factory={factory} into={setDecide} />
      <Feed<OwnerQueueRow> query="owner-queue" factory={factory} into={setOwner} />
      <Feed<UnstickRow> query="unstick" factory={factory} into={setUnstick} />
      <Feed<FailureGroupRow> query="failure-groups" factory={factory} into={setFailures} />
      <AttentionBody
        factory={factory}
        decide={decide}
        owner={owner}
        unstick={unstick}
        failures={failures}
      />
    </>
  );
}
