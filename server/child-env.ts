/** The part of the dashboard's environment a child CLI may inherit: where to find programs and a home, never a credential. */
export const BASE_ENV_NAMES = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
];

export function pick(env: NodeJS.ProcessEnv, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}
