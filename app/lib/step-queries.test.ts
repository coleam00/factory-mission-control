import { expect, test } from 'bun:test';
import { ALL_STEP_QUERIES } from './step-queries';

test('the step screen mounts a panel for exactly the queries the list names', async () => {
  const mounted = new Set<string>();
  for (const file of [
    '../routes/steps.$workflow.$step.tsx',
    '../components/StepVersionPicker.tsx',
  ]) {
    const source = await Bun.file(new URL(file, import.meta.url)).text();
    for (const [, query] of source.matchAll(/\bquery="([^"]+)"/g)) mounted.add(query as string);
  }
  expect([...mounted].sort()).toEqual([...ALL_STEP_QUERIES].sort());
});
