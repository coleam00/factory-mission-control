import { useCallback, useState } from 'react';

/**
 * How many waves are open: the first always, and each next one once every panel of the wave
 * before it has settled (its first snapshot arrived, or it failed).
 */
export function openWaves(
  waves: readonly (readonly string[])[],
  settled: ReadonlySet<string>,
): number {
  let open = 1;
  while (open < waves.length && (waves[open - 1] ?? []).every((query) => settled.has(query))) {
    open++;
  }
  return open;
}

/**
 * Opens a screen's panels a wave at a time. The Realtime service answers several first snapshots
 * on one socket slowly and unevenly: six at once put the slowest past 500 ms, two at a time stay
 * near 150 ms (#103).
 */
export function useWaves(waves: readonly (readonly string[])[]): {
  enabled: (query: string) => boolean;
  settle: (query: string) => void;
} {
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const open = openWaves(waves, settled);
  const settle = useCallback(
    (query: string) =>
      setSettled((before) => (before.has(query) ? before : new Set(before).add(query))),
    [],
  );
  return {
    enabled: (query) => waves.findIndex((wave) => wave.includes(query)) < open,
    settle,
  };
}
