import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { STATES } from '../../lib/states';
import { Button, buttonClass } from './Button';
import { Card } from './Card';
import { Chip } from './Chip';
import { ErrorPanel } from './ErrorPanel';
import { ManagerNote } from './ManagerNote';
import { OptionTile, RecommendedTag } from './OptionTile';
import { Segmented } from './Segmented';
import { Sparkline } from './Sparkline';
import { Pill, StateDot } from './StateDot';
import { Tabs } from './Tabs';
import { Timeline, TimelineRow } from './Timeline';
import { Toast } from './Toast';
import { nonV3Colors } from './v3-colors';

const noop = () => {};

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
  [
    'TimelineRow prose',
    <TimelineRow
      key="pr"
      prose
      state="failed"
      name="Round 1 failed"
      time="2m"
      dateTime="2026-01-01T00:00:00Z"
    />,
  ],
  [
    'Tabs',
    <Tabs
      key="tabs"
      label="Details"
      value="b"
      onChange={noop}
      tabs={[
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ]}
    />,
  ],
  [
    'Button class on a link',
    <a key="bl" href="/x" className={buttonClass('primary')}>
      Resume
    </a>,
  ],
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

test('Tabs marks the chosen tab selected, in the order the map tests read', () => {
  const html = renderToStaticMarkup(
    <Tabs
      label="Details"
      value="b"
      onChange={noop}
      tabs={[
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ]}
    />,
  );
  expect(html).toContain('aria-selected="true" data-tab="b"');
  expect(html).toContain('aria-selected="false" data-tab="a"');
});

test('a nested row hides its hint on a phone and a top-level row does not', () => {
  const hintClass = (nested: boolean) =>
    renderToStaticMarkup(<TimelineRow state="done" name="s" hint="a hint" nested={nested} />).match(
      /<span class="([^"]*)">a hint<\/span>/,
    )?.[1];
  expect(hintClass(true)).toContain('hidden min-[760px]:inline');
  expect(hintClass(false)).not.toContain('hidden');
});

test('a nested row draws its dot clear of its name', () => {
  const html = renderToStaticMarkup(<TimelineRow state="done" name="s" nested />);
  const dotLeft = Number(html.match(/absolute top-3 flex left-\[(\d+)px\]/)?.[1]);
  const textPad = Number(html.match(/pl-(\d+)/)?.[1]) * 4;
  expect(dotLeft + 8).toBeLessThanOrEqual(textPad);
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
    '<i style="color:var(--v3-nope)"></i>',
    '<i class="border border-[color:var(--v3-nope)]"></i>',
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

test('an OptionTile with an href is a link that keeps its recommended mark and data attributes', () => {
  const html = renderToStaticMarkup(
    <OptionTile recommended label="Ship" href="https://console/r/1" data-choice="ship" />,
  );
  expect(html).toMatch(/^<a /);
  expect(html).toContain('href="https://console/r/1"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('data-recommended=""');
  expect(html).toContain('data-choice="ship"');
});

test('a recommended OptionTile paints its consequence in fg-2, a plain one in fg-3', () => {
  const recommended = renderToStaticMarkup(<OptionTile recommended label="A" consequence="x" />);
  const plain = renderToStaticMarkup(<OptionTile label="A" consequence="x" />);
  expect(recommended).toContain('--v3-fg-2');
  expect(recommended).not.toContain('--v3-fg-3');
  expect(plain).toContain('--v3-fg-3');
});

test('a TimelineRow dot sits in a box as tall as the time line, nested or not', () => {
  for (const nested of [false, true]) {
    const html = renderToStaticMarkup(
      <TimelineRow state="done" name="step" time="2m" nested={nested} />,
    );
    expect(html).toMatch(
      /<span class="absolute top-1\.5 flex h-\[1lh\] items-center text-\[length:var\(--v3-t-meta\)\] left-/,
    );
  }
});
