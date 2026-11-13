import { useEffect, useState } from 'react';
import { msToNextHour } from '../lib/failures';

/** The browser's clock, moved on at each whole UTC hour, when the failure cutoff (`failuresSince`) moves. */
export function useHour(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setTimeout(() => setNow(new Date()), msToNextHour(now));
    return () => clearTimeout(timer);
  }, [now]);
  return now;
}
