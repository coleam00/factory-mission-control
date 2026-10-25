const CHECK_BRANCH = /^check-[a-z0-9-]+$/;

export function isCheckBranch(name: string): boolean {
  return CHECK_BRANCH.test(name);
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
