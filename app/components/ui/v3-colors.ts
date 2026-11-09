import { readFileSync } from 'node:fs';

const CSS = readFileSync('app/styles.css', 'utf8');

// The `--color-*` names the theme turns into utilities (`bg-error`, `text-text-primary`).
export const THEME_COLORS = [
  ...(CSS.split('@theme inline')[1] ?? '').matchAll(/--color-([\w-]+):/g),
].map((m) => m[1] ?? '');
// The `--v3-*` names the stylesheet declares; a name outside it renders no color.
export const V3_TOKENS = new Set([...CSS.matchAll(/(--v3-[\w-]+):/g)].map((m) => m[1] ?? ''));
const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';
const COLOR_UTILITY =
  '(?:bg|text|border(?:-[trblxy])?|outline|ring|fill|stroke|decoration|shadow|accent|caret|divide|from|via|to)';

/** The class is a theme or palette color utility, which is not a v3 token. */
export function themeColorClass(cls: string): boolean {
  const theme = new RegExp(`^${COLOR_UTILITY}-(${THEME_COLORS.join('|')})(?:/\\d+)?$`);
  const palette = new RegExp(`^${COLOR_UTILITY}-(?:(?:${PALETTE})-\\d+|black|white)(?:/\\d+)?$`);
  return theme.test(cls) || palette.test(cls);
}

/** The colors in rendered markup that do not come from a `--v3-*` token. */
export function nonV3Colors(html: string): string[] {
  const found: string[] = [];
  const attrs = [...html.matchAll(/\b(?:class|style|fill|stroke)="([^"]*)"/g)].map(
    (m) => m[1] ?? '',
  );
  for (const attr of attrs) {
    for (const m of attr.matchAll(/var\((--[\w-]+)/g))
      if (!V3_TOKENS.has(m[1] ?? '')) found.push(m[0]);
    for (const m of attr.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/gi))
      found.push(m[0]);
    for (const cls of attr.split(/\s+/)) if (themeColorClass(cls)) found.push(cls);
    // A border width with no v3 color falls back to the global `border-border`.
    const classes = attr.split(/\s+/);
    const width = classes.some((c) => /^border(?:-[trblxy])?(?:-\d+)?$/.test(c));
    const colored = classes.some((c) => {
      const token = c.match(/^border-\[color:(?:var\((--[\w-]+)\)|transparent)\]$/);
      return token !== null && (token[1] === undefined || V3_TOKENS.has(token[1]));
    });
    if (width && !colored) found.push(`border without a v3 color: ${attr}`);
  }
  return found;
}
