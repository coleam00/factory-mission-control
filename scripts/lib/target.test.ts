import { expect, test } from 'bun:test';
import { endpointIdOf } from './target';

test('endpointIdOf reads direct and pooled Neon hosts', () => {
  expect(endpointIdOf('postgresql://u:p@ep-cool-sun-a1b2c3.us-east-2.aws.neon.tech/db')).toBe(
    'ep-cool-sun-a1b2c3',
  );
  expect(
    endpointIdOf('postgresql://u:p@ep-cool-sun-a1b2c3-pooler.c-2.us-east-2.aws.neon.tech/db'),
  ).toBe('ep-cool-sun-a1b2c3');
});

test('endpointIdOf is null for anything that is not a Neon endpoint', () => {
  expect(endpointIdOf('postgresql://u:p@localhost:5432/db')).toBeNull();
  expect(endpointIdOf('postgresql://u:p@ep-x.neon.tech.evil.example/db')).toBeNull();
  expect(endpointIdOf('not a url')).toBeNull();
});
