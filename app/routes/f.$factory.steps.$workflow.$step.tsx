import { type ReactElement, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { StepVersionPicker } from '../components/StepVersionPicker';
import { CARD as PANEL } from '../components/ui/Card';
import {
  AT_PARAM,
  dependents,
  isIncluded,
  joinParts,
  kindLabel,
  type NestingRow,
  nesting,
  type PartRow,
  type Placed,
  placeOf,
  placesOf,
  type StepRow,
  type SubagentRow,
  stepHref,
  stepOriginOf,
  versionName,
  type YamlPartRow,
} from '../lib/step-detail';
import { useFactory } from '../live/FactoryProvider';
import { LivePanel, type PanelState } from '../live/LivePanel';
import { FACTORY_MAP, mapOrigin, selectState } from '../map/factory-map';

const LABEL =
  'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-[color:var(--v3-fg-2)]';
const CARD = `${PANEL} flex flex-col gap-3 p-5`;
const CODE =
  'whitespace-pre-wrap rounded-md border border-[color:var(--v3-line)] bg-[var(--v3-sunk)] p-4 font-mono text-[12px] leading-relaxed text-[color:var(--v3-fg)] [overflow-wrap:anywhere]';
const NOTE = 'text-sm text-[color:var(--v3-fg-2)]';
const MONO = 'font-mono text-[13px] text-[color:var(--v3-fg)] [overflow-wrap:anywhere]';

/**
 * A panel of the step at `workflow` and `path`, at the version pinned `at`, else the current one.
 * It asks for its rows from the address alone, at navigation; `step`, the row step-detail found,
 * is needed only to show them, and the panel stays hidden until it is known.
 */
interface PanelProps {
  step: StepRow | undefined;
  workflow: string;
  path: string;
  factory: string | undefined;
  /** The factory the address names, for the links. */
  address: string;
  at: string | null;
}

function Unavailable(): ReactElement {
  return <p className={NOTE}>Live data is unavailable.</p>;
}

/** A panel's heading, then its body once its rows are in: nothing until its step is known. */
function Section({
  title,
  step,
  state,
  children,
}: {
  title: string;
  step: StepRow | undefined;
  state: PanelState;
  children: (step: StepRow) => ReactNode;
}): ReactElement | null {
  if (step === undefined) return null;
  return (
    <>
      <h2 className={LABEL}>{title}</h2>
      {state === 'error' ? <Unavailable /> : state === 'ready' ? children(step) : null}
    </>
  );
}

/** A whole file, folded unless `open`. */
function File({
  path,
  text,
  open = false,
  ...data
}: {
  path: string;
  text: string;
  open?: boolean;
  [attribute: `data-${string}`]: string;
}): ReactElement {
  return (
    <details open={open} className="flex flex-col gap-2">
      <summary className={`cursor-pointer ${MONO}`}>{path}</summary>
      <pre {...data} className={`mt-2 ${CODE}`}>
        {text}
      </pre>
    </details>
  );
}

function Fact({
  label,
  className = MONO,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <>
      <dt className={`${LABEL} sm:pt-0.5`}>{label}</dt>
      <dd className={className}>{children}</dd>
    </>
  );
}

function StepList({ steps, ...data }: { steps: readonly string[]; [a: `data-${string}`]: string }) {
  return steps.length === 0 ? (
    <span {...data}>-</span>
  ) : (
    <span {...data} className="flex flex-wrap gap-x-3 gap-y-1">
      {steps.map((id) => (
        <span key={id}>{id}</span>
      ))}
    </span>
  );
}

/** Every node beneath this step, each opening its place: on an include, the steps it runs. */
function Nesting({ step, workflow, path, factory, address, at }: PanelProps): ReactElement {
  return (
    <LivePanel<NestingRow>
      query="step-nesting"
      factory={factory}
      args={[workflow, path, at ?? '']}
      className={step === undefined ? 'hidden' : undefined}
    >
      {(rows, state) => {
        if (step === undefined) return null;
        if (state === 'error')
          return (
            <div className={CARD}>
              <Unavailable />
            </div>
          );
        if (rows === undefined || rows.length === 0) return null;
        const inside = nesting(rows, address, workflow, path, at);
        return (
          <div className={CARD}>
            <h2 className={LABEL}>Steps inside</h2>
            <ul className="flex flex-col gap-1">
              {inside.map((node) => (
                <li
                  key={node.label}
                  data-inside={node.label}
                  style={{ paddingLeft: node.depth * 16 }}
                >
                  <Link to={node.href} className="flex flex-wrap gap-x-3">
                    <span className={MONO}>{node.label}</span>
                    <span className={NOTE}>{node.kind}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      }}
    </LivePanel>
  );
}

function Prompt({ step, workflow, path, factory, at }: PanelProps): ReactElement {
  return (
    <LivePanel<PartRow>
      query="step-prompt"
      factory={factory}
      args={[workflow, path, at ?? '']}
      className={step === undefined ? 'hidden' : CARD}
    >
      {(rows = [], state) => (
        <Section title="Prompt" step={step} state={state}>
          {(step) => {
            if (step.command_file !== null) {
              const text = joinParts(rows, (row) => row.path).get(step.command_file) ?? '';
              return <File path={step.command_file} text={text} open data-prompt="" />;
            }
            if (step.prompt !== null)
              return (
                <pre data-prompt="" className={CODE}>
                  {step.prompt}
                </pre>
              );
            return <p className={NOTE}>This step runs no prompt.</p>;
          }}
        </Section>
      )}
    </LivePanel>
  );
}

function Subagents({ step, workflow, path, factory, at }: PanelProps): ReactElement {
  return (
    <LivePanel<SubagentRow>
      query="step-subagents"
      factory={factory}
      args={[workflow, path, at ?? '']}
      className={step === undefined ? 'hidden' : CARD}
    >
      {(rows = [], state) => (
        <Section title="Subagents" step={step} state={state}>
          {() => {
            if (rows.length === 0)
              return <p className={NOTE}>This step has no inline subagents.</p>;
            const instructions = joinParts(rows, (row) => row.name);
            const agents = [...new Map(rows.map((row) => [row.name, row])).values()];
            return agents.map((agent) => (
              <article
                key={agent.name}
                data-subagent={agent.name}
                className="flex flex-col gap-2 border-t border-[color:var(--v3-line)] pt-3 first-of-type:border-t-0 first-of-type:pt-0"
              >
                <h3 className="font-mono text-sm font-semibold text-[color:var(--v3-fg)]">
                  {agent.name}
                </h3>
                {agent.description !== null ? <p className={NOTE}>{agent.description}</p> : null}
                {agent.prompt !== null ? <pre className={CODE}>{agent.prompt}</pre> : null}
                {agent.instruction_file !== null ? (
                  <File
                    path={agent.instruction_file}
                    text={instructions.get(agent.name) ?? ''}
                    data-instructions={agent.name}
                  />
                ) : null}
              </article>
            ));
          }}
        </Section>
      )}
    </LivePanel>
  );
}

function Scripts({ step, workflow, path, factory, at }: PanelProps): ReactElement {
  return (
    <LivePanel<PartRow>
      query="step-scripts"
      factory={factory}
      args={[workflow, path, at ?? '']}
      className={step === undefined ? 'hidden' : CARD}
    >
      {(rows = [], state) => (
        <Section title="Scripts" step={step} state={state}>
          {(step) => {
            const runtime =
              step.runtime !== null ? <Fact label="Runtime">{step.runtime}</Fact> : null;
            let body: ReactNode;
            if (step.script_file !== null) {
              const text = joinParts(rows, (row) => row.path).get(step.script_file) ?? '';
              body = <File path={step.script_file} text={text} data-script="" />;
            } else if (step.script !== null || step.bash !== null) {
              body = (
                <pre data-script="" className={CODE}>
                  {step.script ?? step.bash}
                </pre>
              );
            } else {
              return <p className={NOTE}>This step runs no script.</p>;
            }
            return (
              <>
                {runtime ? (
                  <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr]">{runtime}</dl>
                ) : null}
                {body}
              </>
            );
          }}
        </Section>
      )}
    </LivePanel>
  );
}

function Yaml({ step, workflow, path, factory, at }: PanelProps): ReactElement {
  return (
    <LivePanel<YamlPartRow>
      query="step-yaml"
      factory={factory}
      args={[workflow, path, at ?? '']}
      className={step === undefined ? 'hidden' : CARD}
    >
      {(rows = [], state) => (
        <Section title="Workflow YAML" step={step} state={state}>
          {(step) => (
            <File
              path={step.file}
              text={joinParts(rows, (row) => row.name).get(step.defined_in) ?? ''}
              data-yaml={step.defined_in}
            />
          )}
        </Section>
      )}
    </LivePanel>
  );
}

/** The routing a place gives its step: each enclosing node, from the outermost in. */
function WhereItRuns({
  around,
  factory,
  workflow,
  at,
}: {
  around: Placed['around'];
  factory: string;
  workflow: string;
  at: string | null;
}): ReactElement {
  return (
    <div className={CARD}>
      <h2 className={LABEL}>Where it runs</h2>
      <ul className="flex flex-col gap-3">
        {around.map(({ path, row }) => (
          <li key={path} data-route={path} className="flex flex-col gap-1">
            <Link to={stepHref(factory, workflow, path, at)} className="flex flex-wrap gap-x-3">
              <span className={MONO}>{path}</span>
              <span className={NOTE}>
                {row.include !== null ? `include ${row.include}` : row.kind}
              </span>
            </Link>
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[10rem_1fr]">
              <Fact label="When">{row.when_condition ?? '-'}</Fact>
              <Fact label="Trigger rule">{row.trigger_rule ?? '-'}</Fact>
              <Fact label="Inputs">
                <StepList steps={row.depends_on} data-route-inputs={row.depends_on.join(' ')} />
              </Fact>
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every place the step's definition runs at, the one shown marked. */
function IncludedAt({
  steps,
  placed,
  factory,
  workflow,
  path,
  at,
}: {
  steps: readonly StepRow[];
  placed: Placed;
  factory: string;
  workflow: string;
  path: string;
  at: string | null;
}): ReactElement {
  return (
    <div className={CARD}>
      <h2 className={LABEL}>Included at</h2>
      <ul className="flex flex-col gap-1">
        {placesOf(steps, placed.step.workflow, placed.step.path).map((place) => {
          const here = place.workflow === workflow && place.path === path;
          return (
            <li
              key={`${place.workflow} ${place.path}`}
              data-included-at={`${place.workflow} ${place.path}`}
            >
              <Link
                to={stepHref(factory, place.workflow, place.path, at)}
                aria-current={here ? 'page' : undefined}
                className="flex flex-wrap gap-x-3"
              >
                <span className={NOTE}>{place.workflow}</span>
                <span className={MONO}>{place.path}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Step({
  placed,
  steps,
  factory,
  workflow,
  path,
  at,
}: {
  placed: Placed;
  steps: readonly StepRow[];
  factory: string;
  workflow: string;
  path: string;
  at: string | null;
}): ReactElement {
  const { step, around } = placed;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className={LABEL}>{workflow}</p>
        <h1 className="font-mono text-2xl font-semibold text-[color:var(--v3-fg)] [overflow-wrap:anywhere]">
          {path}
        </h1>
        <p data-description="" className={`whitespace-pre-line ${NOTE}`}>
          {step.description ?? 'The pack gives this step no description.'}
        </p>
      </header>
      <dl className={`${CARD} grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr]`}>
        <Fact label="Kind">{kindLabel(step)}</Fact>
        <Fact label="Model">{step.model ?? '-'}</Fact>
        <Fact label="When">
          <span data-when="">{step.when_condition ?? '-'}</span>
        </Fact>
        <Fact label="Trigger rule">
          <span data-trigger-rule="">{step.trigger_rule ?? '-'}</span>
        </Fact>
        <Fact label="Inputs">
          <StepList steps={step.depends_on} data-depends-on={step.depends_on.join(' ')} />
        </Fact>
        <Fact label="Outputs">
          <StepList steps={dependents(steps, step).map((s) => s.step_id)} data-outputs="" />
        </Fact>
        <Fact label="Defined in">{step.file}</Fact>
      </dl>
      {around.length > 0 ? (
        <WhereItRuns around={around} factory={factory} workflow={workflow} at={at} />
      ) : null}
      {isIncluded(steps, step.workflow) ? (
        <IncludedAt
          steps={steps}
          placed={placed}
          factory={factory}
          workflow={workflow}
          path={path}
          at={at}
        />
      ) : null}
    </div>
  );
}

/** The step step-detail found for the address `asked`, for the panels beside it. */
interface Found {
  asked: string;
  step: StepRow;
}

/**
 * Hands the step step-detail found to the screen before the browser paints, so the panels beside
 * it show their rows in the same frame as its facts, and takes it back once step-detail no longer
 * shows it.
 */
function FoundStep({
  asked,
  step,
  onFound,
}: Found & { onFound: (found: Found | undefined) => void }): null {
  useLayoutEffect(() => {
    onFound({ asked, step });
    return () => onFound(undefined);
  }, [asked, step, onFound]);
  return null;
}

/**
 * Where this step screen was opened from: the origin its opener passed as history state, kept
 * while the screen stays open (the version picker and the links inside it pass none), else the map
 * card that covers the step.
 */
function useStepOrigin(factory: string, workflow: string, path: string, at: string | null) {
  const opened = stepOriginOf(useLocation().state);
  const kept = useRef(opened);
  if (opened !== undefined) kept.current = opened;
  return kept.current ?? mapOrigin(FACTORY_MAP, factory, workflow, path, at);
}

/**
 * One step of the version its address names, else the current one: what it does, what routes a
 * lap through it, what it runs.
 */
export default function StepDetail(): ReactElement {
  const { factory: address = '', workflow = '', step = '' } = useParams();
  const [search] = useSearchParams();
  const at = search.get(AT_PARAM) || null;
  const factory = useFactory();
  const asked = `${factory} ${workflow} ${step} ${at ?? ''}`;
  const [known, setKnown] = useState<Found | undefined>();
  const panel = {
    step: known?.asked === asked ? known.step : undefined,
    workflow,
    path: step,
    factory,
    address,
    at,
  };
  const origin = useStepOrigin(address, workflow, step, at);
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <nav
        aria-label="Breadcrumb"
        data-breadcrumb=""
        className={`mb-4 flex flex-wrap gap-x-2 ${NOTE}`}
      >
        <Link
          to={origin.href}
          state={origin.card === undefined ? undefined : selectState(origin.card)}
          data-breadcrumb-back=""
        >
          {origin.label}
        </Link>
        <span aria-hidden>/</span>
        <span className={MONO}>{step}</span>
      </nav>
      <StepVersionPicker
        factory={factory}
        at={at}
        href={(version) => stepHref(address, workflow, step, version)}
      />
      <div className="flex flex-col gap-6">
        <LivePanel<StepRow> query="step-detail" factory={factory} args={[at ?? '']}>
          {(rows, state) => {
            if (state === 'error') return <Unavailable />;
            if (rows === undefined || factory === undefined) return null;
            // Every recorded version has steps, so none means the pin has no architecture.
            if (at !== null && rows.length === 0) {
              return <EmptyState title={`No version ${at} is recorded for this factory.`} />;
            }
            const placed = placeOf(rows, workflow, step);
            if (placed === undefined) {
              return <EmptyState title={`No step ${step} in ${workflow} at ${versionName(at)}.`} />;
            }
            // A workflow something includes never runs on its own: its address is the shared
            // one, and opens the first place instead.
            const first = isIncluded(rows, workflow)
              ? placesOf(rows, workflow, step)[0]
              : undefined;
            if (first !== undefined) {
              return <Navigate replace to={stepHref(address, first.workflow, first.path, at)} />;
            }
            return (
              <>
                <Step
                  placed={placed}
                  steps={rows}
                  factory={address}
                  workflow={workflow}
                  path={step}
                  at={at}
                />
                <FoundStep asked={asked} step={placed.step} onFound={setKnown} />
              </>
            );
          }}
        </LivePanel>
        <Nesting {...panel} />
        <Prompt {...panel} />
        <Subagents {...panel} />
        <Scripts {...panel} />
        <Yaml {...panel} />
      </div>
    </main>
  );
}
