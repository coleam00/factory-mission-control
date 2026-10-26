import type { ReactElement, ReactNode } from 'react';
import { useParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import {
  dependents,
  findStep,
  type HookRow,
  joinParts,
  type PartRow,
  type StepRow,
  type SubagentRow,
  type YamlPartRow,
} from '../lib/step-detail';
import { useFactory } from '../live/FactoryProvider';
import { LivePanel, type PanelState } from '../live/LivePanel';
import { useWaves } from '../live/waves';

const LABEL = 'font-mono text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary';
const CARD = 'flex flex-col gap-3 rounded-lg border border-border bg-surface p-5';
const CODE =
  'whitespace-pre-wrap rounded-md border border-border bg-surface-inset p-4 font-mono text-[12px] leading-relaxed text-text-primary [overflow-wrap:anywhere]';
const NOTE = 'text-sm text-text-secondary';
const MONO = 'font-mono text-[13px] text-text-primary [overflow-wrap:anywhere]';

function Unavailable(): ReactElement {
  return <p className={NOTE}>Live data is unavailable.</p>;
}

/** A panel's heading, then its body once its rows are in. */
function Section({
  title,
  state,
  children,
}: {
  title: string;
  state: PanelState;
  children: () => ReactNode;
}): ReactElement {
  return (
    <>
      <h2 className={LABEL}>{title}</h2>
      {state === 'error' ? <Unavailable /> : state === 'ready' ? children() : null}
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

interface PanelProps {
  step: StepRow;
  factory: string;
  wave: { enabled: boolean; onSettled: (query: string) => void };
}

function Prompt({ step, factory, wave }: PanelProps): ReactElement {
  return (
    <LivePanel<PartRow> query="step-prompt" factory={factory} {...wave} className={CARD}>
      {(rows = [], state) => (
        <Section title="Prompt" state={state}>
          {() => {
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

function Subagents({ step, factory, wave }: PanelProps): ReactElement {
  return (
    <LivePanel<SubagentRow> query="step-subagents" factory={factory} {...wave} className={CARD}>
      {(rows = [], state) => (
        <Section title="Subagents" state={state}>
          {() => {
            const own = rows.filter(
              (r) => r.workflow === step.workflow && r.step_path === step.path,
            );
            if (own.length === 0) return <p className={NOTE}>This step has no inline subagents.</p>;
            const instructions = joinParts(own, (row) => row.name);
            const agents = [...new Map(own.map((row) => [row.name, row])).values()];
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

function Scripts({ step, factory, wave }: PanelProps): ReactElement {
  return (
    <LivePanel<PartRow> query="step-scripts" factory={factory} {...wave} className={CARD}>
      {(rows = [], state) => (
        <Section title="Scripts" state={state}>
          {() => {
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
function Hooks({ step, factory, wave }: PanelProps): ReactElement {
  return (
    <LivePanel<HookRow> query="step-hooks" factory={factory} {...wave} className={CARD}>
      {(rows = [], state) => (
        <Section title="Hooks" state={state}>
          {() => {
            const own = rows.filter(
              (r) => r.workflow === step.workflow && r.step_path === step.path,
            );
            if (own.length === 0) return <p className={NOTE}>No hook applies to this step.</p>;
            const hooks = [...new Map(own.map((row) => [row.path, row])).values()];
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
                {own
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

function Yaml({ step, factory, wave }: PanelProps): ReactElement {
  return (
    <LivePanel<YamlPartRow> query="step-yaml" factory={factory} {...wave} className={CARD}>
      {(rows = [], state) => (
        <Section title="Workflow YAML" state={state}>
          {() => (
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

/** The step's panels below its facts, opened two at a time. */
const WAVES = [['step-prompt', 'step-subagents'], ['step-scripts', 'step-hooks'], ['step-yaml']];

function Step({
  step,
  steps,
  factory,
}: {
  step: StepRow;
  steps: readonly StepRow[];
  factory: string;
}): ReactElement {
  const { enabled, settle } = useWaves(WAVES);
  const panel = (query: string) => ({
    step,
    factory,
    wave: { enabled: enabled(query), onSettled: settle },
  });
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
      <Prompt {...panel('step-prompt')} />
      <Subagents {...panel('step-subagents')} />
      <Scripts {...panel('step-scripts')} />
      <Hooks {...panel('step-hooks')} />
      <Yaml {...panel('step-yaml')} />
    </div>
  );
}

/** One step of the current version: what it does, what routes a lap through it, what it runs. */
export default function StepDetail(): ReactElement {
  const { workflow = '', step = '' } = useParams();
  const factory = useFactory();
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <LivePanel<StepRow> query="step-detail" factory={factory}>
        {(rows, state) => {
          if (state === 'error') return <Unavailable />;
          if (rows === undefined || factory === undefined) return null;
          const found = findStep(rows, workflow, step);
          if (found === undefined) {
            return <EmptyState title={`No step ${step} in ${workflow} at the current version.`} />;
          }
          return <Step step={found} steps={rows} factory={factory} />;
        }}
      </LivePanel>
    </main>
  );
}
