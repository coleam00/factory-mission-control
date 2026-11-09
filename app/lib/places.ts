/** A place in the left nav: its path after `/f/:factory` ('' is the factory's home) and its name. */
export interface Place {
  path: PlacePath;
  label: string;
}

/** The nav's fixed places (v3 README "The places"): not one entry per route file. */
export const PLACES = [
  { path: '', label: 'Attention' },
  { path: 'map', label: 'Factory' },
  { path: 'board', label: 'Board' },
  { path: 'runs', label: 'Runs' },
] as const satisfies readonly { path: string; label: string }[];

/** A place's path after `/f/:factory`: '' is Attention. */
export type PlacePath = (typeof PLACES)[number]['path'];

/** The address of the place at `path` for `factory`: the one writer of a place's segment. */
/** The app root, which the home redirect serves. */
export const ROOT_ADDRESS = '/';

export const placeAddress = (factory: string, path: PlacePath): string =>
  `/f/${encodeURIComponent(factory)}${path === '' ? '' : `/${path}`}`;
