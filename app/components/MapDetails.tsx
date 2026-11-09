import { type ReactElement, type ReactNode, useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { AppCheckRow } from '../lib/app-check';
import { boardHref, orderPanel, orderProgress } from '../lib/board';
import { relativeTime } from '../lib/format';
import { lapHref } from '../lib/one-lap';
import { stateColor } from '../lib/states';
import { type StepRow, stepOriginState } from '../lib/step-detail';
import { LivePanel } from '../live/LivePanel';
import { type Card, type Chip, pinnedStepLinks, workflowFile } from '../map/factory-map';
import {
  type CardLive,
  type GateOutcome,
  type LatestDeploy,
  type MapItem,
  overdueHealth,
  type ProductDocumentRow,
  type WorkOrderRow,
} from '../map/live';
import { useNow } from './panel';
import { Button } from './ui/Button';
import { Card as CardPanel } from './ui/Card';
import { Tabs } from './ui/Tabs';

type Tab = 'about' | 'live' | 'behind';

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'about', label: 'About' },
  { tab: 'live', label: 'Right now' },
  { tab: 'behind', label: 'Behind the scenes' },
];

const LABEL = 'font-mono text-[11px] uppercase tracking-[0.08em] text-[color:var(--v3-fg-2)]';
const LINK = 'text-[color:var(--v3-you-2)] hover:underline';
const CHIP =
  'ml-1.5 whitespace-nowrap rounded-[5px] bg-[var(--v3-raised)] px-1.5 py-px font-mono text-[10.5px] text-[color:var(--v3-fg-2)]';

/** The card's own words, in one tab: when it runs, what it does, how it works. */
const ABOUT: { key: 'when' | 'what' | 'how'; label: string }[] = [
  { key: 'when', label: 'When it runs' },
  { key: 'what', label: 'What it does' },
  { key: 'how', label: 'How it works' },
];

function About({ details }: { details: Card['details'] }): ReactElement {
  return (
    <div className="grid gap-3.5">
      {ABOUT.filter(({ key }) => details[key] !== undefined).map(({ key, label }) => (
        <div key={key} data-about={key} className="grid gap-1.5">
          <div className={LABEL}>{label}</div>
          <Bullets lines={details[key] ?? []} />
        </div>
      ))}
    </div>
  );
}

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

/** A work order as the Board counts it, linking to the Board filtered to it. */
function Order({ order, factory }: { order: WorkOrderRow; factory: string }): ReactElement {
  return (
    <li data-work-order={order.name}>
      <Link to={boardHref(factory, order.name)} className={`${LINK} font-mono`}>
        {order.name}
      </Link>
      <span className={CHIP}>{orderProgress(orderPanel(order))}</span>
    </li>
  );
}

const UNAVAILABLE = {
  documents: 'The product documents are unavailable.',
  outcomes: 'The recent gate decisions are unavailable.',
  deploys: 'The latest deploy is unavailable.',
  lands: 'Where the work orders land is unavailable.',
  choices: 'The open work orders are unavailable.',
} as const;

/** One pull request in the gate's recent decisions: merged as read back, or the sweep's send-back or ask, with its reason. */
function Gate({ outcome }: { outcome: GateOutcome }): ReactElement {
  return (
    <li data-gate-outcome={outcome.number}>
      <a href={outcome.url} className={`${LINK} font-mono tabular-nums`}>
        #{outcome.number}
      </a>
      <span className={CHIP}>{outcome.outcome}</span>
      <span className="ml-1.5 text-[color:var(--v3-fg-2)]">{outcome.reason}</span>
    </li>
  );
}

function Deploy({ deploy }: { deploy: LatestDeploy | null }): ReactElement {
  if (deploy === null) return <li data-latest-deploy>This factory has never deployed.</li>;
  const revision = deploy.revision === null ? null : deploy.revision.slice(0, 7);
  const name = <span className="font-mono">{revision ?? 'no revision'}</span>;
  return (
    <li data-latest-deploy>
      {deploy.verified ? (
        <>
          {name} is deployed, healthy, and its revision{' '}
          {deploy.readBack ? 'read back' : 'not read back'}
        </>
      ) : (
        <>
          {name}: the last deploy failed, health {deploy.health ?? 'not reported'}
        </>
      )}
      {deploy.at === null ? null : (
        <span className={CHIP}>{relativeTime(deploy.at.toISOString())}</span>
      )}
    </li>
  );
}

/** A product document with the work items its split recorded, merged over total, drawn as a bar. */
function ProductDocument({ document }: { document: ProductDocumentRow }): ReactElement {
  const { number, title, url, total_count: total, merged_count: merged } = document;
  const percent = total === 0 ? 0 : Math.round((merged / total) * 100);
  return (
    <li data-product-document={number} className="grid gap-1">
      <span>
        <a href={url} className={LINK}>
          <span className="font-mono tabular-nums">#{number}</span> {title}
        </a>
        <span className={CHIP}>
          {total === 0 ? 'no work items recorded' : `${merged}/${total} merged`}
        </span>
      </span>
      <div
        role="progressbar"
        aria-label={`#${number}: ${merged} of ${total} merged`}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={merged}
        className="h-1.5 overflow-hidden rounded-full bg-[var(--v3-sunk)]"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${percent}%`, background: stateColor('done') }}
        />
      </div>
    </li>
  );
}

const time = (at: Date) =>
  at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** A run's name, linking to its page. */
function RunName({ href, children }: { href: string; children: ReactNode }): ReactElement {
  return (
    <Link to={href} className={LINK}>
      {children}
    </Link>
  );
}

/** The issues and laps on the card now, each opening its lap page when it has one. */
export function RightNow({
  live,
  factory,
}: {
  live: CardLive | undefined;
  factory: string;
}): ReactElement {
  const ticking = useNow();
  // A mapped type: a chip without rows here fails type-check.
  const chipRows: { [K in Chip]: ReactNode[] } = {
    queued: (live?.queued ?? []).map((item) => <Item key={item.key} item={item} note="queued" />),
    failing: (live?.failing ?? []).map((item) => (
      <Item key={item.key} item={item} note="app check failed" />
    )),
    waiting: (live?.questions ?? live?.waiting ?? []).map((item) => (
      <Item key={item.key} item={item} note={item.note ?? 'waiting'} />
    )),
    orders: [...(live?.orders ?? []), ...(live?.choices ?? [])].map((order) => (
      <Order key={`order-${order.name}`} order={order} factory={factory} />
    )),
    merged: (live?.merged ?? []).map((merge) => (
      <li key={`merged-${merge.run}-${merge.number ?? 'lap'}`} data-lap={merge.run}>
        <RunName href={lapHref(factory, merge.run)}>
          {merge.number === null ? (
            <span className="font-mono">lap {merge.run.slice(0, 8)}</span>
          ) : (
            <span className="font-mono tabular-nums">#{merge.number}</span>
          )}
        </RunName>
        <span className={CHIP}>merged {time(merge.at)}</span>
      </li>
    )),
  };
  const rows: ReactNode[] = [
    ...(live?.here ?? []).map((lap) => (
      <li key={`lap-${lap.run}`} data-lap={lap.run}>
        <RunName href={lapHref(factory, lap.run)}>
          {lap.issue ? (
            <>
              <span className="font-mono tabular-nums">#{lap.issue.number}</span>{' '}
              {lap.issue.title ?? ''}
            </>
          ) : (
            <span className="font-mono">lap {lap.run.slice(0, 8)}</span>
          )}
        </RunName>
        {lap.issue?.url ? (
          <a href={lap.issue.url} data-lap-issue className={`${LINK} ml-1.5 font-mono text-[12px]`}>
            GitHub #{lap.issue.number}
          </a>
        ) : null}
        <span className={CHIP}>{lap.step}</span>
      </li>
    )),
    ...(live?.skipped ?? []).map((lap) => (
      <li key={`skipped-${lap.run}`} data-skipped={lap.run}>
        {lap.issue ? (
          <span className="font-mono tabular-nums">#{lap.issue.number} </span>
        ) : (
          <span className="font-mono">lap {lap.run.slice(0, 8)} </span>
        )}
        This change did not earn this reviewer.
      </li>
    )),
    ...(live?.unavailable ?? []).map((chip) => (
      <li key={`unavailable-${chip}`} className="text-[color:var(--v3-fg-2)]">
        The {chip} count is unavailable.
      </li>
    )),
    ...chipRows.queued,
    ...chipRows.failing,
    ...chipRows.waiting,
    ...(live?.healthUnavailable
      ? [
          <li key="health-unavailable" className="text-[color:var(--v3-fg-2)]">
            The factory's health is unavailable.
          </li>,
        ]
      : []),
    ...[...(live?.health ?? []), ...overdueHealth(live?.steps ?? [], ticking)].map((item) => (
      <li key={item.key} data-health={item.key}>
        {item.url ? (
          <a href={item.url} className={`${LINK} font-mono`}>
            run {item.run.slice(0, 8)}
          </a>
        ) : (
          <span className="font-mono">run {item.run.slice(0, 8)}</span>
        )}
        <span className={CHIP}>{item.note}</span>
      </li>
    )),
    ...chipRows.orders,
    ...(live?.documents ?? []).map((document) => (
      <ProductDocument key={`document-${document.number}`} document={document} />
    )),
    ...(live?.documents?.length === 0
      ? [
          <li key="no-documents" className="text-[color:var(--v3-fg-2)]">
            No product document is open.
          </li>,
        ]
      : []),
    ...chipRows.merged,
    ...(live?.listsUnavailable ?? []).map((list) => (
      <li key={`unavailable-list-${list}`} className="text-[color:var(--v3-fg-2)]">
        {UNAVAILABLE[list]}
      </li>
    )),
    ...(live?.gate?.map((outcome) => (
      <Gate key={`gate-${outcome.run}-${outcome.number}`} outcome={outcome} />
    )) ?? []),
    ...(live?.gate?.length === 0
      ? [
          <li key="gate-none" className="text-[color:var(--v3-fg-2)]">
            No gate decision is recorded for this factory yet.
          </li>,
        ]
      : []),
    ...(live?.deploy === undefined ? [] : [<Deploy key="latest-deploy" deploy={live.deploy} />]),
    ...(live?.lands ?? []).map((order) => (
      <li key={`lands-${order.name}`} data-lands={order.name}>
        <span className="font-mono">{order.name}</span>{' '}
        {order.lands_on === null ? 'names no target yet' : `lands on ${order.lands_on}`}
      </li>
    )),
  ];
  return rows.length === 0 ? (
    <p className="text-[color:var(--v3-fg-2)]">Nothing on this step right now.</p>
  ) : (
    <ul className="grid gap-[5px]">{rows}</ul>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The open pull requests the app check has looked at: its latest verdict, and its lines by kind. */
export function AppCheckList({ rows }: { rows: readonly AppCheckRow[] }): ReactElement {
  return rows.length === 0 ? (
    <p className="text-[color:var(--v3-fg-2)]">No open pull request has been checked.</p>
  ) : (
    <ul className="grid gap-[5px]">
      {rows.map((row) => (
        <li key={row.number} data-app-check={row.number}>
          <span className="font-mono tabular-nums">#{row.number} </span>
          {row.url ? (
            <a href={row.url} className={LINK}>
              {row.title}
            </a>
          ) : (
            row.title
          )}
          <span className={CHIP}>{row.overall ?? 'checking'}</span>
          <span className={CHIP}>
            {count(row.criteria, 'criterion', 'criteria')}, {count(row.probes, 'probe', 'probes')},{' '}
            {count(row.assertions, 'assertion', 'assertions')}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AppChecks({ factory }: { factory: string }): ReactElement {
  return (
    <LivePanel<AppCheckRow> query="app-check" factory={factory} className="grid gap-[5px]">
      {(rows, state) => (
        <>
          <p className={LABEL}>Pull requests under check</p>
          {rows === undefined || state !== 'ready' ? (
            <p className="text-[color:var(--v3-fg-2)]">
              {state === 'error' ? 'The pull requests under check are unavailable.' : 'Loading.'}
            </p>
          ) : (
            <AppCheckList rows={rows} />
          )}
        </>
      )}
    </LivePanel>
  );
}

/**
 * The steps the card covers that the pinned version has, each opening its step screen with the
 * model the parsed architecture gives it (owner, #307): never a step or a path the version lacks.
 */
export function Behind({
  card,
  factory,
  at,
  steps,
  failed,
}: {
  card: Card;
  factory: string;
  at: string | null;
  steps: readonly StepRow[] | undefined;
  failed: boolean;
}): ReactElement {
  const { pathname, search } = useLocation();
  if (card.covers.length === 0) {
    return <p className="text-[color:var(--v3-fg-2)]">This card runs no workflow step.</p>;
  }
  if (failed)
    return <p className="text-[color:var(--v3-fg-2)]">The pinned steps are unavailable.</p>;
  if (steps === undefined)
    return <p className="text-[color:var(--v3-fg-2)]">Loading the pinned steps.</p>;
  const links = pinnedStepLinks(card, factory, at, steps);
  if (links.length === 0) {
    return (
      <p className="text-[color:var(--v3-fg-2)]">This version has none of this card's steps.</p>
    );
  }
  const workflows = [...new Set(links.map((l) => l.workflow))];
  const covered = card.covers
    .filter((cover) => steps.some((s) => s.workflow === cover.workflow))
    .reduce((n, cover) => n + cover.steps.length, 0);
  return (
    <>
      {workflows.map((workflow) => (
        <div key={workflow} data-behind-workflow={workflow} className="grid gap-1.5">
          <div className="font-mono text-[12px] text-[color:var(--v3-fg-2)]">
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
                    state={stepOriginState({
                      href: `${pathname}${search}`,
                      label: `Factory / ${card.title}`,
                      card: card.id,
                    })}
                    data-step-link={`${link.workflow} ${link.step}`}
                    className={LINK}
                  >
                    {link.step}
                  </Link>
                  <span className="text-[color:var(--v3-fg-2)]">
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
  open,
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
  /** Present for a card that opens a deeper view. */
  open?: { title: string; steps: number; onOpen: () => void };
}): ReactElement {
  const { details } = card;
  const tabs = TABS.filter(
    ({ tab }) =>
      tab === 'live' ||
      (tab === 'behind'
        ? card.covers.length > 0
        : ABOUT.some(({ key }) => details[key] !== undefined)),
  );
  const [chosen, setChosen] = useState<Tab>('about');
  const tab = tabs.some((t) => t.tab === chosen) ? chosen : (tabs[0]?.tab ?? 'live');
  return (
    <section
      data-details={card.id}
      aria-label={`${card.title} details`}
      className={`${className} mt-3.5`}
    >
      <CardPanel>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-[color:var(--v3-line)] px-4 py-3.5">
          <div>
            <div className={LABEL}>{card.kind}</div>
            <h2 className="m-0 text-[17px] font-semibold text-[color:var(--v3-fg)]">
              {card.title}
            </h2>
          </div>
          <span className="flex-1" />
          {open ? (
            <Button variant="secondary" data-open-view onClick={open.onOpen}>
              ⤢ Open {open.title} · {open.steps} steps
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} aria-label="Close details">
            ✕
          </Button>
        </div>
        <Tabs
          label={`${card.title} tabs`}
          tabs={tabs.map((t) => ({ value: t.tab, label: t.label }))}
          value={tab}
          onChange={setChosen}
        />
        <div
          role="tabpanel"
          className="grid max-w-[96ch] gap-2.5 px-4 pt-3.5 pb-[18px] text-sm text-[color:var(--v3-fg)]"
        >
          {tab === 'live' ? (
            <>
              <RightNow live={live} factory={factory} />
              {card.lists?.includes('checks') ? <AppChecks factory={factory} /> : null}
            </>
          ) : tab === 'behind' ? (
            <Behind card={card} factory={factory} at={at} steps={steps} failed={stepsFailed} />
          ) : (
            <About details={details} />
          )}
        </div>
      </CardPanel>
    </section>
  );
}
