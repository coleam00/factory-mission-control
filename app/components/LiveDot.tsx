import type { ReactElement } from 'react';
import { stateColor } from '../lib/states';

/**
 * Broadcast-style "live" indicator for running runs. Solid inner dot with a
 * pulsing ring that radiates outward (Tailwind's `animate-ping`). Read as
 * "something is happening right now" without being noisy.
 */
export function LiveDot({ size = 10 }: { size?: number }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <span
        className="absolute inset-0 animate-ping rounded-full opacity-60"
        style={{ background: stateColor('running') }}
      />
      <span
        className="relative rounded-full"
        style={{ width: size * 0.65, height: size * 0.65, background: stateColor('running') }}
      />
    </span>
  );
}
