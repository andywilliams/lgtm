import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { PRDetails } from './types.js';
import { getRepoRoot } from './usage.js';

/**
 * Local review mode — source the review from the working tree instead of a GitHub PR.
 *
 * Mirrors the shape of github.ts (diff, changed files, file content, "PR" details) but
 * everything comes from `git` + the local filesystem. This is what lets `lgtm review
 * --local` run in a fix-review loop without pushing to a PR each round: each pass sees the
 * current working tree (committed branch changes + uncommitted edits) against the base.
 *
 * All git invocations use execFileSync with an argv array (no shell), so a `--base` ref or
 * a filename containing shell metacharacters can't be interpreted — it's passed to git as a
 * literal argument. (String-interpolating these into a shell command would be injectable.)
 */

const GIT_OPTS: ExecFileSyncOptionsWithStringEncoding = { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 };

function git(args: string[]): string {
  try {
    return execFileSync('git', args, GIT_OPTS);
  } catch (error: any) {
    throw new Error(`git error: ${error.message}\nCommand: git ${args.join(' ')}`);
  }
}

/**
 * Like git(), but tolerates a non-zero exit that still produced output — notably
 * `git diff --no-index`, which exits 1 whenever the files differ (i.e. always, here).
 */
function gitAllowDiffExit(args: string[]): string {
  try {
    return execFileSync('git', args, GIT_OPTS);
  } catch (error: any) {
    if (typeof error.stdout === 'string' && error.stdout) return error.stdout;
    if (error.stdout) return error.stdout.toString();
    throw new Error(`git error: ${error.message}\nCommand: git ${args.join(' ')}`);
  }
}

function refExists(ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/** New files not yet tracked by git — invisible to `git diff`, so gathered separately. */
function untrackedFiles(): string[] {
  const out = git(['ls-files', '--others', '--exclude-standard']).trim();
  return out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Best-effort detection of the branch this work should be diffed against, when the caller
 * doesn't pass --base. Prefers the remote's default branch, then common integration branches.
 */
export function detectDefaultBase(): string {
  try {
    const sym = execFileSync('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], GIT_OPTS).trim();
    if (sym) return sym.replace('refs/remotes/', ''); // e.g. origin/main
  } catch {
    // no origin/HEAD — fall through to candidates
  }
  for (const candidate of ['origin/develop', 'origin/main', 'origin/master', 'develop', 'main', 'master']) {
    if (refExists(candidate)) return candidate;
  }
  throw new Error('Could not detect a base branch. Pass --base <ref>.');
}

/**
 * The point the current work diverged from base. Diffing the working tree against the
 * merge-base (rather than base's tip) gives PR-like semantics — it ignores commits that
 * landed on base after this branch started.
 */
function mergeBase(base: string): string {
  if (!refExists(base)) {
    throw new Error(`Base ref not found: ${base}. Pass a valid --base <ref>.`);
  }
  try {
    return git(['merge-base', base, 'HEAD']).trim();
  } catch {
    return base;
  }
}

/**
 * Working-tree diff vs the merge-base: committed branch changes + uncommitted edits, plus
 * untracked new files (rendered as additions against /dev/null) so a PR-like review sees
 * newly-created files too.
 */
export function getLocalDiff(base: string): string {
  let diff = git(['diff', mergeBase(base)]);
  for (const file of untrackedFiles()) {
    // --no-index against /dev/null renders the whole file as a new-file addition.
    diff += '\n' + gitAllowDiffExit(['diff', '--no-index', '--', '/dev/null', file]);
  }
  return diff;
}

export function getLocalChangedFiles(base: string): string[] {
  const out = git(['diff', '--name-only', mergeBase(base)]).trim();
  const files = out ? out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  for (const untracked of untrackedFiles()) {
    if (!files.includes(untracked)) files.push(untracked);
  }
  return files;
}

/** Read a changed file from the working tree. Returns null for deleted files. */
export function getLocalFileContent(filePath: string): string | null {
  try {
    const full = join(getRepoRoot(), filePath);
    if (!existsSync(full)) return null;
    return readFileSync(full, 'utf-8');
  } catch {
    return null;
  }
}

/** Synthesise PR-like details from git so the reviewer has a title/body/stats to work with. */
export function getLocalDetails(base: string): PRDetails {
  const mb = mergeBase(base);

  let headRef = 'HEAD';
  try {
    headRef = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'HEAD';
  } catch {
    // detached HEAD or no commits — keep default
  }

  let title = headRef;
  try {
    const subject = git(['log', '-1', '--format=%s']).trim();
    if (subject) title = subject;
  } catch {
    // no commits yet
  }

  let body = '';
  try {
    body = git(['log', '-1', '--format=%b']).trim();
  } catch {
    // ignore
  }

  let author = 'local';
  try {
    author = git(['config', 'user.name']).trim() || 'local';
  } catch {
    // ignore
  }

  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  try {
    const numstat = git(['diff', '--numstat', mb]).trim();
    if (numstat) {
      const lines = numstat.split('\n').filter(Boolean);
      changedFiles = lines.length;
      for (const line of lines) {
        const [a, d] = line.split('\t');
        additions += parseInt(a, 10) || 0; // binary files report '-' → NaN → 0
        deletions += parseInt(d, 10) || 0;
      }
    }
  } catch {
    // ignore — stats are cosmetic
  }

  return { number: 0, title, body, author, baseRef: base, headRef, additions, deletions, changedFiles };
}
