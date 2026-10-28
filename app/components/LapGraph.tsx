import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { formatCost, formatCount, formatElapsed } from '../lib/format';
import { type Box, layoutSteps, type StepNode } from '../lib/home-map';
import {
  foldGraph,
  type LaneMark,
  type LapGraph,
  type LapStep,
  STATE_LABEL,
  STATE_TOKEN,
  type StepState,
} from '../lib/lap-graph';
import { costOf, since } from '../lib/laps';
import { errorHeadline } from '../lib/error-text';
import { attemptSeconds } from '../lib/one-lap';
import { GraphViewport } from './GraphViewport';
import { LiveDot } from './LiveDot';

const MONO = 'font-mono text-[12px] tabular-nums';
const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const LINK = 'underline decoration-border-bright underline-offset-2 hover:decoration-text-primary';

const placed = (box: Box) => ({ left: box.x, top: box.y, width: box.width, height: box.height });
const tint = (token: string, percent: number) =>
  `color-mix(in oklch, var(${token}) ${percent}%, transparent)`;

/** `2026-10-24 10:00:30 UTC`: a step's start, to the second, the same for every viewer. */
const utcSecond = (at: Date) => `${at.toISOString().slice(0, 19).replace('T', ' ')} UTC`;

/** A step's mark: a check, a cross, a pulsing dot, a dash, or an empty ring. */
export function StateMark({ state, size = 14 }: { state: StepState; size?: number }): ReactElement {
  if (state === 'running') return <LiveDot size={size - 4} />;
  const color = `var(${STATE_TOKEN[state]})`;
  if (state === 'finished' || state === 'failed') {
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 14 14"
        className="shrink-0"
        data-mark={state}
      >
        <circle cx="7" cy="7" r="7" fill={color} />
        <path
          d={state === 'finished' ? 'M3.8 7.3 6 9.4 10.2 4.8' : 'M4.6 4.6 9.4 9.4 M9.4 4.6 4.6 9.4'}
          fill="none"
          stroke="var(--background)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-mark={state}
      className={`inline-block shrink-0 rounded-full border border-text-secondary ${
        state === 'skipped' ? 'border-dashed' : ''
      }`}
      style={{ width: size - 4, height: size - 4 }}
    />
  );
}

const latestStart = (step: LapStep | undefined) => step?.attempts.at(-1)?.started_at ?? null;

/** The step to show on arrival: the one running now, or else the one that ran last. */
export function focusStep(lap: LapGraph): string | null {
  const nodes = lap.graph.steps;
  const running = nodes.filter((n) => lap.steps.get(n.id)?.state === 'running').at(-1);
  if (running) return running.id;
  let last: { id: string; at: number } | null = null;
  for (const n of nodes) {
    const at = latestStart(lap.steps.get(n.id))?.getTime();
    if (at !== undefined && (last === null || at >= last.at)) last = { id: n.id, at };
  }
  return last?.id ?? null;
}

/** The space kept below a step brought into view on arrival, and above the steps section. */
const ARRIVAL_MARGIN = 24;

/**
 * How far the window scrolls on arrival so `step` is on screen: not at all when it already is
 * (the header, nav and lap summary stay in view), else just enough to bring its bottom above the
 * fold, and never past the top of the steps section, so the section's start stays visible.
 */
export function arrivalScroll(step: Element, section: Element | null | undefined): number {
  const box = step.getBoundingClientRect();
  const fold = window.innerHeight;
  if (box.bottom + ARRIVAL_MARGIN <= fold) return window.scrollY;
  const needed = window.scrollY + box.bottom + ARRIVAL_MARGIN - fold;
  const sectionTop =
    section === null || section === undefined
      ? Number.POSITIVE_INFINITY
      : window.scrollY + section.getBoundingClientRect().top - ARRIVAL_MARGIN;
  return Math.max(window.scrollY, Math.min(needed, sectionTop));
}

/**
 * The lap's steps as the map lays them out, each marked by what happened to it in this lap. A
 * block in which no step ran is one box until opened. A step opens its runs in the side panel.
 * On arrival the page scrolls only as far as it must to show the step running now (or the last
 * one that ran), never past the top of the steps, and not at all once the viewer has scrolled.
 */
export function LapGraphView({
  lap,
  now,
  selected,
  onSelect,
}: {
  lap: LapGraph;
  now: number;
  selected: string | null;
  onSelect: (path: string) => void;
}): ReactElement {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const { graph, folded } = useMemo(() => foldGraph(lap, opened), [lap, opened]);
  const laid = useMemo(() => layoutSteps(graph), [graph]);
  const focus = focusStep(lap);
  const anchor = laid.nodes.get(focus ?? graph.steps[0]?.id ?? '');
  const reached = (path: string) => {
    const state = lap.steps.get(path)?.state;
    return state === 'finished' || state === 'running' || state === 'failed';
  };
  const frame = useRef<HTMLDivElement>(null);
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current || focus === null) return;
    arrived.current = true;
    // Only on arrival, and never over a scroll the viewer already made.
    if (window.scrollY > 0) return;
    const step = frame.current?.querySelector(`[data-graph-step="${CSS.escape(focus)}"]`);
    if (!step) return;
    window.scrollTo({ top: arrivalScroll(step, frame.current?.closest('[data-lap-steps]')) });
  }, [focus]);
  const toggle = (block: string, open: boolean) =>
    setOpened((was) => {
      const next = new Set(was);
      if (open) next.add(block);
      else next.delete(block);
      return next;
    });
  return (
    <GraphViewport label="lap steps" anchorX={anchor ? anchor.x + anchor.width / 2 : 0}>
      <div
        ref={frame}
        className="relative mx-auto"
        style={{ width: laid.width, height: laid.height }}
      >
        <svg
          aria-hidden="true"
          className="absolute inset-0 overflow-visible"
          width={laid.width}
          height={laid.height}
        >
          {laid.edges.map((e) => (
            <path
              key={`${e.from}→${e.to}`}
              d={e.d}
              fill="none"
              stroke={reached(e.from) && reached(e.to) ? 'var(--text-secondary)' : 'var(--border)'}
              strokeWidth={1.5}
            />
          ))}
        </svg>
        {[...laid.clusters].map(([parent, box]) => (
          <div
            key={parent}
            className="absolute rounded-lg border border-dashed border-border-bright"
            style={placed(box)}
          >
            {opened.has(parent) ? (
              <button
                type="button"
                data-fold={parent}
                onClick={() => toggle(parent, false)}
                aria-label={`Fold ${parent} back into one box`}
                className={`${MONO} absolute top-1.5 right-1.5 cursor-pointer rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] text-text-secondary hover:text-text-primary`}
              >
                Fold
              </button>
            ) : null}
          </div>
        ))}
        {graph.steps.map((node) => {
          const box = laid.nodes.get(node.id);
          const step = lap.steps.get(node.id);
          const hidden = folded.get(node.id);
          return box === undefined || step === undefined ? null : (
            <StepBox
              key={node.id}
              node={node}
              step={step}
              box={box}
              now={now}
              selected={selected === node.id}
              folded={hidden}
              onSelect={(path) => {
                if (hidden !== undefined) toggle(path, true);
                onSelect(path);
              }}
            />
          );
        })}
      </div>
    </GraphViewport>
  );
}

function StepBox({
  node,
  step,
  box,
  now,
  selected,
  folded,
  onSelect,
}: {
  node: StepNode;
  step: LapStep;
  box: Box;
  now: number;
  selected: boolean;
  /** How many steps the folded block holds; undefined for a step or an open block. */
  folded?: number;
  onSelect: (path: string) => void;
}): ReactElement {
  const { state } = step;
  const elapsed = state === 'running' ? since(latestStart(step), now) : null;
  const dim = state === 'skipped' || state === 'not-reached';
  const colored = state === 'finished' || state === 'running' || state === 'failed';
  return (
    <button
      type="button"
      data-graph-step={node.id}
      data-step-state={state}
      data-attempts={step.attempts.length}
      data-off-map={step.offMap ? 'true' : undefined}
      data-folded={folded}
      aria-pressed={selected}
      aria-expanded={folded === undefined ? undefined : false}
      aria-label={`${node.id}: ${STATE_LABEL[state]}${
        elapsed === null ? '' : ` for ${formatElapsed(elapsed)}`
      }${folded === undefined ? '. Show its runs.' : `, ${folded} steps inside. Open it.`}`}
      title={`${node.id} · ${STATE_LABEL[state]}${step.offMap ? ' · not on this pin’s map' : ''}`}
      onClick={() => onSelect(node.id)}
      className={`absolute flex cursor-pointer items-center gap-2.5 overflow-hidden rounded-[9px] border px-3 text-left transition-[filter] hover:brightness-125 ${
        state === 'skipped' || step.offMap || folded !== undefined ? 'border-dashed' : ''
      } ${dim ? 'opacity-55' : ''} ${selected ? 'ring-2 ring-text-primary' : ''}`}
      style={{
        ...placed(box),
        background: colored ? tint(STATE_TOKEN[state], 12) : 'var(--surface)',
        borderColor: colored ? tint(STATE_TOKEN[state], 55) : 'var(--border-bright)',
      }}
    >
      <StateMark state={state} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-[13px] font-semibold text-text-primary">
          {node.label}
        </span>
        {folded !== undefined ? (
          <span className="truncate font-mono text-[10px] tabular-nums text-text-secondary">
            {state === 'skipped' ? 'skipped' : 'not run'} · {folded} steps
          </span>
        ) : elapsed !== null ? (
          <span data-elapsed className={`${MONO} text-[11px] text-text-primary`}>
            {formatElapsed(elapsed)}
          </span>
        ) : step.attempts.length > 1 ? (
          <span className={`${MONO} text-[11px] text-text-secondary`}>
            {step.attempts.length} runs
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** One step's runs in this lap: started, duration, model, tokens, cost, for each attempt. */
export function StepPanel({
  lap,
  path,
  now,
  onClose,
}: {
  lap: LapGraph;
  path: string | null;
  now: number;
  onClose: () => void;
}): ReactElement {
  const step = path === null ? undefined : lap.steps.get(path);
  const node = lap.graph.steps.find((n) => n.id === path);
  if (step === undefined || node === undefined) {
    return (
      <aside className="rounded-[10px] border border-border bg-surface px-[18px] py-4">
        <p className="text-sm text-text-secondary">
          Click a step to see when it started, how long it took, its model, tokens and cost.
        </p>
      </aside>
    );
  }
  const cost = step.attempts.reduce((n, a) => n + (costOf(a.cost_usd) ?? 0), 0);
  return (
    <aside
      data-step-panel={step.path}
      data-step-state={step.state}
      className="grid gap-4 rounded-[10px] border border-border-bright bg-surface-elevated px-[18px] py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <span className="flex items-center gap-2">
            <StateMark state={step.state} />
            <span
              className="font-mono text-[11px] font-semibold uppercase tracking-[0.05em]"
              style={{ color: `var(${STATE_TOKEN[step.state]})` }}
            >
              {STATE_LABEL[step.state]}
            </span>
          </span>
          <h3 className="font-mono text-[15px] font-semibold text-text-primary [overflow-wrap:anywhere]">
            {node.label}
          </h3>
          {node.id === node.label ? null : (
            <span className={`${MONO} text-text-secondary [overflow-wrap:anywhere]`}>
              {node.id}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the step's panel"
          className={`${MONO} cursor-pointer rounded-md border border-border bg-surface px-2 py-0.5 text-text-secondary hover:text-text-primary`}
        >
          Close
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <PanelField label="Attempts">{step.attempts.length}</PanelField>
        <PanelField label="Cost">
          {step.attempts.length === 0 ? 'none' : formatCost(cost)}
        </PanelField>
      </dl>
      {step.attempts.length === 0 ? (
        <p className="text-sm text-text-secondary">
          {step.state === 'not-reached'
            ? 'The lap has not reached this step.'
            : step.state === 'skipped'
              ? 'The lap went past this step without running it: its route or depth did not need it.'
              : 'Archon reports no run of its own for this step: its state is the steps inside it.'}
        </p>
      ) : (
        <ol className="grid gap-3">
          {[...step.attempts].reverse().map((attempt, i) => {
            const seconds = attemptSeconds(attempt, now);
            const attemptCost = costOf(attempt.cost_usd);
            return (
              <li
                key={`${attempt.started_at?.toISOString() ?? 'no start'} ${attempt.status}`}
                data-panel-attempt
                className="grid gap-2 rounded-lg border border-border bg-surface px-3 py-2.5"
              >
                <span className={`${LABEL}`}>
                  Attempt {step.attempts.length - i} · {attempt.status}
                  {attempt.outcome === null ? '' : ` · ${attempt.outcome}`}
                </span>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <PanelField label="Started">
                    {attempt.started_at === null ? 'no start' : utcSecond(attempt.started_at)}
                  </PanelField>
                  <PanelField label={attempt.status === 'running' ? 'Running for' : 'Duration'}>
                    {seconds === null ? 'none' : formatElapsed(seconds)}
                  </PanelField>
                  <PanelField label="Model">{attempt.model ?? 'none'}</PanelField>
                  <PanelField label="Cost">
                    {attemptCost === null ? 'none' : formatCost(attemptCost)}
                  </PanelField>
                  <PanelField label="Tokens in / out">
                    {attempt.tokens_input === null && attempt.tokens_output === null
                      ? 'none'
                      : `${formatCount(attempt.tokens_input ?? 0)} / ${formatCount(attempt.tokens_output ?? 0)}`}
                  </PanelField>
                  <PanelField label="Cache read / write">
                    {attempt.tokens_cache_read === null && attempt.tokens_cache_write === null
                      ? 'none'
                      : `${formatCount(attempt.tokens_cache_read ?? 0)} / ${formatCount(attempt.tokens_cache_write ?? 0)}`}
                  </PanelField>
                </dl>
                {attempt.error === null ? null : <AttemptError error={attempt.error} />}
              </li>
            );
          })}
        </ol>
      )}
      {step.offMap ? (
        <p className="text-[12px] text-text-secondary">
          This step is not on the map of the lap's pin: it is drawn where its name puts it.
        </p>
      ) : (
        <Link to={node.href} className={`${MONO} w-fit text-text-secondary ${LINK}`}>
          The step's definition
        </Link>
      )}
    </aside>
  );
}

/** The thrown message first, clamped to a few lines; the full text, as recorded, one click away. */
export function AttemptError({ error }: { error: string }): ReactElement {
  const { headline, more } = errorHeadline(error);
  return (
    <div data-attempt-error className="grid gap-1.5">
      <p
        data-error-headline
        className="line-clamp-4 text-[12px] text-text-primary [overflow-wrap:anywhere]"
      >
        <span style={{ color: 'var(--error)' }}>Error </span>
        {headline}
      </p>
      {more ? (
        <details>
          <summary
            className={`${MONO} w-fit cursor-pointer list-none text-[11px] text-text-secondary underline decoration-dotted underline-offset-2 hover:text-text-primary [&::-webkit-details-marker]:hidden`}
          >
            Show full error
          </summary>
          <pre
            data-error-full
            className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed text-text-secondary whitespace-pre"
          >
            {error}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function PanelField({
  label,
  children,
}: {
  label: string;
  children: ReactElement | string | number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className={LABEL}>{label}</dt>
      <dd className={`${MONO} text-text-primary [overflow-wrap:anywhere]`}>{children}</dd>
    </div>
  );
}

/** A lane's row of the loop's top-level steps: how far through the loop the lap is. */
export function LaneMarks({ marks }: { marks: readonly LaneMark[] }): ReactElement {
  return (
    <ol data-loop-marks className="flex flex-wrap items-center gap-x-0.5 gap-y-1.5">
      {marks.map((mark, i) => {
        const dim = mark.state === 'skipped' || mark.state === 'not-reached';
        return (
          <li
            key={mark.step}
            data-loop-mark={mark.step}
            data-step-state={mark.state}
            className="flex items-center gap-0.5"
          >
            {i === 0 ? null : (
              <span
                aria-hidden="true"
                className={`h-px w-1.5 ${dim ? 'bg-border' : 'bg-text-secondary'}`}
              />
            )}
            <span
              className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 ${
                dim ? 'opacity-55' : ''
              } ${mark.state === 'skipped' ? 'border-dashed' : ''}`}
              style={{
                borderColor:
                  mark.state === 'running' || mark.state === 'failed' || mark.state === 'finished'
                    ? tint(STATE_TOKEN[mark.state], 50)
                    : 'var(--border)',
                background: mark.state === 'running' ? tint('--running', 14) : 'transparent',
              }}
            >
              <StateMark state={mark.state} size={12} />
              <span
                className={`font-mono text-[11px] ${
                  mark.state === 'running' ? 'text-text-primary' : 'text-text-secondary'
                }`}
              >
                {mark.step}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
