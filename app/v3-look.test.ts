import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { themeColorClass, V3_TOKENS } from './components/ui/v3-colors';

// The design probe accepts console, v2 and v3 tokens alike, so only the source can show that
// these screens left the v2 colors behind (#520).
const FILES = [
  'components/FactoryMap.tsx',
  'components/MapDetails.tsx',
  'components/FlowToggle.tsx',
  'components/StepVersionPicker.tsx',
  'components/EmptyState.tsx',
  'components/WorkItem.tsx',
  'routes/f.$factory.map.tsx',
  'routes/f.$factory.steps.$workflow.$step.tsx',
];
// v2's card tint amounts: proportions the map keeps, not colors.
const KEPT = new Set(['--card-tint', '--card-border-tint']);

test.each(FILES)('%s draws only from --v3-* tokens', (file) => {
  const source = readFileSync(`app/${file}`, 'utf8');
  const vars = [...source.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1] ?? '');
  expect(vars.filter((name) => !V3_TOKENS.has(name) && !KEPT.has(name))).toEqual([]);
  const classes = source
    .split(/[\s'"`{}]+/)
    .map((token) => token.replace(/^(?:[\w-]+:)+(?!\[)/, ''))
    .filter(themeColorClass);
  expect(classes).toEqual([]);
});
