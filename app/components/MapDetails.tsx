import { type ReactElement, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import type { StepRow } from '../lib/step-detail';
import { type Card, pinnedStepLinks, workflowFile } from '../map/factory-map';
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
      {item.number === null ? null : (
        <span className="font-mono tabular-nums">#{item.number} </span>
      )}
      {item.title}
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
export function RightNow({
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
        {lap.issue?.url ? (
          <a href={lap.issue.url} data-lap-issue className={`${LINK} ml-1.5 font-mono text-[12px]`}>
            GitHub #{lap.issue.number}
          </a>
        ) : null}
        <span className={CHIP}>{lap.step}</span>
      </li>
    )),
    ...(live?.unavailable ?? []).map((chip) => (
      <li key={`unavailable-${chip}`} className="text-text-secondary">
        The {chip} count is unavailable.
      </li>
    )),
    ...(live?.queued ?? []).map((item) => <Item key={item.key} item={item} note="queued" />),
    ...(live?.failing ?? []).map((item) => (
      <Item key={item.key} item={item} note="app check failed" />
    )),
    ...(live?.waiting ?? []).map((item) => <Item key={item.key} item={item} note="waiting" />),
    ...(live?.merged ?? []).map((merge) => (
      <li key={`merged-${merge.run}-${merge.number ?? 'lap'}`} data-lap={merge.run}>
        <Link to={lapHref(merge.run)} className={LINK}>
          {merge.number === null ? (
            <span className="font-mono">lap {merge.run.slice(0, 8)}</span>
          ) : (
            <span className="font-mono tabular-nums">#{merge.number}</span>
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

/**
 * The steps the card covers that the pinned version has, each opening its step screen with the
 * model the parsed architecture gives it (owner, #307): never a step or a path the version lacks.
 */
export function Behind({
  card,
  at,
  steps,
  failed,
}: {
  card: Card;
  at: string | null;
  steps: readonly StepRow[] | undefined;
  failed: boolean;
}): ReactElement {
  if (card.covers.length === 0) {
    return <p className="text-text-secondary">This card runs no workflow step.</p>;
  }
  if (failed) return <p className="text-text-secondary">The pinned steps are unavailable.</p>;
  if (steps === undefined) return <p className="text-text-secondary">Loading the pinned steps.</p>;
  const links = pinnedStepLinks(card, at, steps);
  if (links.length === 0) {
    return <p className="text-text-secondary">This version has none of this card's steps.</p>;
  }
  const workflows = [...new Set(links.map((l) => l.workflow))];
  const covered = card.covers
    .filter((cover) => steps.some((s) => s.workflow === cover.workflow))
    .reduce((n, cover) => n + cover.steps.length, 0);
  return (
    <>
      {workflows.map((workflow) => (
        <div key={workflow} data-behind-workflow={workflow} className="grid gap-1.5">
          <div className="font-mono text-[12px] text-text-secondary">
            {workflow}
            <span data-workflow-file className="ml-2">
              {workflowFile(steps, workflow)}
            </span>
          </div>
          <ul className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-[12.5px]">
            {links
              .filter((l) => l.workflow === workflow)
              .map((link) => (
                <li key={link.step} className="contents">
                  <Link
                    to={link.href}
                    data-step-link={`${link.workflow} ${link.step}`}
                    className={LINK}
                  >
                    {link.step}
                  </Link>
                  <span className="text-text-secondary">
                    {link.model === null ? 'no model' : `model ${link.model}`}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ))}
      <p className={`${LABEL} mt-1.5`}>
        From the pinned code. The map check fails if any of these names disappear.
      </p>
      {links.length < covered && (
        <p data-steps-missing className={LABEL}>
          Steps this card covers that are not listed are not in this version.
        </p>
      )}
    </>
  );
}

/** The details strip under the map for the card clicked: its tabs and what each says. */
export function MapDetails({
  card,
  live,
  factory,
  at,
  steps,
  stepsFailed = false,
  onClose,
  className = '',
}: {
  className?: string;
  steps: readonly StepRow[] | undefined;
  stepsFailed?: boolean;
  card: Card;
  live: CardLive | undefined;
  factory: string;
  at: string | null;
  onClose: () => void;
}): ReactElement {
  const { details } = card;
  const tabs = TABS.filter(
    ({ tab }) =>
      tab === 'live' || (tab === 'behind' ? card.covers.length > 0 : details[tab] !== undefined),
  );
  const [chosen, setChosen] = useState<Tab>('when');
  const tab = tabs.some((t) => t.tab === chosen) ? chosen : (tabs[0]?.tab ?? 'live');
  return (
    <section
      data-details={card.id}
      aria-label={`${card.title} details`}
      className={`${className} mt-3.5`}
    >
      <div className="rounded-xl border border-border bg-surface">
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
            <Behind card={card} at={at} steps={steps} failed={stepsFailed} />
          ) : (
            <Bullets lines={details[tab] ?? []} />
          )}
        </div>
      </div>
    </section>
  );
}
