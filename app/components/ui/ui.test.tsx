import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { STATES } from '../../lib/states';
import { Button } from './Button';
import { Card } from './Card';
import { Chip } from './Chip';
import { ErrorPanel } from './ErrorPanel';
import { ManagerNote } from './ManagerNote';
import { OptionTile, RecommendedTag } from './OptionTile';
import { Segmented } from './Segmented';
import { Sparkline } from './Sparkline';
import { Pill, StateDot } from './StateDot';
import { Timeline, TimelineRow } from './Timeline';
import { Toast } from './Toast';

const noop = () => {};

// The `--color-*` names the theme turns into utilities (`bg-error`, `text-text-primary`).
const THEME_COLORS = [
  ...(readFileSync('app/styles.css', 'utf8').split('@theme inline')[1] ?? '').matchAll(
    /--color-([\w-]+):/g,
  ),
].map((m) => m[1] ?? '');
const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';
const COLOR_UTILITY =
  '(?:bg|text|border(?:-[trblxy])?|outline|ring|fill|stroke|decoration|shadow|accent|caret|divide|from|via|to)';

/** The colors in rendered markup that do not come from a `--v3-*` token. */
function nonV3Colors(html: string): string[] {
  const found: string[] = [];
  const attrs = [...html.matchAll(/\b(?:class|style)="([^"]*)"/g)].map((m) => m[1] ?? '');
  for (const attr of attrs) {
    for (const m of attr.matchAll(/var\(--(?!v3-)[\w-]+/g)) found.push(m[0]);
    for (const m of attr.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/gi))
      found.push(m[0]);
    for (const cls of attr.split(/\s+/)) {
      const theme = new RegExp(`^${COLOR_UTILITY}-(${THEME_COLORS.join('|')})(?:/\\d+)?$`);
      const palette = new RegExp(
        `^${COLOR_UTILITY}-(?:(?:${PALETTE})-\\d+|black|white)(?:/\\d+)?$`,
      );
      if (theme.test(cls) || palette.test(cls)) found.push(cls);
    }
    // A border width with no v3 color falls back to the global `border-border`.
    const classes = attr.split(/\s+/);
    const width = classes.some((c) => /^border(?:-[trblxy])?(?:-\d+)?$/.test(c));
    const colored = classes.some((c) =>
      /^border-\[color:(?:var\(--v3-[\w-]+\)|transparent)\]$/.test(c),
    );
    if (width && !colored) found.push(`border without a v3 color: ${attr}`);
  }
  return found;
}

const VARIANTS: [string, ReactElement][] = [
  ...(['primary', 'secondary', 'text'] as const).map((variant): [string, ReactElement] => [
    `Button ${variant}`,
    <Button key={variant} variant={variant}>
      Go
    </Button>,
  ]),
  ...STATES.flatMap((state): [string, ReactElement][] => [
    [`StateDot ${state}`, <StateDot key={state} state={state} />],
    [`Pill ${state}`, <Pill key={state} state={state} />],
  ]),
  ['Pill neutral', <Pill key="n">route deliver</Pill>],
  [
    'Pill live',
    <Pill key="l" state="running" live>
      round 2
    </Pill>,
  ],
  [
    'Chip pressed with count',
    <Chip key="a" pressed count={3} onClick={noop}>
      Failed
    </Chip>,
  ],
  [
    'Chip with a state',
    <Chip key="b" pressed={false} state="failed" onClick={noop}>
      Failed
    </Chip>,
  ],
  [
    'Segmented',
    <Segmented
      key="s"
      label="View"
      value="a"
      onChange={noop}
      options={[
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ]}
    />,
  ],
  ['Card', <Card key="c">body</Card>],
  [
    'ManagerNote',
    <ManagerNote key="m">
      <b>2 runs</b> need you.
    </ManagerNote>,
  ],
  ['OptionTile', <OptionTile key="o" label="Merge" consequence="Lands the PR" />],
  ['OptionTile recommended', <OptionTile key="r" recommended label="Merge" consequence="Lands" />],
  ['RecommendedTag', <RecommendedTag key="t" />],
  ['Sparkline', <Sparkline key="p" counts={[0, 2, 5, 1]} />],
  ['Sparkline empty', <Sparkline key="q" counts={[0, 0]} />],
  [
    'Timeline',
    <Timeline key="tl">
      {STATES.map((state) => (
        <TimelineRow key={state} state={state} name={state} hint="a hint" time="2m" cost="$0.10" />
      ))}
      <TimelineRow state="done" name="nested" nested />
      <TimelineRow state="failed" name="broken">
        <ErrorPanel title="Failed" error="boom" />
      </TimelineRow>
    </Timeline>,
  ],
  ['TimelineRow', <TimelineRow key="row" state="running" name="step" />],
  ['ErrorPanel', <ErrorPanel key="e" title="Failed" error="boom" />],
  [
    'ErrorPanel with actions',
    <ErrorPanel
      key="ea"
      title="Failed"
      error="boom"
      actions={<Button variant="secondary">Retry</Button>}
    />,
  ],
  [
    'Toast',
    <Toast key="to" onUndo={noop}>
      Answered
    </Toast>,
  ],
];

test.each(VARIANTS)('%s renders with v3 tokens only', (_name, element) => {
  const html = renderToStaticMarkup(element);
  expect(nonV3Colors(html)).toEqual([]);
  expect(html).toContain('--v3-');
});

test('every component the folder exports is rendered above', async () => {
  const names = new Set(VARIANTS.map(([name]) => name.split(' ')[0]));
  const files = readdirSync('app/components/ui').filter(
    (f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'),
  );
  for (const file of files) {
    const mod = await import(`./${file}`);
    for (const [name, value] of Object.entries(mod))
      if (/^[A-Z]/.test(name) && typeof value === 'function')
        expect(names, `${file} exports ${name} with no variant`).toContain(name);
  }
});

test('the detector refuses a color that is not a v3 token and passes one that is', () => {
  const bad = [
    '<i style="color:var(--running)"></i>',
    '<i style="color:#fff"></i>',
    '<i style="color:rgba(0,0,0,.4)"></i>',
    '<i class="text-error"></i>',
    '<i class="bg-surface/50"></i>',
    '<i class="bg-red-500"></i>',
    '<i class="text-white"></i>',
    '<i class="border px-2"></i>',
  ];
  for (const html of bad) expect(nonV3Colors(html), html).not.toEqual([]);
  const good = '<i class="border border-[color:var(--v3-line)] bg-[var(--v3-panel)]"></i>';
  expect(nonV3Colors(good)).toEqual([]);
});

test('text sizes come from the five v3 sizes', () => {
  for (const [name, element] of VARIANTS) {
    const html = renderToStaticMarkup(element);
    for (const cls of html.matchAll(/\btext-(?:\[\d[^\]]*\]|xs|sm|base|lg|[2-9]?xl)\b/g))
      throw new Error(`${name} sets the text size ${cls[0]}`);
  }
});

test('the compact Pill and the badge RecommendedTag keep the box the Board and Decisions tags had', () => {
  const pill = renderToStaticMarkup(
    <Pill compact state="running" live>
      round 2
    </Pill>,
  );
  expect(pill).toContain('gap-1 rounded-[5px] px-1.5 py-0.5');
  expect(pill).toContain('size-1.5');
  expect(pill).toContain('text-[11px]');
  expect(pill).not.toMatch(/leading-|font-medium/);
  expect(renderToStaticMarkup(<Pill>x</Pill>)).toContain('px-2 py-1');
  const tag = renderToStaticMarkup(<RecommendedTag badge>default</RecommendedTag>);
  expect(tag).toContain('shrink-0 rounded');
  expect(tag).toContain('px-1.5 py-px');
  expect(tag).toContain('uppercase');
  expect(tag).toContain('text-[10px] font-semibold');
  expect(tag).not.toContain('ml-1.5');
  expect(nonV3Colors(pill + tag)).toEqual([]);
});

test('a Pill keeps its data attributes ahead of its class and wraps a long token', () => {
  const html = renderToStaticMarkup(<Pill data-chip="order">x</Pill>);
  expect(html).toMatch(/<span data-chip="order" class="[^"]*\[overflow-wrap:anywhere\]/);
});
