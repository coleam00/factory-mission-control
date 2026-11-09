import { useEffect, useState, useSyncExternalStore } from 'react';
import { createActionFlow, fetchEnabled, postAction } from '../lib/actions';
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
  return useSyncExternalStore(flow.subscribe, () => flow.getState().phase !== 'idle');
}

let enabled: Promise<string[]> | undefined;

/** Whether the server holds an operator for `factory`; false until it answers, so buttons start as links. */
export function useActionsEnabled(factory: string): boolean {
  const [factories, setFactories] = useState<string[]>([]);
  useEffect(() => {
    enabled ??= fetchEnabled();
    let live = true;
    enabled.then((names) => live && setFactories(names));
    return () => {
      live = false;
    };
  }, []);
  return factories.includes(factory);
}

export function ActionToastHost() {
  const state = useSyncExternalStore(flow.subscribe, flow.getState);
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
