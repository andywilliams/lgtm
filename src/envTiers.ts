/**
 * lgtm's environment surface, declared. Every `LGTM_` variable the code reads is in exactly
 * one of the two lists below, and the line between them is what the variable does to a run:
 *
 *   OPERATOR CONTROL — it tunes how lgtm does its job. Supported, rendered into `--help`
 *                      from this file, and breaking to change.
 *   DEBUGGING HOOK   — it exists only to inspect lgtm itself, and stops it doing its job.
 *                      Not in `--help`; unsupported, and may vanish in any release.
 *
 * A hook is NOT the seam a test should use: a test that sets process state leaks it into
 * whatever runs next, and every one of these branches is reachable by parameter instead.
 *
 * `--help` is RENDERED from `ENV_SURFACE` rather than written out beside it, because the
 * first version of this policy decided tier membership by matching the indentation of a
 * display string — which made reflowing the help text a reclassification.
 */
export type EnvGroup = 'brain' | 'call';

export interface EnvControl {
  readonly name: string;
  readonly group: EnvGroup;
  readonly help: string;
}

export const ENV_SURFACE: readonly EnvControl[] = [
  { name: 'LGTM_BRAIN_CMD', group: 'brain', help: 'command that prints context for a repo (any brain)' },
  { name: 'LGTM_BRAIN_URL', group: 'brain', help: 'a second-brain HTTP API' },
  { name: 'LGTM_BRAIN_DIR', group: 'brain', help: 'a second-brain vault on disk' },
  { name: 'LGTM_MODEL', group: 'call', help: 'model id to review with (default: your ~/.claude/settings.json model)' },
  { name: 'LGTM_EFFORT', group: 'call', help: 'low|medium|high|xhigh|max (default: your settings effort for that model)' },
  { name: 'LGTM_LATE_MODEL', group: 'call', help: 'model for late (round 4+) chill review rounds (default claude-sonnet-5; "off" = always the full model)' },
  { name: 'LGTM_SESSIONS', group: 'call', help: '"off" = every round is a one-off call (default: one Claude session per loop, resumed each round for the prompt cache)' },
  { name: 'LGTM_SIBLING_DIRS', group: 'call', help: 'colon-separated repos to also search for readers of what a diff writes (same as repeating --add-dir)' },
  { name: 'LGTM_TIMEOUT_MS', group: 'call', help: 'how long one model call may take before lgtm gives up and says so (default 15 minutes)' },
  { name: 'LGTM_VERIFY_MODEL', group: 'call', help: 'model for the verifier pass that proves or drops each finding (default claude-sonnet-5; "off" = no verifier pass)' },
  { name: 'LGTM_VERIFY_MAX_BYTES', group: 'call', help: 'cap on the file windows the verifier is shown around each finding (default 60000)' },
  { name: 'LGTM_TICKETS_CMD', group: 'call', help: 'command that prints a ticket given its number (any tracker); the escape hatch' },
  { name: 'LGTM_TICKETS_API', group: 'call', help: 'ticket board API base — with the token below, reviews check the diff against the ticket they name' },
  { name: 'LGTM_TICKETS_TOKEN', group: 'call', help: 'bearer token for that board (DWLF_TICKETS_API / DWLF_TICKETS_TOKEN are also read)' },
  { name: 'LGTM_TICKET_PREFIX', group: 'call', help: 'ref prefix to look for in a PR title or branch (default DWLF, e.g. PROJ-14)' },
  { name: 'LGTM_CLAUDE_SETTING_SOURCES', group: 'call', help: 'set to "user" if your settings.json carries auth/env routing lgtm must keep' },
  { name: 'LGTM_DB_PATH', group: 'call', help: 'where the review log lives (default ~/.lgtm/reviews.db)' },
  { name: 'LGTM_SYSTEM_DIR', group: 'call', help: 'where to look for SYSTEM.md when no charter points at one' },
  // An operator control, not a hook, even though a test was its first caller: it is the
  // default source for the REAL probe's bound, and a repo whose ESLint honestly needs more
  // than 60s over one directory has no other lever.
  { name: 'LGTM_LINT_PROBE_TIMEOUT_MS', group: 'call', help: 'how long `standards init` waits for the target repo\'s ESLint over the fragment (default 60s)' },
];

export const DEBUG_HOOKS: readonly string[] = [
  'LGTM_DUMP_PROMPT', // write the exact prompt to a file and review nothing new (src/ai.ts)
  'LGTM_NO_CALL',     // stop before the model call, after the dump (src/ai.ts)
];

/** The `--help` lines for one group, names padded to a common column. */
export function renderEnvHelp(group: EnvGroup): string {
  const entries = ENV_SURFACE.filter((e) => e.group === group);
  const width = Math.max(...entries.map((e) => e.name.length)) + 3;
  return entries.map((e) => `  ${e.name.padEnd(width)}${e.help}\n`).join('');
}
