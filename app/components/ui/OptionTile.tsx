import type { HTMLAttributes, ReactNode } from 'react';

/** The tag on the option the Manager recommends. */
export function RecommendedTag({
  children = 'Recommended',
  badge,
  ...rest
}: {
  children?: ReactNode;
  /** A filled badge in the box Decisions' tags had before its v3 screen: uppercase, mono, no left margin. */
  badge?: boolean;
} & Omit<HTMLAttributes<HTMLSpanElement>, 'className'>) {
  return (
    <span
      {...rest}
      className={
        badge
          ? 'shrink-0 rounded bg-[var(--v3-you-wash)] px-1.5 py-px font-mono text-[length:var(--v3-t-micro)] font-semibold tracking-[0.04em] text-[color:var(--v3-you-2)] uppercase'
          : 'ml-1.5 text-[length:var(--v3-t-micro)] font-semibold text-[color:var(--v3-you-2)]'
      }
    >
      {children}
    </span>
  );
}

/** One answer to a question, with what it leads to. */
export function OptionTile({
  label,
  consequence,
  recommended,
  onClick,
}: {
  label: string;
  consequence: string;
  recommended?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-recommended={recommended ? '' : undefined}
      className={`min-w-[150px] cursor-pointer rounded-lg border px-3 py-2 text-left ${
        recommended
          ? 'border-[color:var(--v3-you-line)] bg-[var(--v3-you-wash)]'
          : 'border-[color:var(--v3-line-2)] bg-transparent'
      }`}
    >
      <b className="block text-[length:var(--v3-t-meta)] font-semibold text-[color:var(--v3-fg)]">
        {label}
        {recommended ? <RecommendedTag /> : null}
      </b>
      <span className="block text-[length:var(--v3-t-meta)] text-[color:var(--v3-fg-3)]">
        {consequence}
      </span>
    </button>
  );
}
