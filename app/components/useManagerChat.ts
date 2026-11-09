import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyEvent,
  endWithout,
  failed,
  historyFor,
  type ManagerContext,
  type ManagerMessage,
  type ManagerReply,
  type Outcome,
  postBriefing,
  postChat,
  reply,
} from '../lib/manager';
import { useActionDone } from './ActionToast';

export interface ManagerChat {
  messages: ManagerMessage[];
  busy: boolean;
  ask: (question: string, context: ManagerContext) => void;
}

/**
 * The conversation with the Manager for one factory. It lives above the panel, so closing the dock
 * or leaving the phone tab keeps it; a different factory starts it over. The briefing is requested
 * the first time the panel is visible for the factory.
 */
export function useManagerChat(factory: string | undefined, visible: boolean): ManagerChat {
  const [messages, setMessages] = useState<ManagerMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const history = useRef<ManagerMessage[]>([]);
  const briefed = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  history.current = messages;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different factory starts the conversation over
  useEffect(() => {
    abort.current?.abort();
    abort.current = undefined;
    briefed.current = undefined;
    setMessages([]);
    setBusy(false);
    return () => abort.current?.abort();
  }, [factory]);

  /** Streams `outcome` into the reply at `index`, whatever way it ends. */
  const stream = useCallback(async (index: number, start: Promise<Outcome>) => {
    const update = (change: (m: ManagerReply) => ManagerReply) =>
      setMessages((all) =>
        all.map((m, i) => (i === index && m.role === 'manager' ? change(m) : m)),
      );
    try {
      const outcome = await start;
      if ('failure' in outcome) return update((m) => failed(m, outcome.failure));
      try {
        for await (const event of outcome.events) update((m) => applyEvent(m, event));
      } finally {
        update(endWithout);
      }
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') return;
      update((m) =>
        failed(m, 'The Manager could not be reached. Check that the dashboard server is running.'),
      );
    }
  }, []);

  useEffect(() => {
    if (!visible || factory === undefined || briefed.current === factory) return;
    briefed.current = factory;
    const controller = new AbortController();
    abort.current = controller;
    const index = history.current.length;
    setMessages((all) => [...all, reply('briefing')]);
    setBusy(true);
    void stream(index, postBriefing(factory, controller.signal)).finally(() => {
      if (abort.current === controller) setBusy(false);
    });
  }, [visible, factory, stream]);

  const ask = useCallback(
    (question: string, context: ManagerContext) => {
      if (factory === undefined || busy) return;
      const controller = new AbortController();
      abort.current = controller;
      const sent = historyFor(history.current, question);
      const index = history.current.length + 1;
      setMessages((all) => [...all, { role: 'owner', text: question }, reply('answer')]);
      setBusy(true);
      void stream(index, postChat({ factory, context, messages: sent }, controller.signal)).finally(
        () => {
          if (abort.current === controller) setBusy(false);
        },
      );
    },
    [factory, busy, stream],
  );

  useActionDone((text) => setMessages((all) => [...all, reply('action', text, 'done')]));

  return { messages, busy, ask };
}
