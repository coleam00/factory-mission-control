#!/usr/bin/env bun
/**
 * The design probe (PRD 8.3). Loads a URL in a headless Chromium at 1440 px and 390 px and fails
 * on any computed color outside the tokens copied in docs/design/archon-console/, any text font
 * other than Geist or Geist Mono, a browser-default control, text contrast below 4.5:1,
 * horizontal overflow, and any interactive element without an accessible name.
 *
 *   bun harness/design-probe.js <url> [--out <report.json>]
 *
 * Prints the JSON report and writes it to --out when given. Exits 0 only on zero failures, 1 on
 * any failure, 2 when the probe itself could not run. The browser is Chrome, Chromium or Edge,
 * found on this machine or named by MC_BROWSER, and driven over the DevTools protocol.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const WIDTHS = [1440, 390];
const HEIGHT = 900;
const TOKEN_SOURCES = ['index.css', 'theme.css'].map((f) =>
  resolve(import.meta.dir, '..', 'docs', 'design', 'archon-console', f),
);

class ProbeError extends Error {}

/** Every custom property each token file declares, in source order. */
function tokenDeclarations(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)].map(([, name, value]) => [
    name,
    value.trim(),
  ]);
}

function findBrowser() {
  if (Bun.env.MC_BROWSER) return Bun.env.MC_BROWSER;
  const env = process.env;
  const candidates = {
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
  }[process.platform];
  const found = candidates
    ? candidates.find((path) => existsSync(path))
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
        .map((name) => Bun.which(name))
        .find(Boolean);
  if (!found) throw new ProbeError('no Chrome, Chromium or Edge found: set MC_BROWSER to one');
  return found;
}

async function poll(what, timeoutMs, attempt) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await attempt();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new ProbeError(`${what} did not happen within ${timeoutMs / 1000}s`);
}

async function launchBrowser() {
  const profile = mkdtempSync(join(tmpdir(), 'design-probe-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    'about:blank',
  ];
  // GitHub's Ubuntu runners restrict the unprivileged user namespaces Chrome's sandbox needs.
  if (process.platform === 'linux' && Bun.env.CI) args.unshift('--no-sandbox');
  const proc = spawn(findBrowser(), args, { stdio: 'ignore' });
  const exited = new Promise((done) => proc.once('exit', done));
  const close = async () => {
    if (proc.exitCode === null) {
      proc.kill();
      await Promise.race([exited, Bun.sleep(5000)]);
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    const activePort = join(profile, 'DevToolsActivePort');
    const [port, path] = await poll('the browser opening its DevTools port', 20000, () => {
      if (proc.exitCode !== null) throw new ProbeError(`the browser exited with ${proc.exitCode}`);
      const lines = existsSync(activePort) ? readFileSync(activePort, 'utf8').split('\n') : [];
      return lines.length >= 2 && lines[1] ? lines : undefined;
    });
    return { cdp: await connect(`ws://127.0.0.1:${port.trim()}${path.trim()}`), close };
  } catch (error) {
    await close();
    throw error;
  }
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiting = pending.get(message.id);
    if (waiting) {
      pending.delete(message.id);
      if (message.error)
        waiting.reject(new ProbeError(`${waiting.method}: ${message.error.message}`));
      else waiting.resolve(message.result);
    } else {
      for (const listener of listeners) listener(message);
    }
  };
  const cdp = {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject, method });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    once(method, sessionId) {
      return new Promise((resolve) => {
        const listener = (message) => {
          if (message.method === method && message.sessionId === sessionId) {
            listeners.delete(listener);
            resolve(message.params);
          }
        };
        listeners.add(listener);
      });
    },
    close: () => socket.close(),
  };
  return new Promise((resolve, reject) => {
    socket.onopen = () => resolve(cdp);
    socket.onerror = () => reject(new ProbeError(`could not connect to ${url}`));
  });
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

async function unnamedInteractiveElements(cdp, session) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, session);
  const unnamed = nodes.filter(
    (node) =>
      !node.ignored &&
      INTERACTIVE_ROLES.has(node.role?.value) &&
      !String(node.name?.value ?? '').trim() &&
      node.backendDOMNodeId !== undefined,
  );
  return Promise.all(
    unnamed.map(async (node) => {
      const { node: dom } = await cdp.send(
        'DOM.describeNode',
        { backendNodeId: node.backendDOMNodeId },
        session,
      );
      const attributes = Object.fromEntries(
        (dom.attributes ?? []).flatMap((v, i, all) => (i % 2 ? [] : [[v, all[i + 1]]])),
      );
      const id = attributes.id ? `#${attributes.id}` : '';
      const classes = (attributes.class ?? '').split(/\s+/).filter(Boolean).slice(0, 3);
      return {
        check: 'accessible-name',
        element: `${dom.localName}${id}${classes.map((c) => `.${c}`).join('')}`,
        detail: `role ${node.role.value} has no accessible name`,
      };
    }),
  );
}

/**
 * Runs inside the page: serialized with toString, so it may use nothing from this module.
 * `tokenLayers` is one list of declarations per token file, each layered over the ones before it
 * the way the page cascades them.
 */
async function pageChecks(tokenLayers) {
  await document.fonts.ready;
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));

  const MIN_CONTRAST = 4.5;
  const FONTS = new Set(['Geist', 'Geist Mono']);
  const failures = [];
  const fail = (check, el, detail) => failures.push({ check, element: describe(el), detail });

  function describe(el) {
    const parts = [];
    for (let node = el; node && node !== document.documentElement && parts.length < 3; ) {
      const id = node.id ? `#${node.id}` : '';
      const classes = [...node.classList].slice(0, 3).map((c) => `.${c}`);
      parts.unshift(`${node.localName}${id}${classes.join('')}`);
      node = node.parentElement;
    }
    return parts.join(' > ') || el.localName;
  }

  const pixel = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
  const paint = pixel.getContext('2d', { willReadFrequently: true });
  /** The sRGB channels the screen shows for a color, with its alpha read separately. */
  function alphaOf(css) {
    if (css === 'transparent') return 0;
    const written = css.startsWith('rgba(')
      ? css.match(/,\s*([\d.]+%?)\s*\)$/)
      : css.match(/\/\s*([\d.]+%?)\s*\)$/);
    if (!written) return 1;
    return written[1].endsWith('%') ? Number.parseFloat(written[1]) / 100 : Number(written[1]);
  }
  function rgba(css) {
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = '#000';
    paint.fillStyle = `rgb(from ${css} r g b / 1)`;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b] = paint.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: alphaOf(css) };
  }
  const key = ({ r, g, b }) => `${r},${g},${b}`;

  const SENTINEL = 'rgb(1, 2, 3)';
  const palette = new Set();
  const hosts = document.createElement('div');
  hosts.style.cssText = `position:absolute;visibility:hidden;color:${SENTINEL}`;
  document.body.append(hosts);
  for (let depth = 1; depth <= tokenLayers.length; depth++) {
    const host = hosts.appendChild(document.createElement('div'));
    for (const [name, value] of tokenLayers.slice(0, depth).flat())
      host.style.setProperty(name, value);
    for (const [name] of tokenLayers[depth - 1]) {
      const swatch = host.appendChild(document.createElement('span'));
      swatch.style.color = `var(${name})`;
      const resolved = getComputedStyle(swatch).color;
      if (resolved !== SENTINEL) palette.add(key(rgba(resolved)));
    }
  }
  hosts.remove();

  const inPalette = (color) => {
    const { r, g, b } = rgba(color);
    for (const dr of [-1, 0, 1])
      for (const dg of [-1, 0, 1])
        for (const db of [-1, 0, 1])
          if (palette.has(key({ r: r + dr, g: g + dg, b: b + db }))) return true;
    return false;
  };
  const checkColor = (el, property, color) => {
    if (rgba(color).a > 0 && !inPalette(color))
      fail('color', el, `${property} ${color} is not a token`);
  };

  const luminance = ({ r, g, b }) => {
    const [R, G, B] = [r, g, b].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const backdrop = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      layers.unshift(rgba(getComputedStyle(node).backgroundColor));
    }
    return layers.reduce((below, layer) => over(layer, below), { r: 255, g: 255, b: 255, a: 1 });
  };

  const blank = document.body.appendChild(document.createElement('iframe'));
  blank.style.display = 'none';
  const userAgentDefault = (el) => {
    const twin = blank.contentDocument.createElement(el.localName);
    if (el.getAttribute('type')) twin.setAttribute('type', el.getAttribute('type'));
    blank.contentDocument.documentElement.style.colorScheme = getComputedStyle(el).colorScheme;
    blank.contentDocument.body.append(twin);
    return getComputedStyle(twin);
  };
  const DEFAULT_LOOK = [
    'background-color',
    'border-top-style',
    'border-top-width',
    'border-top-color',
    'font-family',
  ];

  const loaded = new Set(
    [...document.fonts]
      .filter((f) => f.status === 'loaded')
      .map((f) => f.family.replace(/["']/g, '')),
  );
  const SVG_PAINTED = new Set([
    'path',
    'circle',
    'rect',
    'line',
    'polyline',
    'polygon',
    'ellipse',
    'text',
  ]);

  for (const el of document.querySelectorAll('*')) {
    if (el === blank || !el.getClientRects().length) continue;
    const style = getComputedStyle(el);
    if (style.visibility !== 'visible') continue;

    checkColor(el, 'background-color', style.backgroundColor);
    const borderColors = new Set();
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
      if (
        width > 0 &&
        !['none', 'hidden'].includes(style.getPropertyValue(`border-${side}-style`))
      ) {
        borderColors.add(style.getPropertyValue(`border-${side}-color`));
      }
    }
    for (const color of borderColors) checkColor(el, 'border-color', color);
    if (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) {
      checkColor(el, 'outline-color', style.outlineColor);
    }
    if (SVG_PAINTED.has(el.localName) && el instanceof SVGElement) {
      for (const property of ['fill', 'stroke']) {
        const paintValue = style.getPropertyValue(property);
        if (paintValue !== 'none' && !paintValue.startsWith('url('))
          checkColor(el, property, paintValue);
      }
    }

    if (
      ['button', 'select', 'textarea'].includes(el.localName) ||
      (el.localName === 'input' && el.type !== 'hidden')
    ) {
      const ua = userAgentDefault(el);
      if (DEFAULT_LOOK.every((p) => style.getPropertyValue(p) === ua.getPropertyValue(p))) {
        fail('default-control', el, `<${el.localName}> keeps the browser's default look`);
      }
    }

    const ownText = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim(),
    );
    if (!ownText) continue;
    checkColor(el, 'color', style.color);
    const family = style.fontFamily.split(',')[0].trim().replace(/["']/g, '');
    if (!FONTS.has(family))
      fail('font', el, `font-family ${style.fontFamily} is not Geist or Geist Mono`);
    else if (!loaded.has(family)) fail('font', el, `${family} is named but never loaded`);
    const background = backdrop(el);
    const text = over(rgba(style.color), background);
    const [light, dark] = [luminance(text), luminance(background)].sort((a, b) => b - a);
    const ratio = (light + 0.05) / (dark + 0.05);
    if (ratio < MIN_CONTRAST) {
      fail('contrast', el, `text contrast ${ratio.toFixed(2)}:1 is below ${MIN_CONTRAST}:1`);
    }
  }
  blank.remove();

  const viewport = document.documentElement.clientWidth;
  const scrollWidth = document.documentElement.scrollWidth;
  if (scrollWidth > viewport) {
    const wide = [...document.body.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > viewport + 0.5)
      .filter(
        (el) =>
          !el.parentElement || el.parentElement.getBoundingClientRect().right <= viewport + 0.5,
      )
      .slice(0, 5)
      .map(describe);
    failures.push({
      check: 'overflow',
      element: wide.join(', ') || 'html',
      detail: `the page is ${scrollWidth}px wide in a ${viewport}px viewport`,
    });
  }
  return { failures, tokenColors: palette.size };
}

async function probeAt(cdp, session, url, width, tokenLayers) {
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false },
    session,
  );
  const loaded = cdp.once('Page.loadEventFired', session);
  const { errorText } = await cdp.send('Page.navigate', { url }, session);
  if (errorText) throw new ProbeError(`could not load ${url}: ${errorText}`);
  await loaded;
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    {
      expression: `(${pageChecks.toString()})(${JSON.stringify(tokenLayers)})`,
      awaitPromise: true,
      returnByValue: true,
    },
    session,
  );
  if (exceptionDetails) {
    throw new ProbeError(
      `the checks threw in the page: ${exceptionDetails.exception?.description}`,
    );
  }
  const failures = [...result.value.failures, ...(await unnamedInteractiveElements(cdp, session))];
  return {
    failures: failures.map((f) => ({ width, ...f })),
    tokenColors: result.value.tokenColors,
  };
}

async function probe(url) {
  const tokenLayers = TOKEN_SOURCES.map((path) => tokenDeclarations(readFileSync(path, 'utf8')));
  const browser = await launchBrowser();
  try {
    const { cdp } = browser;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    const failures = [];
    let tokenColors = 0;
    for (const width of WIDTHS) {
      const at = await probeAt(cdp, sessionId, url, width, tokenLayers);
      failures.push(...at.failures);
      tokenColors = at.tokenColors;
    }
    await cdp.send('Browser.close').catch(() => {});
    cdp.close();
    return { url, widths: WIDTHS, tokenColors, failureCount: failures.length, failures };
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { out: { type: 'string' } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) {
    console.error('usage: bun harness/design-probe.js <url> [--out <report.json>]');
    process.exit(2);
  }
  try {
    const report = await probe(positionals[0]);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.out) writeFileSync(values.out, json);
    process.stdout.write(json);
    process.exit(report.failureCount === 0 ? 0 : 1);
  } catch (error) {
    console.error(`design probe could not run: ${error.message}`);
    process.exit(2);
  }
}
