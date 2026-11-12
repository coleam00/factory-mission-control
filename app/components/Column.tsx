import type { ComponentPropsWithoutRef, ReactElement } from 'react';

/** The one place a content column is centered in its pane, whether the Manager is open or closed. */
export const CENTERED = 'mx-auto w-full min-w-0';

/** The app's default column width; a place that needs another passes its own `width`. */
export const APP_WIDTH = 'max-w-6xl';

type ColumnProps = ComponentPropsWithoutRef<'main'> & {
  /** A Tailwind `max-w-*` class. */
  width?: string;
  as?: 'main' | 'div';
};

/** A place's content column, centered with equal gaps either side of its width. */
export function Column({
  width = APP_WIDTH,
  as: Tag = 'main',
  className = '',
  ...rest
}: ColumnProps): ReactElement {
  return <Tag {...rest} className={`${CENTERED} ${width} ${className}`.trim()} />;
}
