/** Formatting helpers for the console. Pure functions, no React. */

export function shortRunId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

/** H:MM:SS, with a day prefix past a day. Tabular numerals recommended at call site. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const time = `${h}:${pad(m)}:${pad(sec)}`;
  return days > 0 ? `${days}d ${time}` : time;
}

/**
 * DB timestamps (SQLite `datetime('now')`, Postgres `TIMESTAMP`) reach the
 * console as naive strings ("2026-06-13 23:22:53") that are UTC wall-clock,
 * but `new Date()` parses suffix-less strings as browser-LOCAL time — shifting
 * every derived value by the viewer's UTC offset. Tag naive strings as UTC
 * (swapping the space separator for 'T' so stricter parsers accept them);
 * strings already carrying 'Z' or a numeric offset (live SSE values,
 * Date-serialized Postgres rows) pass through untouched — no double shift.
 */
export function ensureUtc(timestamp: string): string {
  return /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(timestamp)
    ? timestamp
    : `${timestamp.replace(' ', 'T')}Z`;
}

/** UTC epoch ms for a timestamp, tolerant of naive DB strings (see ensureUtc). */
function toUtcMs(timestamp: string): number {
  return new Date(ensureUtc(timestamp)).getTime();
}

export function elapsedSince(startIso: string, endIso?: string): number {
  const start = toUtcMs(startIso);
  const end = endIso !== undefined ? toUtcMs(endIso) : Date.now();
  return (end - start) / 1000;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = toUtcMs(iso);
  const d = Math.floor((now - t) / 1000);
  if (d < 5) return 'just now';
  if (d < 60) return `${d.toString()}s ago`;
  if (d < 3600) return `${Math.floor(d / 60).toString()}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600).toString()}h ago`;
  return `${Math.floor(d / 86400).toString()}d ago`;
}

/**
 * Offset from a run's start, e.g. `+04:12`. When watching a run this is far
 * more useful than a wall-clock timestamp — and it sidesteps timezone drift.
 * Falls back to wall-clock HH:MM:SS if the baseline is invalid.
 */
export function formatRelativeToBaseline(eventIso: string, baselineIso: string | null): string {
  if (baselineIso === null) return formatClock(eventIso);
  const base = toUtcMs(baselineIso);
  const t = toUtcMs(eventIso);
  if (Number.isNaN(base) || Number.isNaN(t)) return formatClock(eventIso);
  const delta = Math.max(0, Math.floor((t - base) / 1000));
  const h = Math.floor(delta / 3600);
  const m = Math.floor((delta % 3600) / 60);
  const s = delta % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return h > 0 ? `+${pad(h)}:${pad(m)}:${pad(s)}` : `+${pad(m)}:${pad(s)}`;
}

export function formatClock(iso: string): string {
  const d = new Date(ensureUtc(iso));
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * USD cost with at least two decimals, trimming only extra trailing zeros.
 * Keep the sub-dollar precision (3 decimals, or 4 below a cent) so cheap
 * runs stay visible.
 */
export function formatCost(usd: number): string {
  const decimals = usd >= 1 ? 2 : usd >= 0.01 ? 3 : 4;
  return `$${usd.toFixed(decimals).replace(/(\.\d{2}\d*?)0+$/, '$1')}`;
}

/** A plain number, without trailing zeros: `3`, `1.5`, `0.2667`. Its caller owns the rounding. */
export function formatNumber(n: number): string {
  return String(n);
}

/** A number rounded to `digits` decimals and kept at that width: `3.0`, `92.9`. */
export function formatFixed(n: number, digits: number): string {
  return n.toFixed(digits);
}

/** A whole count with thousands separators: `12,345`. */
export function formatCount(n: number | string): string {
  return Number(n).toLocaleString('en-US');
}

/** A change, written by `format` with its sign in front: `+1`, `0`, `-$3.10`. */
export function formatSigned(n: number, format: (size: number) => string): string {
  const size = format(Math.abs(n));
  return n > 0 ? `+${size}` : n < 0 ? `-${size}` : size;
}

/**
 * Compact project subtitle. Prefer the local filesystem path because it's
 * what the user actually navigates to (and what worktrees / artifacts hang
 * off), and because after a rename the owner/repo derivation often reads as
 * a duplicate of the original name. `/Users/<name>/` and `/home/<name>/`
 * are shortened to `~/` for readability.
 */
export function formatProjectLocator(project: {
  repositoryUrl: string | null;
  path: string;
}): string {
  if (project.path.length > 0) {
    return project.path.replace(/^\/(?:Users|home)\/[^/]+\//, '~/');
  }
  if (project.repositoryUrl !== null && project.repositoryUrl.length > 0) {
    const m = /[/:]([^/:]+\/[^/:]+?)(?:\.git)?$/.exec(project.repositoryUrl);
    if (m !== null) return m[1];
    return project.repositoryUrl;
  }
  return '';
}

const pad2 = (n: number): string => n.toString().padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** HH:MM in the viewer's time zone; empty when there is no time. */
export function clock(at: string | Date | null | undefined): string {
  if (at === null || at === undefined) return '';
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** YYYY-MM-DD, the calendar day in the viewer's time zone. */
export function localDay(at: Date): string {
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/** The instant the viewer's local day containing `now` began, as an ISO string. */
export function localDayStart(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** `Thu 07:29`: the weekday and time in the viewer's time zone. */
export function weekdayClock(at: Date): string {
  return `${WEEKDAYS[at.getDay()]} ${clock(at)}`;
}

/** `2026-10-25 09:07`: the local day and time in the viewer's time zone. */
export function localMinute(at: Date): string {
  return `${localDay(at)} ${clock(at)}`;
}

/** `2026-10-24 10:00:30`: the local day and time to the second in the viewer's time zone. */
export function localSecond(at: Date): string {
  return `${localDay(at)} ${formatClock(at.toISOString())}`;
}
