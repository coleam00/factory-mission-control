import { describe, expect, test } from 'bun:test';
import {
  type ActionRequest,
  type ActionError,
  type ActionResult,
  createActionFlow,
  pendingText,
  postAction,
  UNDO_MS,
} from './actions';

const RUN = '5eed0001-0000-4000-8000-0000000000a1';
const request: ActionRequest = {
  factory: 'f',
  action: 'answer',
  run_id: RUN,
  occurrence: 'o1',
  option: 'yes',
  text: null,
};
const context = { item: 363, label: 'Rename to 0029, then merge' };

function harness(result: ActionResult | ActionError = ok()) {
  const posts: boolean[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  const flow = createActionFlow({
    post: async (_request, undone) => {
      posts.push(undone);
      return result;
    },
    setTimer: (fn, ms) => {
      timers.set(++next, { fn, ms });
      return next;
    },
    clearTimer: (handle) => timers.delete(handle as number),
  });
  const fire = async () => {
    const [[id, timer]] = [...timers];
    timers.delete(id);
    timer.fn();
    await Bun.sleep(0);
  };
  return { flow, posts, timers, fire };
}

function ok(): ActionResult {
  return { id: 1, sent: true, ok: true, exit_code: 0, summary: '' };
}

describe('the Undo flow', () => {
  test('Undo within the window posts once, as undone, and never as a send', async () => {
    const { flow, posts, timers } = harness();
    flow.start(request, context);
    await flow.undo();
    expect(posts).toEqual([true]);
    expect(timers.size).toBe(1); // only the result toast's own clearing timer
    expect(flow.getState()).toMatchObject({ phase: 'done', text: 'Undone. Nothing was sent.' });
  });

  test('with no Undo it posts once, as a send, when the 5 seconds end and not before', async () => {
    const { flow, posts, timers, fire } = harness();
    flow.start(request, context);
    expect([...timers.values()].map((t) => t.ms)).toEqual([UNDO_MS]);
    expect(posts).toEqual([]);
    await fire();
    expect(posts).toEqual([false]);
    expect(flow.getState()).toMatchObject({ phase: 'done', ok: true });
  });

  test('a second start while one is pending does nothing', () => {
    const { flow, timers } = harness();
    flow.start(request, context);
    flow.start({ ...request, option: 'no' }, context);
    expect(timers.size).toBe(1);
    expect(flow.getState()).toMatchObject({ phase: 'pending', request });
  });

  test('a refusal from the CLI shows its summary', async () => {
    const { flow, fire } = harness({ ...ok(), ok: false, exit_code: 1, summary: 'stale\nmore' });
    flow.start(request, context);
    await fire();
    expect(flow.getState()).toMatchObject({ text: 'Archon refused it: stale', ok: false });
  });

  test('a server refusal shows why nothing was sent', async () => {
    const { flow, fire } = harness({ error: 'the question is no longer open' });
    flow.start(request, context);
    await fire();
    expect(flow.getState()).toMatchObject({
      text: 'Not sent: the question is no longer open',
      ok: false,
    });
  });
});

describe('an outcome the server never confirmed', () => {
  test('no reply says it may have been sent', async () => {
    const { flow, fire } = harness({ error: 'network down', noReply: true });
    flow.start(request, context);
    await fire();
    expect(flow.getState()).toMatchObject({ ok: false });
    expect((flow.getState() as { text: string }).text).toContain('may have been sent');
  });

  test('a transport failure from postAction carries noReply', async () => {
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await postAction(request, false, failing)).toEqual({
      error: 'network down',
      noReply: true,
    });
  });

  test('a CLI with no exit code says the outcome is unknown', async () => {
    const { flow, fire } = harness({ ...ok(), ok: false, exit_code: null, summary: 'killed' });
    flow.start(request, context);
    await fire();
    expect((flow.getState() as { text: string }).text).toStartWith('Unknown outcome');
  });
});

test('the pending toast names the item and the choice, or the run and the step', () => {
  expect(pendingText(request, context)).toEqual({
    lead: 'Answered #363: ',
    detail: 'Rename to 0029, then merge',
  });
  expect(
    pendingText({ factory: 'f', action: 'resume', run_id: RUN, from_step: 'implement' }, context),
  ).toEqual({ lead: 'Resumed run 5eed0001: ', detail: 'from implement' });
});
