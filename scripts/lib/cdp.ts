import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PORT_FILE_NOT_WRITTEN_YET } from '../../harness/design-probe.js';

/** A headless Chrome, Chromium or Edge driven over the DevTools protocol, for `test:live`. */
export interface Page {
  /** Evaluates `expression` in the page, awaiting a promise, and returns its JSON value. */
  evaluate<T>(expression: string, timeoutMs?: number): Promise<T>;
  /** Navigates and resolves once the page's load event fires. */
  goto(url: string): Promise<void>;
  /** Resolves once the resized page has been drawn (two animation frames), so a remount the width causes has committed. */
  setViewport(width: number, height?: number): Promise<void>;
  /** One real mouse event at page coordinates `x`, `y`, left button; a move while pressed is a drag. */
  mouse(event: MouseInput): Promise<void>;
  /** One real touch event with a single finger at page coordinates `x`, `y`; a move while down is a drag. */
  touch(type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number): Promise<void>;
  /** One real key press and release of `key` ('Enter' or 'Tab'), as the keyboard sends it. */
  key(key: 'Enter' | 'Tab'): Promise<void>;
  /** A PNG of the whole page laid out `width` px wide. */
  screenshot(width: number): Promise<Buffer>;
  close(): Promise<void>;
}

export interface MouseInput {
  type: 'mousePressed' | 'mouseMoved' | 'mouseReleased' | 'mouseWheel';
  x: number;
  y: number;
  /** 1 for a press that starts a click, 2 for the one that completes a double-click. */
  clickCount?: number;
  deltaY?: number;
}

const STEP_TIMEOUT_MS = 20_000;
// A cold first browser start on CI can stall past 45 s before it writes its DevTools port, while
// a fresh process opens it in about 20 s (#355, #368, #386, #423). So each launch waits 30 s and a
// miss relaunches once.
const DEVTOOLS_PORT_WAIT_MS = 30_000;

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

/** Chrome may still hold this file open for writing on Windows while publishing its port. */
export function readDevToolsUrl(
  activePort: string,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string | undefined {
  let lines: string[];
  try {
    lines = read(activePort).split('\n');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && PORT_FILE_NOT_WRITTEN_YET.has(code)) return undefined;
    throw error;
  }
  if (lines.length >= 2 && lines[1]) return `ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`;
  return undefined;
}

class DevToolsPortTimeout extends Error {}

async function devToolsUrl(
  profile: string,
  exited: () => boolean,
  waitMs: number,
): Promise<string> {
  const activePort = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (exited()) throw new Error('the browser exited before opening its DevTools port');
    const url = readDevToolsUrl(activePort);
    if (url) return url;
    await Bun.sleep(100);
  }
  throw new DevToolsPortTimeout(
    `the browser did not open its DevTools port within ${waitMs / 1000}s`,
  );
}

interface Launch {
  profile: string;
  exited(): boolean;
  stop(): Promise<void>;
}

/**
 * Launches a browser and waits for its DevTools port. A launch that misses the wait is stopped and
 * replaced; a browser that exits, or never opens its port, still fails with the same errors.
 */
export async function startBrowser(
  launch: () => Launch,
  waitMs = DEVTOOLS_PORT_WAIT_MS,
): Promise<{ url: string; stop: () => Promise<void> }> {
  for (let attempt = 1; ; attempt++) {
    const browser = launch();
    try {
      return {
        url: await devToolsUrl(browser.profile, browser.exited, waitMs),
        stop: browser.stop,
      };
    } catch (error) {
      await browser.stop();
      if (!(error instanceof DevToolsPortTimeout) || attempt >= 2) throw error;
      console.warn(`${error.message}; launching it once more`);
    }
  }
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

function launchBrowser(env: Record<string, string | undefined>): Launch {
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
  return { profile, exited: () => proc.exitCode !== null, stop };
}

export async function openPage(env: Record<string, string | undefined>): Promise<Page> {
  const { url, stop } = await startBrowser(() => launchBrowser(env));
  try {
    const cdp = await connect(url);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await cdp.send('Page.enable', {}, sessionId);
    const setViewport = async (width: number, height = 900) => {
      const metrics = { width, height, deviceScaleFactor: 1, mobile: false };
      await cdp.send('Emulation.setDeviceMetricsOverride', metrics, sessionId);
      // A resize across the shell's 1024 px switch remounts the routed page on the next rendering
      // update. Two frames let that commit before the caller reads (#728).
      await cdp.send(
        'Runtime.evaluate',
        {
          expression:
            'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))',
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );
    };
    let pressed = false;
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
      setViewport,
      async mouse({ type, x, y, clickCount = 0, deltaY = 0 }: MouseInput) {
        if (type === 'mousePressed') pressed = true;
        else if (type === 'mouseReleased') pressed = false;
        await cdp.send(
          'Input.dispatchMouseEvent',
          {
            type,
            x,
            y,
            button: type === 'mouseMoved' && !pressed ? 'none' : 'left',
            buttons: pressed ? 1 : 0,
            clickCount,
            deltaX: 0,
            deltaY,
          },
          sessionId,
        );
      },
      async touch(type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) {
        await cdp.send(
          'Input.dispatchTouchEvent',
          { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] },
          sessionId,
        );
      },
      async key(key: 'Enter' | 'Tab') {
        const code = { Enter: 13, Tab: 9 }[key];
        const text = key === 'Enter' ? String.fromCharCode(13) : undefined;
        const event = { key, code: key, windowsVirtualKeyCode: code, text };
        await cdp.send(
          'Input.dispatchKeyEvent',
          { type: text ? 'keyDown' : 'rawKeyDown', ...event },
          sessionId,
        );
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event }, sessionId);
      },
      async screenshot(width: number) {
        await setViewport(width);
        const { cssContentSize } = await cdp.send<{
          cssContentSize: { width: number; height: number };
        }>('Page.getLayoutMetrics', {}, sessionId);
        const { data } = await cdp.send<{ data: string }>(
          'Page.captureScreenshot',
          {
            format: 'png',
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width, height: cssContentSize.height, scale: 1 },
          },
          sessionId,
        );
        return Buffer.from(data, 'base64');
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
