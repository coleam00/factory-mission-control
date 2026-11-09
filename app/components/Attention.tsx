import { type ReactElement, type ReactNode, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  type Action,
  ATTENTION_SOURCES,
  type AttentionCard,
  attentionCount,
  byKind,
  byQueue,
  decideCards,
  fixCards,
  ownerCards,
  SWEEP_QUERY,
  type SweepRow,
  type Tile,
  sweepLine,
  unstickCards,
} from '../lib/attention-page';
import { type AnswerRequest, TEXT_ANSWER_DETAIL } from '../lib/actions';
import type { DecideRow, UnstickRow } from '../lib/attention';
import type { FailureGroupRow } from '../lib/failures';
import { since } from '../lib/laps';
import { lapHref } from '../lib/one-lap';
import { clock, shortRunId } from '../lib/format';
import { HANDLED_QUERY, type HandledRow, handledSummary, handledToday } from '../lib/manager';
import { type OwnerQueueRow, waited } from '../lib/owner-queue';
import { AWAITED, Feed, type Source } from '../live/Feed';
import { useActionPending, useActionsEnabled, useStartAction } from './ActionToast';
import { useNow } from './panel';
import { openManager, usePhone, usePublishPlaceWhat } from './ManagerDock';
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

/** Whether the server holds an operator for this factory, and the one flow every action starts. */
interface Act {
  enabled: boolean;
  start: ReturnType<typeof useStartAction>;
  pending: boolean;
}

function ActionControl({ action, act }: { action: Action; act: Act }): ReactElement {
  if (action.type === 'copy') return <CopyButton {...action} />;
  if (action.type === 'act' && act.enabled) {
    return (
      <Button
        variant={action.variant}
        disabled={act.pending}
        {...action.hooks}
        onClick={() => act.start(action.request, { item: null, label: '' })}
      >
        {action.label}
      </Button>
    );
  }
  const { href, external } = action.type === 'act' ? action.fallback : action;
  return (
    <a
      {...action.hooks}
      href={href}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      className={buttonClass(action.variant)}
    >
      {action.label}
    </a>
  );
}

/** The inline box that takes the owner's own words for "Something else". */
function AnswerBox({
  request,
  item,
  act,
  onClose,
}: {
  request: AnswerRequest;
  item: number | null;
  act: Act;
  onClose: () => void;
}): ReactElement {
  const [text, setText] = useState('');
  const send = () => {
    act.start({ ...request, text }, { item, label: TEXT_ANSWER_DETAIL });
    onClose();
  };
  return (
    <div data-answer-box className="col-start-2 mt-1.5 flex flex-col items-start gap-2">
      <textarea
        aria-label="Your answer"
        value={text}
        maxLength={2000}
        onChange={(event) => setText(event.target.value)}
        className="min-h-[72px] w-full rounded-lg border border-[color:var(--v3-line)] bg-[var(--v3-sunk)] p-2 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg)]"
      />
      <div className="flex gap-2">
        <Button variant="primary" disabled={act.pending || text.trim() === ''} onClick={send}>
          Send answer
        </Button>
        <Button variant="text" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
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
function CardView({
  card,
  now,
  act,
}: {
  card: AttentionCard;
  now: number;
  act: Act;
}): ReactElement {
  const [primary, ...rest] = card.actions;
  const [writing, setWriting] = useState<Tile['somethingElse']>();
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
          {card.note.rest === '' ? null : (
            <>
              {' '}
              <span data-recommendation>{card.note.rest}</span>
            </>
          )}
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
          {card.tiles.map((tile) => {
            const here = act.enabled ? (tile.answer ?? tile.somethingElse) : undefined;
            const where =
              here !== undefined
                ? {
                    disabled: act.pending,
                    onClick: () =>
                      tile.answer
                        ? act.start(tile.answer.request, {
                            item: tile.answer.item,
                            label: tile.label,
                          })
                        : setWriting(tile.somethingElse),
                  }
                : tile.href === null
                  ? {}
                  : { href: tile.href };
            return (
              <OptionTile
                key={tile.id}
                {...tile.hooks}
                label={tile.label}
                {...(tile.consequence === undefined ? {} : { consequence: tile.consequence })}
                recommended={tile.recommended}
                {...where}
              />
            );
          })}
        </div>
      )}
      {writing === undefined || !act.enabled ? null : (
        <AnswerBox
          request={writing.request}
          item={writing.item}
          act={act}
          onClose={() => setWriting(undefined)}
        />
      )}
      <div className="col-start-2 mt-1.5 flex flex-wrap items-center gap-2">
        {primary === undefined ? null : <ActionControl action={primary} act={act} />}
        {rest.map((action) => (
          <ActionControl
            key={
              action.type === 'copy'
                ? action.command
                : action.type === 'act'
                  ? action.label
                  : action.href
            }
            action={action}
            act={act}
          />
        ))}
        <Button variant="text" data-ask-manager onClick={() => openManager(card.ask)}>
          Ask manager
        </Button>
        {card.confidence === undefined ? null : (
          <span className="text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">
            {card.confidence}
          </span>
        )}
      </div>
    </Card>
  );
}

function Group({
  name,
  why,
  cards,
  now,
  act,
}: {
  name: string;
  why?: string;
  cards: readonly AttentionCard[];
  now: number;
  act: Act;
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
        <CardView key={card.key} card={card} now={now} act={act} />
      ))}
    </section>
  );
}

function Head({
  count,
  line,
  failed,
  view,
  onView,
  phone,
}: {
  count: number | 'loading' | 'unavailable';
  line: string;
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
          {line}
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

/** What the owner sent from the dashboard today, from `mc.actions`; nothing when there is none or the read failed. */
function Handled({
  factory,
  source,
  now,
}: {
  factory: string;
  source: Source<HandledRow>;
  now: number;
}): ReactElement | null {
  const [open, setOpen] = useState(false);
  const rows = source.state === 'error' ? [] : handledToday(source.rows ?? [], now);
  if (rows.length === 0) return null;
  const handled = rows.filter((row) => row.exit_code === 0);
  const unconfirmed = rows.some((row) => row.exit_code === null);
  return (
    <div data-handled className="mt-[26px] border-t border-[color:var(--v3-line)] pt-3.5">
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">
        <StateDot state={handled.length > 0 ? 'done' : unconfirmed ? 'idle' : 'failed'} />
        {handled.length > 0
          ? `The manager handled ${handled.length} today: ${handledSummary(handled)}.`
          : unconfirmed
            ? 'None of the manager’s actions today is confirmed yet.'
            : 'None of the manager’s actions today went through.'}
        <Button variant="text" aria-expanded={open} onClick={() => setOpen(!open)}>
          See them
        </Button>
      </div>
      {open ? (
        <ul className="m-0 mt-2 list-none p-0">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-2 py-1 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)]"
            >
              <StateDot
                state={row.exit_code === null ? 'idle' : row.exit_code === 0 ? 'done' : 'failed'}
              />
              {row.action === 'answer'
                ? `Answered ${row.option ?? 'with your text'}`
                : `Resumed${row.from_step === null ? '' : ` from ${row.from_step}`}`}
              {row.workflow_name === null ? null : <span>{row.workflow_name}</span>}
              <Link
                to={lapHref(factory, row.run_id)}
                className="font-mono text-[color:var(--v3-you-2)] hover:underline"
              >
                {shortRunId(row.run_id)}
              </Link>
              <span className="ml-auto font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)]">
                {clock(row.sent_at)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The page over its four sources; exported with a fixed clock and view for tests. */
export function AttentionBody({
  factory,
  decide,
  owner,
  unstick,
  failures,
  sweep,
  handled = AWAITED,
  now: fixed,
  view: fixedView,
}: {
  factory: string;
  decide: Source<DecideRow>;
  owner: Source<OwnerQueueRow>;
  unstick: Source<UnstickRow>;
  failures: Source<FailureGroupRow>;
  sweep: Source<SweepRow>;
  handled?: Source<HandledRow>;
  now?: number;
  view?: View;
}): ReactElement {
  const ticking = useNow();
  const now = fixed ?? ticking;
  const phone = usePhone();
  const act: Act = {
    enabled: useActionsEnabled(factory),
    start: useStartAction(),
    pending: useActionPending(),
  };
  const [chosen, setView] = useState<View>('kind');
  const view = fixedView ?? chosen;
  const sources: Record<SourceKey, Source<object>> = { decide, owner, unstick, failures };
  const count = attentionCount(Object.values(sources));
  usePublishPlaceWhat(
    typeof count === 'number' ? (count === 1 ? '1 item' : `${count} items`) : undefined,
  );
  const failed = SOURCE_KEYS.flatMap((k) =>
    sources[k].state === 'error' ? [ATTENTION_SOURCES[k].what] : [],
  );
  // The sweep clause is drawn only from a manager run read now: not through an outage.
  const sweptAt = sweep.state === 'error' ? null : (sweep.rows?.[0]?.swept_at ?? null);
  // Rows kept through an outage are from before it: a failed source draws no cards.
  const live = <R,>(
    s: Source<R>,
    build: (rows: readonly R[]) => AttentionCard[],
  ): AttentionCard[] => (s.state === 'error' ? [] : build(s.rows ?? []));
  const cards: AttentionCard[] = [
    ...live(decide, (rows) => decideCards(rows, factory)),
    ...live(owner, ownerCards),
    ...live(unstick, (rows) => unstickCards(rows, factory)),
    ...live(failures, (rows) => fixCards(rows, factory)),
  ];
  const groups: ReactNode =
    view === 'kind'
      ? byKind(cards).map((g) => (
          <Group key={g.kind} name={g.name} why={g.why} cards={g.cards} now={now} act={act} />
        ))
      : byQueue(cards).map((g) => (
          <Group key={g.queue} name={g.name} cards={g.cards} now={now} act={act} />
        ));
  return (
    <section
      data-attention
      data-attention-count={typeof count === 'number' ? count : undefined}
      className={`max-w-[820px] ${phone ? 'px-4 pt-[18px] pb-6' : 'px-8 pt-[30px] pb-20'}`}
    >
      <Head
        count={count}
        line={sweepLine(factory, sweptAt, now)}
        failed={failed}
        view={view}
        onView={setView}
        phone={phone}
      />
      {groups}
      <Handled factory={factory} source={handled} now={now} />
    </section>
  );
}

type SourceKey = keyof typeof ATTENTION_SOURCES;
const SOURCE_KEYS = Object.keys(ATTENTION_SOURCES) as SourceKey[];

/** Attention (home): what needs the owner, grouped Decide, Unstick, Fix, each with its recommendation first. */
export function Attention({ factory }: { factory: string }): ReactElement {
  const [rows, setRows] = useState<{ [K in SourceKey]: Source<object> }>({
    decide: AWAITED,
    owner: AWAITED,
    unstick: AWAITED,
    failures: AWAITED,
  });
  const [sweep, setSweep] = useState<Source<SweepRow>>(AWAITED);
  const [handled, setHandled] = useState<Source<HandledRow>>(AWAITED);
  const into = useMemo(
    () =>
      Object.fromEntries(
        SOURCE_KEYS.map((k) => [k, (s: Source<object>) => setRows((r) => ({ ...r, [k]: s }))]),
      ) as Record<SourceKey, (s: Source<object>) => void>,
    [],
  );
  return (
    <>
      {SOURCE_KEYS.map((k) => (
        <Feed key={k} query={ATTENTION_SOURCES[k].query} factory={factory} into={into[k]} />
      ))}
      <Feed<SweepRow> query={SWEEP_QUERY} factory={factory} into={setSweep} />
      <Feed<HandledRow> query={HANDLED_QUERY} factory={factory} into={setHandled} />
      <AttentionBody
        factory={factory}
        decide={rows.decide as Source<DecideRow>}
        owner={rows.owner as Source<OwnerQueueRow>}
        unstick={rows.unstick as Source<UnstickRow>}
        failures={rows.failures as Source<FailureGroupRow>}
        sweep={sweep}
        handled={handled}
      />
    </>
  );
}
