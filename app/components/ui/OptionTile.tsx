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
          ? 'shrink-0 rounded bg-[var(--v3-you-wash)] px-1.5 py-px font-mono text-[10px] font-semibold tracking-[0.04em] text-[color:var(--v3-you-2)] uppercase'
          : 'ml-1.5 text-[length:var(--v3-t-micro)] font-semibold text-[color:var(--v3-you-2)]'
      }
    >
      {children}
    </span>
  );
}

/** One answer to a question, with what it leads to. With `href` it is a link that opens in a new tab. */
export function OptionTile({
  label,
  consequence,
  recommended,
  onClick,
  href,
  ...data
}: {
  label: string;
  consequence?: string;
  recommended?: boolean;
  onClick?: () => void;
  href?: string;
} & Record<`data-${string}`, string | undefined>) {
  const className = `min-w-[150px] cursor-pointer rounded-lg border px-3 py-2 text-left ${
    recommended
      ? 'border-[color:var(--v3-you-line)] bg-[var(--v3-you-wash)]'
      : 'border-[color:var(--v3-line-2)] bg-transparent'
  }`;
  const body = (
    <>
      <b className="block text-[length:var(--v3-t-meta)] font-semibold text-[color:var(--v3-fg)]">
        {label}
        {recommended ? <RecommendedTag /> : null}
      </b>
      {consequence === undefined ? null : (
        <span
          className={`block text-[length:var(--v3-t-meta)] ${
            recommended ? 'text-[color:var(--v3-fg-2)]' : 'text-[color:var(--v3-fg-3)]'
          }`}
        >
          {consequence}
        </span>
      )}
    </>
  );
  const marks = { ...data, 'data-recommended': recommended ? '' : undefined };
  return href === undefined ? (
    <button type="button" onClick={onClick} {...marks} className={className}>
      {body}
    </button>
  ) : (
    <a href={href} target="_blank" rel="noreferrer" {...marks} className={`block ${className}`}>
      {body}
    </a>
  );
}
