import { useEffect, useState } from 'react';
import { localMidnight } from '../lib/format';

/** Milliseconds from `now` to the next local midnight, when "today" changes. */
export const msToLocalMidnight = (now: Date): number =>
  Date.parse(localMidnight(now, 1)) - now.getTime();

/** The browser's clock, moved on at each local midnight so "today" never keeps yesterday. */
export function useToday(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), msToLocalMidnight(now));
    return () => clearTimeout(timer);
  }, [now]);
  return now;
}
