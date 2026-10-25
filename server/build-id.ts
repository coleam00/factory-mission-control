/** The candidate the factory is verifying when it names one, otherwise the checked-out commit. */
export function resolveBuildId(env: Record<string, string | undefined>, cwd: string): string {
  const candidate = env.FACTORY_RUNTIME_CANDIDATE;
  if (candidate) return candidate;
  const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd });
  if (git.exitCode !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${git.stderr.toString().trim()}`);
  }
  return git.stdout.toString().trim();
}
