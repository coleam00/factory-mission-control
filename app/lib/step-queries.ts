/** The queries the step screen's panels ask for beside the picker's, step-detail first. */
export const STEP_QUERIES = [
  'step-detail',
  'step-nesting',
  'step-prompt',
  'step-subagents',
  'step-scripts',
  'step-yaml',
] as const;

/** The version picker's own query: the one panel that does not take the step's version. */
export const STEP_VERSIONS_QUERY = 'step-versions';

/** Every query the step screen asks for. */
export const ALL_STEP_QUERIES = [STEP_VERSIONS_QUERY, ...STEP_QUERIES] as const;
