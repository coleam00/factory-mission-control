const CHECK_BRANCH = /^check-[a-z0-9-]+$/;
const REWIND_BRANCH = /^rewind-[a-z0-9-]+$/;

export function isCheckBranch(name: string): boolean {
  return CHECK_BRANCH.test(name);
}

/** A branch `bun run rewind:create` makes: a past moment of another branch, served read-only. */
export function isRewindBranch(name: string): boolean {
  return REWIND_BRANCH.test(name);
}

export class RefusedBranch extends Error {
  constructor(name: string, reason = 'only check-* branches') {
    super(`refusing branch '${name}': ${reason}`);
    this.name = 'RefusedBranch';
  }
}

/** Every write path calls this before its first mutating API call or SQL statement. */
export function requireCheckBranch(name: string): void {
  if (!isCheckBranch(name)) throw new RefusedBranch(name);
}

/** The rewind paths call this before their first Neon API call on the branch. */
export function requireRewindBranch(name: string): void {
  if (!isRewindBranch(name)) throw new RefusedBranch(name, 'only rewind-* branches');
}
