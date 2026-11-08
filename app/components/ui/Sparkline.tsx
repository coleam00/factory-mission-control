import { stateColor } from '../../lib/states';

/** Failures per day as thin red bars, scaled to the tallest. */
export function Sparkline({
  counts,
  label = 'Failures per day',
}: {
  counts: readonly number[];
  label?: string;
}) {
  const max = Math.max(0, ...counts);
  return (
    <span
      role="img"
      aria-label={`${label}: ${counts.join(', ')}`}
      className="inline-flex h-5 items-end gap-0.5"
    >
      {counts.map((count, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: days are positional and never reorder
          key={i}
          className="w-[5px] rounded-[1px] opacity-75"
          style={{
            background: stateColor('failed'),
            height: max === 0 ? 0 : `${(count / max) * 100}%`,
          }}
        />
      ))}
    </span>
  );
}
