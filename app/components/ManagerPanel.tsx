import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { shortRunId } from '../lib/format';
import {
  clock,
  linkify,
  type ManagerLink,
  type ManagerMessage,
  type ManagerPlace,
  type ManagerProposal,
  type ManagerReply,
  proposalChoice,
} from '../lib/manager';
import { lapHref } from '../lib/one-lap';
import { RUN_STATE, stateOf } from '../lib/states';
import { useActionPending, useActionsEnabled, useStartAction } from './ActionToast';
import type { ManagerChat } from './useManagerChat';
import { Button, buttonClass } from './ui/Button';
import { StateDot } from './ui/StateDot';

const BRIEFING_WAIT = "Writing today's briefing.";
const NO_FACTORY = 'This address names no factory, so the Manager has nothing to look at.';
const LINK = 'text-[color:var(--v3-you-2)] hover:underline';

/** `**bold**` inside one line of prose; React nodes only, never markup from the model. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional and never reorder
      <b key={i}>{part.slice(2, -2)}</b>
    ) : (
      part
    ),
  );
}

function ItemLink({ link }: { link: ManagerLink }): ReactElement {
  return (
    <a
      href={link.href}
      data-run-link={link.kind === 'run' ? link.id : undefined}
      className={`font-mono [overflow-wrap:anywhere] ${LINK}`}
    >
      {link.kind === 'run' ? shortRunId(link.id) : link.label}
    </a>
  );
}

/** The prose in paragraphs and bullets, with each link where the prose names it. */
function Prose({ message }: { message: ManagerReply }): ReactElement {
  const { segments, rest } = linkify(message.text, message.links);
  // Paragraphs break at blank lines; single newlines and bullet markers show as written.
  const blocks: ReactNode[][] = [[]];
  let key = 0;
  for (const segment of segments) {
    if (typeof segment !== 'string') {
      blocks[blocks.length - 1].push(<ItemLink key={key++} link={segment} />);
      continue;
    }
    segment.split(/\n{2,}/).forEach((paragraph, i) => {
      if (i > 0) blocks.push([]);
      for (const node of inline(paragraph)) {
        blocks[blocks.length - 1].push(<span key={key++}>{node}</span>);
      }
    });
  }
  return (
    <>
      {blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and never reorder
        <p key={i} className="m-0 mb-2 whitespace-pre-line [overflow-wrap:anywhere]">
          {block}
        </p>
      ))}
      {rest.length === 0 ? null : (
        <p className="m-0 mb-2 flex flex-wrap gap-x-3 gap-y-1">
          {rest.map((link) => (
            <ItemLink key={`${link.kind}:${link.id}`} link={link} />
          ))}
        </p>
      )}
    </>
  );
}

function RunList({ runs }: { runs: ManagerReply['runs'] }): ReactElement | null {
  if (runs.length === 0) return null;
  return (
    <ul className="m-0 mb-2 list-none overflow-hidden rounded-lg border border-[color:var(--v3-line)] p-0">
      {runs.map((run) => (
        <li
          key={run.run_id}
          data-run-row={run.run_id}
          className="flex min-w-0 items-center gap-2 border-b border-[color:var(--v3-line)] px-2.5 py-1.5 last:border-b-0"
        >
          <StateDot state={stateOf(RUN_STATE, run.status) ?? 'idle'} />
          <span className="min-w-0 truncate text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)]">
            {run.workflow_name}
          </span>
          <a
            href={run.href}
            data-run-link={run.run_id}
            className={`font-mono text-[length:var(--v3-t-meta)] ${LINK}`}
          >
            {shortRunId(run.run_id)}
          </a>
          <span className="ml-auto font-mono text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)]">
            {clock(run.completed_at ?? run.started_at)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Proposals({
  proposals,
  factory,
  enabled,
}: {
  proposals: ManagerProposal[];
  factory: string;
  enabled: boolean;
}): ReactElement | null {
  const start = useStartAction();
  const pending = useActionPending();
  if (proposals.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {proposals.map((proposal, i) => {
        const { type: _type, label, ...request } = proposal;
        return enabled ? (
          <Button
            key={`${proposal.action}:${label}`}
            variant={i === 0 ? 'primary' : 'secondary'}
            disabled={pending}
            data-proposal={proposal.action}
            onClick={() =>
              start(request, {
                item: null,
                label: proposal.action === 'answer' ? proposalChoice(label) : '',
              })
            }
          >
            {label}
          </Button>
        ) : (
          <a
            key={`${proposal.action}:${label}`}
            href={lapHref(factory, proposal.run_id)}
            className={buttonClass('secondary')}
          >
            Open run {shortRunId(proposal.run_id)}
          </a>
        );
      })}
    </div>
  );
}

function Message({
  message,
  factory,
  enabled,
}: {
  message: ManagerMessage;
  factory: string;
  enabled: boolean;
}): ReactElement {
  if (message.role === 'owner') {
    return (
      <div className="flex justify-end">
        <p className="m-0 max-w-[88%] rounded-[10px] bg-[var(--v3-raised)] px-3 py-2 text-[length:var(--v3-t-body)] text-[color:var(--v3-fg)] [overflow-wrap:anywhere]">
          {message.text}
        </p>
      </div>
    );
  }
  const who =
    message.kind === 'briefing'
      ? message.generatedAt
        ? `Manager · ${clock(message.generatedAt)} briefing`
        : 'Manager · briefing'
      : 'Manager';
  const waiting = message.state === 'waiting';
  return (
    <div
      data-message={message.kind}
      data-manager-state={message.state}
      className="min-w-0 text-[length:var(--v3-t-body)] leading-[1.55] text-[color:var(--v3-fg)]"
    >
      <div className="mb-1 text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)]">{who}</div>
      {waiting ? (
        <p className="m-0 text-[color:var(--v3-fg-2)]">
          {message.kind === 'briefing' ? BRIEFING_WAIT : 'Thinking.'}
        </p>
      ) : (
        <Prose message={message} />
      )}
      <RunList runs={message.runs} />
      <Proposals proposals={message.proposals} factory={factory} enabled={enabled} />
      {message.notices.map((notice) => (
        <p
          key={notice}
          className="m-0 mb-1 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]"
        >
          {notice}
        </p>
      ))}
    </div>
  );
}

/** Everything the panel draws, from props alone; `ManagerPanel` adds the typing box's state. */
export function ManagerPanelBody({
  phone,
  onClose,
  chat,
  place,
  factory,
  enabled,
  draft = '',
  onDraft = () => {},
  onSend = () => {},
}: {
  phone: boolean;
  onClose: () => void;
  chat: Pick<ManagerChat, 'messages' | 'busy'>;
  place: ManagerPlace;
  factory: string | undefined;
  enabled: boolean;
  draft?: string;
  onDraft?: (text: string) => void;
  onSend?: (text: string) => void;
}): ReactElement {
  const end = useRef<HTMLDivElement>(null);
  const last = chat.messages[chat.messages.length - 1];
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll again whenever the last line changes
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [chat.messages.length, last]);
  const send = () => {
    if (draft.trim() !== '' && !chat.busy) onSend(draft.trim());
  };
  return (
    <aside
      aria-label="Manager"
      data-manager={phone ? 'tab' : 'dock'}
      className={`flex min-h-0 min-w-0 flex-col bg-[var(--v3-panel)] ${
        phone
          ? 'h-[calc(100vh-110px)] flex-1'
          : 'w-[var(--v3-manager-width)] shrink-0 border-l border-[color:var(--v3-line)]'
      }`}
    >
      <div className="flex items-center gap-2.5 border-b border-[color:var(--v3-line)] px-4 py-3.5">
        <span
          aria-hidden="true"
          className="grid size-[26px] shrink-0 place-items-center rounded-md border border-[color:var(--v3-you-line)] bg-[var(--v3-you-wash)] font-mono text-[length:var(--v3-t-micro)] font-semibold text-[color:var(--v3-you-2)]"
        >
          A
        </span>
        <div className="min-w-0">
          <b className="block text-[14.5px] text-[color:var(--v3-fg)]">Manager</b>
          <span className="block text-[length:var(--v3-t-micro)] text-[color:var(--v3-fg-3)]">
            Watches every run and queue for you
          </span>
        </div>
        <button
          type="button"
          aria-label="Close the Manager"
          onClick={onClose}
          className="ml-auto cursor-pointer text-lg text-[color:var(--v3-fg-3)] hover:text-[color:var(--v3-fg)]"
        >
          ×
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3.5">
        {factory === undefined ? (
          <p className="m-0 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">
            {NO_FACTORY}
          </p>
        ) : (
          <>
            <div
              data-manager-context
              className="flex flex-wrap items-center gap-2 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]"
            >
              Looking at{' '}
              <span className="rounded-md bg-[var(--v3-you-wash)] px-2 py-1 font-mono text-[length:var(--v3-t-micro)] font-medium text-[color:var(--v3-you-2)] [overflow-wrap:anywhere]">
                {place.chip}
              </span>
            </div>
            {chat.messages.map((message, i) => (
              <Message
                // biome-ignore lint/suspicious/noArrayIndexKey: messages are only ever appended
                key={i}
                message={message}
                factory={factory}
                enabled={enabled}
              />
            ))}
            <div ref={end} />
          </>
        )}
      </div>
      {factory === undefined ? null : (
        <div className="border-t border-[color:var(--v3-line)] px-4 py-3">
          <div className="mb-2.5 flex flex-wrap gap-2">
            {place.questions.map((question) => (
              <button
                key={question}
                type="button"
                data-suggestion
                disabled={chat.busy}
                onClick={() => onSend(question)}
                className="cursor-pointer rounded-full border border-[color:var(--v3-line)] bg-transparent px-[11px] py-1 text-left text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-2)] hover:text-[color:var(--v3-fg)] disabled:cursor-default disabled:opacity-60"
              >
                {question}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <textarea
              aria-label="Ask the Manager"
              placeholder="Ask about any run, or tell me what to do"
              maxLength={4000}
              rows={2}
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              className="min-h-[52px] min-w-0 flex-1 resize-none rounded-lg border border-[color:var(--v3-line)] bg-[var(--v3-sunk)] p-2 text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg)]"
            />
            <Button variant="primary" disabled={chat.busy || draft.trim() === ''} onClick={send}>
              Send
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
}

/** The Manager's panel: a docked column on the desktop, the whole screen on the phone. */
export function ManagerPanel({
  phone = false,
  onClose,
  chat,
  place,
  factory,
}: {
  phone?: boolean;
  onClose: () => void;
  chat: ManagerChat;
  place: ManagerPlace;
  factory: string | undefined;
}): ReactElement {
  const [draft, setDraft] = useState('');
  const enabled = useActionsEnabled(factory ?? '');
  return (
    <ManagerPanelBody
      phone={phone}
      onClose={onClose}
      chat={chat}
      place={place}
      factory={factory}
      enabled={enabled}
      draft={draft}
      onDraft={setDraft}
      onSend={(text) => {
        chat.ask(text, place.context);
        if (text === draft.trim()) setDraft('');
      }}
    />
  );
}
