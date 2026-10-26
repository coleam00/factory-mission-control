import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { TimelineRow } from '../lib/decisions-ledger';
import { NOT_RECORDED } from '../lib/version-strip';
import { Ledger, Timeline } from './DecisionsLedger';

const V1_PIN = '8e3e1cefaf1e1b7955789d6a43a81b6c2dbd7082';
const V1 = `sha256:${'a1'.repeat(32)}`;

const decision = (over: Partial<TimelineRow>): TimelineRow => ({
  date: '2026-09-30',
  title: 'Fence the holdouts',
  decision: 'Holdouts live behind a fence.',
  why: 'A builder that reads them passes them.',
  replaces: 'holdouts outside the repository.',
  version: '8e3e1cef',
  pin_sha: V1_PIN,
  digest: V1,
  ...over,
});

function render(element: React.ReactElement): string {
  const router = createMemoryRouter([{ path: '/', element }]);
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const itemHtml = (html: string, marker: string) =>
  html.split('<li').find((li) => li.includes(marker)) ?? '';

test('a joined decision links to the versions screen by its pin; an unjoined one does not link', () => {
  const html = render(
    <Timeline
      factory="mission-control"
      entries={[
        decision({}),
        decision({
          date: '2026-10-15',
          title: 'Run three laps at once',
          version: 'none',
          pin_sha: null,
          digest: null,
        }),
      ]}
    />,
  );
  const joined = itemHtml(html, 'data-title="Fence the holdouts"');
  expect(joined).toContain(`data-version-link="${V1_PIN}"`);
  expect(joined).toContain(
    `href="/f/mission-control/versions?pin=${V1_PIN}&amp;digest=${encodeURIComponent(V1)}"`,
  );
  expect(joined).toContain('8e3e1cef');
  const unjoined = itemHtml(html, 'data-title="Run three laps at once"');
  expect(unjoined).not.toContain('data-version-link');
  expect(unjoined).not.toContain('<a');
  expect(unjoined).toContain('none, no pin by that prefix');
});

test('different pins have distinct destinations, including an unused pin in another factory', () => {
  const html = render(
    <Timeline
      factory="second factory"
      entries={[
        decision({}),
        decision({ title: 'Unused pin', pin_sha: 'f00dfeed00', digest: null }),
      ]}
    />,
  );
  expect(html).toContain(
    `href="/f/second%20factory/versions?pin=${V1_PIN}&amp;digest=${encodeURIComponent(V1)}"`,
  );
  const pending = itemHtml(html, 'data-title="Unused pin"');
  expect(pending).toContain('href="/f/second%20factory/versions?pin=f00dfeed00"');
  expect(pending).toContain('not yet run');
});

test('the ledger shows waiting laps under being tested and each verdict with its sentence', () => {
  const html = render(
    <Ledger
      testing={[
        { pin: 'b2', reason: 'r', measure: 'over at least 12 laps.', laps: 7, waiting: 5 },
        { pin: 'd4', reason: 'r', measure: 'over 10 laps.', laps: 3, waiting: NOT_RECORDED },
      ]}
      verdicts={[
        { pin: 'a1', reason: 'r', verdict: 'helped', sentence: 'faster.', date: '2026-10-09' },
      ]}
    />,
  );
  const [testing, verdicts] = html.split('data-ledger-group="verdicts"');
  expect(itemHtml(testing, 'data-pin="b2"')).toContain('5 laps waiting');
  expect(itemHtml(testing, 'data-pin="d4"')).toContain(`Laps waiting: ${NOT_RECORDED}`);
  const helped = itemHtml(verdicts, 'data-pin="a1"');
  expect(helped).toContain('data-verdict="helped"');
  expect(helped).toContain('faster.');
  expect(helped).toContain('text-success');
});
