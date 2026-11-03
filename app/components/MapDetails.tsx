import { type ReactElement, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { type Card, stepLinks } from '../map/factory-map';
import type { CardLive, MapItem } from '../map/live';

type Tab = 'when' | 'what' | 'how' | 'live' | 'behind';

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'when', label: 'When it runs' },
  { tab: 'what', label: 'What it does' },
  { tab: 'how', label: 'How it works' },
  { tab: 'live', label: 'Right now' },
  { tab: 'behind', label: 'Behind the scenes' },
];

const LABEL = 'font-mono text-[11px] uppercase tracking-[0.08em] text-text-secondary';
const LINK = 'text-[color:var(--accent-bright)] hover:underline';
const CHIP =
  'ml-1.5 whitespace-nowrap rounded-[5px] bg-surface-elevated px-1.5 py-px font-mono text-[10.5px] text-text-secondary';

function Bullets({ lines }: { lines: readonly string[] }): ReactElement {
  return (
    <ul className="grid list-disc gap-[5px] pl-[18px]">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** An issue, a pull request or a question, linking to GitHub when it is mirrored. */
function Item({ item, note }: { item: MapItem; note: string }): ReactElement {
  const name = (
    <>
      <span className="font-mono tabular-nums">#{item.number}</span> {item.title}
    </>
  );
  return (
    <li data-item={item.key}>
      {item.url ? (
        <a href={item.url} className={LINK}>
          {name}
        </a>
      ) : (
        name
      )}
      <span className={CHIP}>{note}</span>
    </li>
  );
}

const time = (at: Date) =>
  at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** The issues and laps on the card now, each opening its page. */
function RightNow({
  live,
  factory,
}: {
  live: CardLive | undefined;
  factory: string;
}): ReactElement {
  const lapHref = (run: string) => `/f/${encodeURIComponent(factory)}/laps/${run}`;
  const rows: ReactNode[] = [
    ...(live?.here ?? []).map((lap) => (
      <li key={`lap-${lap.run}`} data-lap={lap.run}>
        <Link to={lapHref(lap.run)} className={LINK}>
          {lap.issue ? (
            <>
              <span className="font-mono tabular-nums">#{lap.issue.number}</span>{' '}
              {lap.issue.title ?? ''}
            </>
          ) : (
            <span className="font-mono">lap {lap.run.slice(0, 8)}</span>
          )}
        </Link>
        <span className={CHIP}>{lap.step}</span>
      </li>
    )),
    ...(live?.queued ?? []).map((item) => <Item key={item.key} item={item} note="queued" />),
    ...(live?.failing ?? []).map((item) => (
      <Item key={item.key} item={item} note="app check failed" />
    )),
    ...(live?.waiting ?? []).map((item) => <Item key={item.key} item={item} note="waiting" />),
    ...(live?.merged ?? []).map((merge) => (
      <li key={`merged-${merge.run}`} data-lap={merge.run}>
        <Link to={lapHref(merge.run)} className={LINK}>
          {merge.issue === null ? (
            <span className="font-mono">lap {merge.run.slice(0, 8)}</span>
          ) : (
            <span className="font-mono tabular-nums">#{merge.issue}</span>
          )}
        </Link>
        <span className={CHIP}>merged {time(merge.at)}</span>
      </li>
    )),
  ];
  return rows.length === 0 ? (
    <p className="text-text-secondary">Nothing on this step right now.</p>
  ) : (
    <ul className="grid gap-[5px]">{rows}</ul>
  );
}

/** The workflows and steps the card covers, each opening its step screen, its models and source. */
function Behind({ card, at }: { card: Card; at: string | null }): ReactElement {
  const { models, source } = card.details.behind ?? {};
  const term = 'font-mono text-[12px] text-text-secondary';
  const value = 'm-0 min-w-0 font-mono text-[12.5px] [overflow-wrap:anywhere]';
  return (
    <>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        {card.covers.length > 0 ? (
          <>
            <dt className={term}>workflows</dt>
            <dd className={value}>{card.covers.map((c) => c.workflow).join(' · ')}</dd>
            <dt className={term}>steps</dt>
            <dd className={value}>
              <ul className="flex flex-wrap gap-x-3 gap-y-1">
                {stepLinks(card, at).map((link) => (
                  <li key={`${link.workflow} ${link.step}`}>
                    <Link
                      to={link.href}
                      data-step-link={`${link.workflow} ${link.step}`}
                      className={LINK}
                    >
                      {link.step}
                    </Link>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {models ? (
          <>
            <dt className={term}>models</dt>
            <dd className={value}>{models}</dd>
          </>
        ) : null}
        {source ? (
          <>
            <dt className={term}>source</dt>
            <dd className={value}>{source}</dd>
          </>
        ) : null}
      </dl>
      <p className={`${LABEL} mt-1.5`}>
        From the pinned code. The map check fails if any of these names disappear.
      </p>
    </>
  );
}

/** The details strip under the map for the card clicked: its tabs and what each says. */
export function MapDetails({
  card,
  live,
  factory,
  at,
  onClose,
}: {
  card: Card;
  live: CardLive | undefined;
  factory: string;
  at: string | null;
  onClose: () => void;
}): ReactElement {
  const { details } = card;
  const tabs = TABS.filter(
    ({ tab }) =>
      tab === 'live' ||
      (tab === 'behind'
        ? details.behind !== undefined || card.covers.length > 0
        : details[tab] !== undefined),
  );
  const [chosen, setChosen] = useState<Tab>('when');
  const tab = tabs.some((t) => t.tab === chosen) ? chosen : (tabs[0]?.tab ?? 'live');
  return (
    <section
      data-details={card.id}
      aria-label={`${card.title} details`}
      className="mt-3.5 rounded-xl border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-border px-4 py-3.5">
        <div>
          <div className={LABEL}>{card.kind}</div>
          <h2 className="m-0 text-[17px] font-semibold text-text-primary">{card.title}</h2>
        </div>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="cursor-pointer rounded-[7px] border border-border bg-surface-elevated px-3 py-1.5 text-[13px] font-semibold text-text-primary hover:bg-surface-hover"
        >
          ✕
        </button>
      </div>
      <div role="tablist" className="flex gap-0.5 overflow-x-auto border-b border-border px-2.5">
        {tabs.map((t) => (
          <button
            key={t.tab}
            type="button"
            role="tab"
            aria-selected={t.tab === tab}
            data-tab={t.tab}
            onClick={() => setChosen(t.tab)}
            className={`cursor-pointer whitespace-nowrap border-b-2 px-2.5 py-[9px] text-sm ${
              t.tab === tab
                ? 'border-[color:var(--accent)] text-text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        className="grid max-w-[96ch] gap-2.5 px-4 pt-3.5 pb-[18px] text-sm text-text-primary"
      >
        {tab === 'live' ? (
          <RightNow live={live} factory={factory} />
        ) : tab === 'behind' ? (
          <Behind card={card} at={at} />
        ) : (
          <Bullets lines={details[tab] ?? []} />
        )}
      </div>
    </section>
  );
}
