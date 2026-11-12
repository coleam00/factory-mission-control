import { afterAll, beforeAll } from 'bun:test';

/** Runs the file's tests in `zone`, then restores the machine zone for later files. */
export function pinZone(zone: string): void {
  const before = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = zone;
  });
  afterAll(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });
}
