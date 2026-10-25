import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A headless Chrome, Chromium or Edge driven over the DevTools protocol, for `test:live`. The
 * launch follows `harness/design-probe.js`, which exports nothing to share.
 */
export interface Page {
  /** Evaluates `expression` in the page, awaiting a promise, and returns its JSON value. */
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  /** Navigates and resolves once the page's load event fires. */
  goto(url: string): Promise<void>;
  close(): Promise<void>;
}

const STEP_TIMEOUT_MS = 20_000;

function findBrowser(env: Record<string, string | undefined>): string {
  if (env.MC_BROWSER) return env.MC_BROWSER;
  const candidates: Record<string, string[]> = {
    win32: [
      `${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
  };
  const found = candidates[process.platform]
    ? candidates[process.platform].find((path) => existsSync(path))
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
        .map((name) => Bun.which(name))
        .find(Boolean);
  if (!found) throw new Error('no Chrome, Chromium or Edge found: set MC_BROWSER to one');
  return found;
}

async function devToolsUrl(profile: string, exited: () => boolean): Promise<string> {
  const activePort = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited()) throw new Error('the browser exited before opening its DevTools port');
    const lines = existsSync(activePort) ? readFileSync(activePort, 'utf8').split('\n') : [];
    if (lines.length >= 2 && lines[1]) return `ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`;
    await Bun.sleep(100);
  }
  throw new Error('the browser did not open its DevTools port within 20s');
}

type Message = { id?: number; method?: string; sessionId?: string; result?: unknown } & {
  error?: { message: string };
  params?: unknown;
};

function connect(url: string) {
  const socket = new WebSocket(url);
  const pending = new Map<number, (message: Message) => void>();
  const events = new Set<(message: Message) => void>();
  let nextId = 1;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as Message;
    if (message.id !== undefined) pending.get(message.id)?.(message);
    else for (const listener of events) listener(message);
  };
  const send = <T>(
    method: string,
    params: object,
    sessionId?: string,
    timeoutMs = STEP_TIMEOUT_MS,
  ): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} got no answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result as T);
      });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  };
  const once = (method: string, sessionId: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        events.delete(listener);
        reject(new Error(`${method} did not arrive within ${STEP_TIMEOUT_MS / 1000}s`));
      }, STEP_TIMEOUT_MS);
      const listener = (message: Message) => {
        if (message.method !== method || message.sessionId !== sessionId) return;
        clearTimeout(timer);
        events.delete(listener);
        resolve();
      };
      events.add(listener);
    });
  return new Promise<{ send: typeof send; once: typeof once; close: () => void }>(
    (resolve, reject) => {
      socket.onopen = () => resolve({ send, once, close: () => socket.close() });
      socket.onerror = () => reject(new Error(`could not connect to ${url}`));
    },
  );
}

export async function openPage(env: Record<string, string | undefined>): Promise<Page> {
  const profile = mkdtempSync(join(tmpdir(), 'mc-test-live-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
  if (process.platform === 'linux' && env.CI) args.unshift('--no-sandbox');
  const proc = spawn(findBrowser(env), args, { stdio: 'ignore' });
  const exited = new Promise((done) => proc.once('exit', done));
  const stop = async () => {
    if (proc.exitCode === null) {
      proc.kill();
      await Promise.race([exited, Bun.sleep(5000)]);
    }
    // On Windows the browser's child processes can hold the profile for a while after it exits.
    // A temp folder left behind is not a test failure, so removing it is best effort.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {}
  };
  try {
    const cdp = await connect(await devToolsUrl(profile, () => proc.exitCode !== null));
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await cdp.send('Page.enable', {}, sessionId);
    return {
      async evaluate<T>(expression: string, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
        const { result, exceptionDetails } = await cdp.send<{
          result: { value: T };
          exceptionDetails?: { exception?: { description?: string }; text: string };
        }>(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
          timeoutMs,
        );
        if (exceptionDetails) {
          throw new Error(
            `the page threw: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
          );
        }
        return result.value;
      },
      async goto(url: string) {
        const loaded = cdp.once('Page.loadEventFired', sessionId);
        loaded.catch(() => {});
        const { errorText } = await cdp.send<{ errorText?: string }>(
          'Page.navigate',
          { url },
          sessionId,
        );
        if (errorText) throw new Error(`could not load ${url}: ${errorText}`);
        await loaded;
      },
      async close() {
        await cdp.send('Browser.close', {}).catch(() => {});
        cdp.close();
        await stop();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
