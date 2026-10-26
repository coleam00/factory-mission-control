import type { WebSocketFactory, WebSocketLike } from '@neon/realtime/client';

export interface QueryObservation {
  readonly id: string;
  readonly query: string;
  readonly factory: string;
  readonly args: readonly string[];
  readonly home: boolean;
  readonly branch: string | null;
  readonly queryFingerprint: string;
}

interface Pending {
  capability?: string;
  detach?: () => void;
  sentAt?: number;
  arrived: boolean;
  rendered: boolean;
  disposed: boolean;
}

// Bearer capabilities stay private, including while an SDK retry waits for a new socket.
const awaiting = new Map<string, QueryObservation>();
const pending = new WeakMap<QueryObservation, Pending>();
let nextId = 0;

export function observeQuery(context: Omit<QueryObservation, 'id'>): QueryObservation {
  const observation = { ...context, args: [...context.args], id: String(++nextId) };
  pending.set(observation, { arrived: false, rendered: false, disposed: false });
  return observation;
}

export function expectSubscribe(capability: string, observation: QueryObservation): void {
  const state = pending.get(observation);
  if (!state || state.arrived || state.disposed) return;
  if (state.capability) awaiting.delete(state.capability);
  state.capability = capability;
  awaiting.set(capability, observation);
}

function release(state: Pending): void {
  if (state.capability) awaiting.delete(state.capability);
  state.capability = undefined;
  state.detach?.();
  state.detach = undefined;
}

export function discardObservation(observation: QueryObservation): void {
  const state = pending.get(observation);
  if (!state) return;
  release(state);
  state.disposed = true;
}

/** Called only after the panel's delivered rows (including []) have committed as ready. */
export function markRendered(observation: QueryObservation): void {
  const state = pending.get(observation);
  if (!state || state.disposed) return;
  const name = `live:${observation.query}:ready`;
  if (performance.getEntriesByName(name).length === 0) {
    performance.mark(name, { detail: observation });
  }
  if (!state.arrived || state.rendered) return;
  performance.mark(`live:${observation.query}:rendered`, { detail: observation });
  state.rendered = true;
}

function envelope(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'string') return;
  try {
    const value: unknown = JSON.parse(data);
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // The SDK owns protocol validation; instrumentation must still forward malformed frames.
  }
}

function counter(value: unknown): bigint | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
}

interface Admission {
  observation: QueryObservation;
  epoch: bigint;
  attempt?: bigint;
  reset?: { publication: string; epoch: bigint };
}

/** Observes the pinned SDK's complete baseline before decoding and publication. */
export function markingSubscribes(factory: WebSocketFactory): WebSocketFactory {
  return (url, protocols) => {
    const socket = factory(url, protocols);
    const requests = new Map<string, QueryObservation>();
    const live = new Map<string, Admission>();
    const clear = () => {
      requests.clear();
      live.clear();
    };
    socket.addEventListener('close', clear);

    function incoming(data: unknown, arrivedAt: number): void {
      const message = envelope(data);
      if (!message) return;
      const { type, request_id: requestId, live_id: liveId } = message;
      if (type === 'subscribe_rejected' && typeof requestId === 'string')
        requests.delete(requestId);
      if (type === 'connection_error') clear();
      if (
        type === 'reset_required' &&
        typeof message.publication_id === 'string' &&
        Array.isArray(message.targets)
      ) {
        const targets: unknown[] = message.targets;
        for (const target of targets) {
          if (!target || typeof target !== 'object') continue;
          const fields = target as Record<string, unknown>;
          const admission =
            typeof fields.live_id === 'string' ? live.get(fields.live_id) : undefined;
          const epoch = counter(fields.epoch);
          if (admission && epoch !== undefined && epoch > admission.epoch)
            admission.reset = { publication: message.publication_id, epoch };
        }
      }
      if (type === 'commit') {
        for (const admission of live.values()) {
          if (admission.reset && admission.reset.publication === message.publication_id) {
            admission.epoch = admission.reset.epoch;
            admission.attempt = undefined;
            admission.reset = undefined;
          }
        }
      }
      if (typeof liveId !== 'string') return;
      if (type === 'subscribed' && typeof requestId === 'string') {
        const observation = requests.get(requestId);
        requests.delete(requestId);
        const epoch = counter(message.epoch);
        if (observation && epoch !== undefined) live.set(liveId, { observation, epoch });
        return;
      }
      const admission = live.get(liveId);
      if (!admission) return;
      if (type === 'unsubscribed' || type === 'subscription_error') {
        live.delete(liveId);
        return;
      }
      const attempt = counter(message.baseline_sync_attempt);
      if (counter(message.epoch) !== admission.epoch || attempt === undefined) return;
      if (
        type === 'baseline_sync_start' &&
        (admission.attempt === undefined || attempt > admission.attempt)
      ) {
        admission.attempt = attempt;
      }
      if (type !== 'baseline_sync_end' || admission.attempt !== attempt) return;
      const { observation } = admission;
      const state = pending.get(observation);
      if (!state || state.arrived || state.disposed) return;
      performance.mark(`live:${observation.query}:first-result`, {
        startTime: arrivedAt,
        detail: { ...observation, subscribedAt: state.sentAt },
      });
      state.arrived = true;
      release(state);
    }

    const add: WebSocketLike['addEventListener'] = (type, listener) => {
      if (type === 'message') {
        socket.addEventListener('message', (event) => {
          const arrivedAt = performance.now();
          incoming(event.data, arrivedAt);
          listener(event);
        });
      } else if (type === 'open') socket.addEventListener('open', listener as () => void);
      else if (type === 'close') socket.addEventListener('close', listener as () => void);
      else socket.addEventListener('error', listener as () => void);
    };
    return {
      get readyState() {
        return socket.readyState;
      },
      addEventListener: add,
      send(data) {
        socket.send(data);
        const sentAt = performance.now();
        const message = envelope(data);
        if (!message) return;
        if (message.type === 'unsubscribe' && typeof message.live_id === 'string') {
          live.delete(message.live_id);
        }
        if (
          message.type !== 'subscribe' ||
          typeof message.authorization !== 'string' ||
          typeof message.request_id !== 'string'
        )
          return;
        const observation = awaiting.get(message.authorization);
        const state = observation && pending.get(observation);
        if (!observation || !state) return;
        state.detach?.();
        const requestId = message.request_id;
        requests.set(requestId, observation);
        state.detach = () => {
          requests.delete(requestId);
          for (const [id, admission] of live)
            if (admission.observation === observation) live.delete(id);
        };
        state.sentAt ??= sentAt;
        const name = `live:${observation.query}:subscribe-sent`;
        if (performance.getEntriesByName(name).length === 0)
          performance.mark(name, { startTime: sentAt });
      },
      close(code, reason) {
        clear();
        socket.close(code, reason);
      },
      ...(socket.terminate && {
        terminate: () => {
          clear();
          socket.terminate?.();
        },
      }),
    };
  };
}
