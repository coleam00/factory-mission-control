// The deployed Function's environment: `function:deploy` writes these names and `index.ts` reads
// them. Node only, like `index.ts`.
export const FUNCTION_ENV = {
  databaseUrl: 'MC_DATABASE_URL',
  webhookSecret: 'GITHUB_WEBHOOK_SECRET',
  githubToken: 'GITHUB_TOKEN',
} as const;
