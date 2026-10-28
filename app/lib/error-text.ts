/**
 * A step's error as Archon records it can be a whole script failure: the node's name, the source
 * lines around the throw, the thrown message and the stack. The side panel leads with the thrown
 * message and keeps the full text one click away. Pure, no React.
 */

/** A line of quoted source (`16 | const x = 1`), a caret under it, or a stack frame. */
const SOURCE = /^\s*(\d+\s*\||\^|at\s)/;
/** A thrown message as Bun prints it: `error: ...`, inline or on its own line. */
const THROWN = /(?:^|\s)error:\s+(.+?)(?=\s+at\s+\S+\s+\(|\s*$)/gim;

/**
 * The meaningful part of `error`: the last `error: ...` message in it, else its first line that
 * is not quoted source or a stack frame, else its first line. Whether the full text says more.
 */
export function errorHeadline(error: string): { headline: string; more: boolean } {
  const text = error.trim();
  const thrown = [...text.matchAll(THROWN)].at(-1)?.[1]?.trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const headline =
    thrown || lines.find((line) => line !== '' && !SOURCE.test(line)) || lines[0] || text;
  return { headline, more: headline !== text };
}
