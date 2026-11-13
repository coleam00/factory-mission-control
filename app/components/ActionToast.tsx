import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  createActionFlow,
  fetchEnabled,
  loginMissing,
  type Operators,
  postAction,
} from '../lib/actions';
import { Toast } from './ui/Toast';

/** The one flow every Answer and Resume button starts: README rule 4, one action model. */
const flow = createActionFlow({
  post: postAction,
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle as number),
});

export const useStartAction = () => flow.start;

/** True while a toast is open: the other action buttons wait, one action at a time. */
export function useActionPending(): boolean {
  return useSyncExternalStore(
    flow.subscribe,
    () => flow.getState().phase !== 'idle',
    () => false,
  );
}

/** Calls `onDone` with the result text once for each action that finishes, whoever started it. */
export function useActionDone(onDone: (text: string) => void): void {
  const last = useRef<string>('idle');
  const latest = useRef(onDone);
  latest.current = onDone;
  useEffect(() => {
    const stop = flow.subscribe(() => {
      const state = flow.getState();
      if (state.phase === 'done' && last.current !== 'done') latest.current(state.text);
      last.current = state.phase;
    });
    return () => void stop();
  }, []);
}

let enabled: Promise<Operators> | undefined;

function useOperators(): Operators {
  const [operators, setOperators] = useState<Operators>({ factories: [], logins: [] });
  useEffect(() => {
    enabled ??= fetchEnabled();
    let live = true;
    enabled.then((found) => live && setOperators(found));
    return () => {
      live = false;
    };
  }, []);
  return operators;
}

/** Whether the server holds an operator for `factory`; false until it answers, so buttons start as links. */
export function useActionsEnabled(factory: string): boolean {
  return useOperators().factories.includes(factory);
}

/** True when the factory's operator has no `login`; false until the server answers. */
export function useLoginMissing(factory: string): boolean {
  return loginMissing(useOperators(), factory);
}

export function ActionToastHost() {
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);
  if (state.phase === 'pending') {
    return (
      <Toast onUndo={() => void flow.undo()}>
        {state.lead}
        <b>{state.detail}</b>
      </Toast>
    );
  }
  return state.phase === 'done' ? <Toast>{state.text}</Toast> : null;
}
