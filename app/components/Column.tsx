import type { ComponentPropsWithoutRef, ReactElement } from 'react';

/** The one place a content column is centered in its pane, whether the Manager is open or closed. */
export const CENTERED = 'mx-auto w-full min-w-0';

/** The app's default column width; a place that needs another passes its own `width`. */
export const APP_WIDTH = 'max-w-6xl';

/** The app's default column with its gutter, for rows inside a page that is not itself a `Column`. */
export const APP_COLUMN = `${CENTERED} ${APP_WIDTH} px-6`;

type ColumnProps = ComponentPropsWithoutRef<'main'> & {
  /** A Tailwind `max-w-*` class. */
  width?: string;
};

/** A place's content column, centered with equal gaps either side of its width. */
export function Column({ width = APP_WIDTH, className = '', ...rest }: ColumnProps): ReactElement {
  return <main {...rest} className={`${CENTERED} ${width} ${className}`.trim()} />;
}
