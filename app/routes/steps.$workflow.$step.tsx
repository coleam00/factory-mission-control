import { type ReactElement, type ReactNode, useLayoutEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { StepVersionPicker } from '../components/StepVersionPicker';
import {
  dependents,
  findStep,
  type HookRow,
  joinParts,
  type NestingRow,
  nesting,
  type PartRow,
  type StepRow,
  type SubagentRow,
  versionName,
  type YamlPartRow,
} from '../lib/step-detail';
import { useFactory } from '../live/FactoryProvider';
import { LivePanel, type PanelState } from '../live/LivePanel';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const CARD = 'flex flex-col gap-3 rounded-lg border border-border bg-surface p-5';
const CODE =
  'whitespace-pre-wrap rounded-md border border-border bg-surface-inset p-4 font-mono text-[12px] leading-relaxed text-text-primary [overflow-wrap:anywhere]';
const NOTE = 'text-sm text-text-secondary';
const MONO = 'font-mono text-[13px] text-text-primary [overflow-wrap:anywhere]';

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

/** Where includes put this step, and every node beneath it: on an include, the steps it runs. */
function Nesting({ step, workflow, path, factory, at }: PanelProps): ReactElement {
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
        const { inside, includedAt } = nesting(rows, step, at);
        return (
          <div className={CARD}>
            {includedAt.length > 0 ? (
              <>
                <h2 className={LABEL}>Included at</h2>
                <ul className="flex flex-col gap-1">
                  {includedAt.map((place) => (
                    <li
                      key={`${place.workflow} ${place.path}`}
                      data-included-at={`${place.workflow} ${place.path}`}
                    >
                      <Link to={place.href} className="flex flex-wrap gap-x-3">
                        <span className={NOTE}>{place.workflow}</span>
                        <span className={MONO}>{place.path}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {inside.length > 0 ? (
              <>
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
              </>
            ) : null}
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
                className="flex flex-col gap-2 border-t border-border pt-3 first-of-type:border-t-0 first-of-type:pt-0"
              >
                <h3 className="font-mono text-sm font-semibold text-text-primary">{agent.name}</h3>
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

/** The hooks that let this step's subagents through: for a holdout step, the fence. */
function Hooks({ step, workflow, path, factory, at }: PanelProps): ReactElement {
  return (
    <LivePanel<HookRow>
      query="step-hooks"
      factory={factory}
      args={[workflow, path, at ?? '']}
      className={step === undefined ? 'hidden' : CARD}
    >
      {(rows = [], state) => (
        <Section title="Hooks" step={step} state={state}>
          {() => {
            if (rows.length === 0) return <p className={NOTE}>No hook applies to this step.</p>;
            const hooks = [...new Map(rows.map((row) => [row.path, row])).values()];
            return hooks.map((hook) => (
              <dl
                key={hook.path}
                data-hook={hook.path}
                className="grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr]"
              >
                <Fact label="Fence hook">{hook.path}</Fact>
                <Fact label="May read holdouts">
                  <span className="flex flex-wrap gap-x-3 gap-y-1">
                    {hook.admitted_agents.map((name) => (
                      <span key={name} data-admitted-agent={name}>
                        {name}
                      </span>
                    ))}
                  </span>
                </Fact>
                {rows
                  .filter((row) => row.path === hook.path && row.description !== null)
                  .map((row) => (
                    <Fact key={row.agent} label={`${row.agent} returns`} className={NOTE}>
                      <span data-verdict={row.agent}>{row.description}</span>
                    </Fact>
                  ))}
              </dl>
            ));
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

function Step({ step, steps }: { step: StepRow; steps: readonly StepRow[] }): ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className={LABEL}>{step.workflow}</p>
        <h1 className="font-mono text-2xl font-semibold text-text-primary [overflow-wrap:anywhere]">
          {step.path}
        </h1>
        <p data-description="" className={`whitespace-pre-line ${NOTE}`}>
          {step.description ?? 'The pack gives this step no description.'}
        </p>
      </header>
      <dl className={`${CARD} grid gap-x-6 gap-y-2 sm:grid-cols-[10rem_1fr]`}>
        <Fact label="Kind">{step.include !== null ? `include ${step.include}` : step.kind}</Fact>
        <Fact label="Model">{step.model ?? '-'}</Fact>
        <Fact label="When">
          <span data-when="">{step.when_condition ?? '-'}</span>
        </Fact>
        <Fact label="Trigger rule">{step.trigger_rule ?? '-'}</Fact>
        <Fact label="Inputs">
          <StepList steps={step.depends_on} data-depends-on={step.depends_on.join(' ')} />
        </Fact>
        <Fact label="Outputs">
          <StepList steps={dependents(steps, step).map((s) => s.step_id)} data-outputs="" />
        </Fact>
        <Fact label="Defined in">{step.file}</Fact>
      </dl>
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
 * it show their rows in the same frame as its facts.
 */
function FoundStep({ asked, step, onFound }: Found & { onFound: (found: Found) => void }): null {
  useLayoutEffect(() => onFound({ asked, step }), [asked, step, onFound]);
  return null;
}

/**
 * One step of the version its address names, else the current one: what it does, what routes a
 * lap through it, what it runs.
 */
export default function StepDetail(): ReactElement {
  const { workflow = '', step = '' } = useParams();
  const [search] = useSearchParams();
  const at = search.get('at') || null;
  const factory = useFactory();
  const asked = `${factory} ${workflow} ${step} ${at ?? ''}`;
  const [known, setKnown] = useState<Found>();
  const panel = {
    step: known?.asked === asked ? known.step : undefined,
    workflow,
    path: step,
    factory,
    at,
  };
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <StepVersionPicker factory={factory} at={at} workflow={workflow} path={step} />
      <div className="flex flex-col gap-6">
        <LivePanel<StepRow> query="step-detail" factory={factory} args={[at ?? '']}>
          {(rows, state) => {
            if (state === 'error') return <Unavailable />;
            if (rows === undefined || factory === undefined) return null;
            // Every recorded version has steps, so none means the pin has no architecture.
            if (at !== null && rows.length === 0) {
              return <EmptyState title={`No version ${at} is recorded for this factory.`} />;
            }
            const found = findStep(rows, workflow, step);
            if (found === undefined) {
              return <EmptyState title={`No step ${step} in ${workflow} at ${versionName(at)}.`} />;
            }
            return (
              <>
                <Step step={found} steps={rows} />
                <FoundStep asked={asked} step={found} onFound={setKnown} />
              </>
            );
          }}
        </LivePanel>
        <Nesting {...panel} />
        <Prompt {...panel} />
        <Subagents {...panel} />
        <Scripts {...panel} />
        <Hooks {...panel} />
        <Yaml {...panel} />
      </div>
    </main>
  );
}
