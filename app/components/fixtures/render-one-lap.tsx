import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { CheckLineRow, OneLapRow } from '../../lib/one-lap';
import { OneLap } from '../OneLap';
import { delivered, type PanelState } from './delivered-panel';

const RUN = '5eed0001-0000-4000-8000-000000000001';

const lap: OneLapRow = {
  run_id: RUN,
  status: 'completed',
  started_at: new Date('2026-10-01T14:00:00Z'),
  completed_at: new Date('2026-10-01T15:00:00Z'),
  repository: 'coleam00/factory-mission-control',
  console: 'http://localhost:3090',
  issue_number: 2,
  issue_title: 'The lanes panel lists one lap twice',
  issue_url: null,
  route: 'simple',
  depth: 'normal',
  pr: '#102',
  review_status: 'completed',
  review_outcome: 'sent-back',
  review_delivers: 'part',
  dispositions: [
    { line: 'H2', action: 'blocks' },
    { line: 'H9', action: 'issue' },
  ],
  gate_status: null,
  gate_outcome: null,
  gate_reason: null,
};

const lines: CheckLineRow[] = [
  {
    position: 1,
    line_id: 'C1',
    kind: 'criterion',
    verdict: 'PASS',
    evidence_count: 1,
    scenario_id: null,
  },
  {
    position: 4,
    line_id: 'H2',
    kind: 'holdout',
    verdict: 'FAIL',
    evidence_count: 1,
    scenario_id: 'H-02',
  },
];

const attrs = (selector: string, names: readonly string[]) =>
  [...document.querySelectorAll(selector)].map((el) =>
    Object.fromEntries(names.map((name) => [name, el.getAttribute(name)])),
  );

/**
 * The lap page with its app check delivered in `checks`: each disposition as the review card
 * draws it, and each line as the APP CHECK panel draws it.
 */
export async function renderOneLap(checks: PanelState) {
  delivered['one-lap'] = { rows: [lap], state: 'ready' };
  delivered['one-lap-checks'] = { rows: lines, state: checks };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    const router = createMemoryRouter([{ path: '/', element: <OneLap factory="f" runId={RUN} /> }]);
    root.render(<RouterProvider router={router} />);
    // The app check's rows reach the review card one effect after the panel draws them; a
    // card that never marks its dispositions is read once the wait is over.
    const marked = '[data-disposition][data-check-position], [data-disposition][data-unmatched]';
    for (let waited = 0; waited < 1000 && !document.querySelector(marked); waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      dispositions: attrs('[data-disposition]', [
        'data-line',
        'data-check-position',
        'data-unmatched',
      ]),
      lines: attrs('[data-live="one-lap-checks"] [data-check-line]', [
        'data-line-id',
        'data-position',
      ]),
    };
  } finally {
    root.unmount();
    container.remove();
  }
}
