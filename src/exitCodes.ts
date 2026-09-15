/**
 * lgtm's exit vocabulary above 1, in one file so the next command that needs a code can see
 * what is taken without reading every command module.
 *
 * The rule the codes follow: **a non-zero code above 1 reports on the result, not on lgtm.**
 * `1` means lgtm failed and did not do the thing. Anything higher means lgtm DID the thing
 * and is telling you something about what it produced that you now have to act on — the
 * file it wrote breaks your lint (3), or was never checked by it (4). Whether the cause
 * was the repo's or the environment's is the report's business; the code carries the
 * action. That distinction is what a scripted caller needs and what prose in stdout cannot
 * give it.
 */

/**
 * lgtm could not do what was asked. Nothing was written, nothing was posted.
 *
 * ⚠️ Documented here, not yet enforced from here: the other command modules still exit with
 * a literal `1`. This file governs the codes above 1 and describes the one below them, which
 * is a weaker claim than "lgtm's exit codes live here" — worth knowing before trusting it as
 * a complete inventory.
 */
export const FAILED = 1;

/**
 * `standards init` wrote the fragment, and this repo's `eslint .` does not pass.
 *
 * ⚠️ A report on the repo's state, NOT a claim that lgtm broke it. The probe can tell the
 * two apart — `namesFragment` says whether the failure names the file just written — and
 * the printed report hedges accordingly, but the exit code deliberately does not: a caller
 * asking "can I commit this?" gets the same answer either way, and a code that meant only
 * "we broke it" would return 0 to someone whose pre-commit hook is about to fail.
 *
 * Frozen once anything keys on it: it cannot later widen to cover `problems` (the fragment
 * lints with findings, which is not a failing lint) or narrow to `namesFragment === true`
 * without breaking callers that cannot be enumerated *(DWLF-228)*.
 */
export const STANDARDS_INIT_LINT_FAILS = 3;

/**
 * `standards init` wrote the fragment into the repo, and lgtm TRIED to run this repo's ESLint
 * over it and could not — there was no local binary, ESLint timed out, or it could not be
 * spawned.
 *
 * Distinct from 0 because the caller this command has is an agent following a skill, and
 * "written, and this repo's ESLint passed it" and "written, and nothing checked it" are
 * different instructions to that agent: the second means run the lint yourself before you
 * commit. Distinct from 3 because nothing is known to be broken. NOT used where that
 * instruction has nothing to attach to: no ESLint configured, `--no-eslint`, or a preview
 * `--out` outside the repo (the operator's own choice, with nothing to commit) — those stay
 * 0. The exit code carries the ACTION; which of the three it was, and the remedy, is the
 * printed report's job *(DWLF-238)*.
 */
export const STANDARDS_INIT_LINT_UNCHECKED = 4;
