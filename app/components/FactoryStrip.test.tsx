import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FactoryStripBody } from './FactoryStrip';

const FACTORY = 'coleam00/factory-mission-control';

test('in error the strip keeps the factory name and replaces only the count', () => {
  const html = renderToStaticMarkup(
    <FactoryStripBody factory={FACTORY} rows={undefined} state="error" />,
  );
  expect(html).toContain(FACTORY);
  expect(html).toContain('Live data is unavailable.');
  expect(html).not.toContain('data-count');
  expect(html).not.toContain('Running laps');
});

test('while loading the strip keeps the factory name and shows a dash for the count', () => {
  const html = renderToStaticMarkup(
    <FactoryStripBody factory={FACTORY} rows={undefined} state="loading" />,
  );
  expect(html).toContain(FACTORY);
  expect(html).toContain('Running laps');
  expect(html).toContain('>-<');
  expect(html).not.toContain('Live data is unavailable.');
});

test('when ready the strip shows the factory name and the running count', () => {
  const html = renderToStaticMarkup(
    <FactoryStripBody factory={FACTORY} rows={[{ running: 2 }]} state="ready" />,
  );
  expect(html).toContain(FACTORY);
  expect(html).toContain('data-count="2"');
});

test('an unknown key is shown as typed and marked unknown, with no count and no outage', () => {
  const html = renderToStaticMarkup(
    <FactoryStripBody factory=" mission-control" rows={undefined} state="loading" unknown />,
  );
  expect(html).toContain('> mission-control<');
  expect(html).toContain('Unknown factory');
  expect(html).not.toContain('Running laps');
  expect(html).not.toContain('data-count');
  expect(html).not.toContain('Live data is unavailable.');
});
