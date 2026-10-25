/** A value for a jsonb column, as opposed to a text[] one. */
export type Json = { json: unknown };

export type Literal = null | string | number | readonly string[] | Json;

export type SqlRow = Record<string, Literal>;

export const json = (value: unknown): Json => ({ json: value });

const quote = (text: string) => `'${text.replaceAll('\r\n', '\n').replaceAll("'", "''")}'`;

/** A SQL literal for `value`, for a session with standard_conforming_strings on (the default). */
export function lit(value: Literal): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return quote(value);
  if ('json' in value) return `${quote(JSON.stringify(value.json))}::jsonb`;
  return value.length === 0 ? `'{}'::text[]` : `ARRAY[${value.map(quote).join(', ')}]::text[]`;
}

export function insert(table: string, row: SqlRow): string {
  const columns = Object.keys(row);
  const values = columns.map((column) => lit(row[column] ?? null));
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')});`;
}
