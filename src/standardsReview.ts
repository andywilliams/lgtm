import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, extname } from 'node:path';
import chalk from 'chalk';
import { reviewPR, type AIProvider } from './review.js';
import { buildStandardsBlock } from './standards.js';
import { buildArchitectureContext } from './charter.js';
import { hasEslintConfig, parseEslintJson, partitionStructural, type LintFinding } from './standardsLint.js';
import type { ReviewComment, DecidedFinding } from './types.js';

/**
 * `lgtm standards review <file|dir>` — the RETROACTIVE altitude.
 *
 * `lgtm review` asks what a change breaks. This asks what existing code costs
 * the next person to touch it — so it runs against a file that isn't changing.
 *
 * Two mechanics make that work without new review machinery:
 *  1. The file is rendered as a synthetic whole-file diff (every line an
 *     addition), which reuses the existing prompt, line anchoring and context
 *     expansion untouched. A retro framing paragraph corrects the register.
 *  2. ESLint runs FIRST. Structural findings (length, complexity, nesting,
 *     params) GATE the review, because a function about to be split makes any
 *     judgement about its internals stale before you read it. Non-structural
 *     findings are passed through as already-reported, so the model never
 *     spends one of its capped slots on something lint already said.
 */

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIR = /(^|\/)(node_modules|dist|build|coverage|\.git|\.next)(\/|$)/;
const MAX_DIFF_CHARS = 50000;

export interface StandardsReviewOptions {
  target: string;
  ai: AIProvider;
  agent: boolean;
  /** Proceed even when structural lint findings are outstanding. */
  skipLintGate: boolean;
  /** Don't run ESLint at all (no gate, no suppression). */
  noLint: boolean;
  maxFiles: number;
}

/**
 * Canonical path key for matching our targets against ESLint's reported paths.
 * `resolve()` alone is not enough: ESLint reports fully-resolved paths, so on a
 * symlinked prefix (macOS `/tmp` → `/private/tmp`) the two spellings of the same
 * file never compare equal and every lint finding silently fails to match its
 * file — losing both the gate and the suppression.
 */
function pathKey(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

function tryExec(cmd: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], cwd, maxBuffer: 20 * 1024 * 1024 });
  } catch (e: any) {
    // ESLint exits non-zero when it reports problems — that's success for us.
    return e?.stdout ? String(e.stdout) : '';
  }
}

/**
 * The git root CONTAINING the target. Throws rather than falling back to cwd:
 * a silent fallback would load the current repo's STANDARDS.md and apply it to
 * unrelated code somewhere else on disk — normative rules attributed to a repo
 * that never adopted them.
 */
export function repoRootOf(from: string): string {
  const root = tryExec('git', ['-C', from, 'rev-parse', '--show-toplevel']).trim();
  if (!root) {
    throw new Error(`${from} is not inside a git repository — standards are per-repo, so there is no document to review against.`);
  }
  return root;
}

/** Expand a target path into the source files to review. */
export function collectTargets(target: string, maxFiles: number): string[] {
  const abs = resolve(target);
  if (!existsSync(abs)) throw new Error(`No such file or directory: ${target}`);
  if (statSync(abs).isFile()) return [abs];

  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= maxFiles) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= maxFiles) return;
      const p = join(dir, entry.name);
      if (SKIP_DIR.test(p)) continue;
      if (entry.isDirectory()) walk(p);
      else if (SOURCE_EXT.has(extname(entry.name)) && !/\.(test|spec)\./.test(entry.name)) found.push(p);
    }
  };
  walk(abs);
  return found.sort();
}

/**
 * Render a file as a unified diff in which every line is an addition. Line
 * numbers therefore match the real file exactly, so findings anchor correctly.
 */
export function buildWholeFileDiff(repoRoot: string, absPath: string, content: string): string {
  const rel = relative(repoRoot, absPath) || basename(absPath);
  const lines = content.split('\n');
  // A trailing newline yields a final empty element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((l) => `+${l}`).join('\n');
  return [
    `diff --git a/${rel} b/${rel}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${rel}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ].join('\n');
}

/**
 * Run ESLint over the targets using the repo's own config. Returns null when
 * there is no config — distinguishing "lint never ran" from "lint ran and found
 * nothing", which matter very differently: in the first case the mechanical
 * quarter of the catalog was never checked at all.
 */
export function runEslint(repoRoot: string, files: string[]): LintFinding[] | null {
  if (!hasEslintConfig(repoRoot)) return null;
  const raw = tryExec('npx', ['--no-install', 'eslint', '--format', 'json', ...files], repoRoot);
  return raw.trim() ? parseEslintJson(raw) : [];
}

/**
 * Lint findings become "already reported" entries so the model never re-spends a
 * slot on them. Paths are made REPO-relative to match the synthetic diff's
 * headers — a cwd-relative path wouldn't line up when run from a subdirectory,
 * and the model would fail to connect the two and re-raise what this suppresses.
 */
export function lintAsDecided(repoRoot: string, findings: LintFinding[]): DecidedFinding[] {
  return findings.map((f) => ({
    file: relative(repoRoot, f.file) || f.file,
    line: f.line,
    title: `${f.rule}: ${f.message}`,
    reason: 'Already reported deterministically by ESLint — do not spend a finding on it.',
  }));
}

/**
 * Test files covering the target. Ranked: a test whose own filename carries the
 * stem first, then whole-word references. The bare-substring search this replaced
 * matched almost every test in the repo for a common stem (`db`, `index`,
 * `utils`) — and since the retro prompt leans on this to judge whether a refactor
 * is safe, a false "covered" reading is worse than finding nothing.
 */
export function findCoveringTests(repoRoot: string, absPath: string, maxTests = 3): { path: string; content: string }[] {
  const stem = basename(absPath).replace(/\.[jt]sx?$/, '');
  if (stem.length < 3) return []; // too generic to attribute coverage from
  // -F (fixed string): a stem is a filename, not a pattern. `foo.bar` would
  // otherwise over-match via `.`, and `a+b` / `x[1]` make git reject the regex
  // outright — which tryExec would swallow into a false "no tests" reading.
  const hits = tryExec('git', ['-C', repoRoot, 'grep', '-l', '-F', '-w', '-e', stem, '--', '*test*', '*spec*'])
    .trim()
    .split('\n')
    .filter(Boolean);
  // A filename match is far stronger evidence than a mention in the body — but it
  // must be the WHOLE stem, not a substring: stem `db` should not treat
  // `olddbcache.test.ts` as its test file, which would throw away the precision
  // `-w` just bought on the content side.
  const namesFile = (p: string): boolean => new RegExp(`(^|[./\\-_])${stem}([./\\-_]|$)`).test(basename(p));
  const ranked = hits.sort((a, b) => Number(namesFile(b)) - Number(namesFile(a)));
  const out: { path: string; content: string }[] = [];
  for (const rel of ranked.slice(0, maxTests)) {
    try {
      const content = readFileSync(join(repoRoot, rel), 'utf-8');
      out.push({ path: rel, content: content.length > 20000 ? content.slice(0, 20000) + '\n// … (truncated)' : content });
    } catch { /* skip unreadable */ }
  }
  return out;
}

function renderFinding(c: ReviewComment, index: number, total: number, log: (...a: any[]) => void): void {
  const colors: Record<string, (s: string) => string> = { BUG: chalk.red, SECURITY: chalk.magenta, SUGGESTION: chalk.yellow, NITPICK: chalk.gray };
  const color = colors[c.severity] ?? chalk.white;
  log(chalk.white('─'.repeat(60)));
  log(chalk.white(`[${index + 1}/${total}] `) + color(c.severity) + chalk.gray(` | ${c.file}:${c.line}`));
  log(chalk.bold(c.title));
  log(chalk.white(c.body));
  if (c.suggestion) {
    log(chalk.green('\nSuggested fix:'));
    log(chalk.gray(c.suggestion));
  }
  log();
}

export async function runStandardsReview(options: StandardsReviewOptions): Promise<void> {
  const { target, ai, agent, skipLintGate, noLint, maxFiles } = options;
  const log = agent ? (..._a: any[]) => {} : console.log;

  const files = collectTargets(target, maxFiles);
  if (files.length === 0) throw new Error(`No reviewable source files under ${target}`);
  const repoRoot = repoRootOf(statSync(resolve(target)).isFile() ? resolve(target, '..') : resolve(target));

  log(chalk.blue(`\n📏 Standards review of ${files.length} file(s) under ${target}`));
  log(chalk.gray('   Retroactive altitude: what does this code cost the next person to change it?'));

  // --- Deterministic half first -------------------------------------------
  let lintRan = false;
  let structural: LintFinding[] = [];
  let other: LintFinding[] = [];
  if (!noLint) {
    log(chalk.blue('\n🔧 Running ESLint first (deterministic — nothing here should cost an AI finding)...'));
    const lintFindings = runEslint(repoRoot, files);
    if (lintFindings === null) {
      log(chalk.yellow('⚠  No ESLint config found — skipping the deterministic pass. Run `lgtm standards init` to emit the rules your standards imply.'));
    } else {
      lintRan = true;
      ({ structural, other } = partitionStructural(lintFindings));
      log(chalk.gray(`   ${lintFindings.length} lint finding(s): ${structural.length} structural, ${other.length} other`));
      for (const f of structural) {
        log(chalk.yellow(`   ⚠ ${relative(repoRoot, f.file)}:${f.line}  ${f.rule} — ${f.message}`));
      }
    }
  }

  // The gate is PER FILE: a structural violation in one file says nothing about
  // the staleness of judgement findings in another, so it must not block them.
  const structuralByFile = new Map<string, LintFinding[]>();
  for (const f of structural) {
    const key = pathKey(f.file);
    structuralByFile.set(key, [...(structuralByFile.get(key) ?? []), f]);
  }
  const gatedFiles: string[] = [];
  const skippedTooLarge: string[] = [];

  // --- Judgement half ------------------------------------------------------
  const standards = buildStandardsBlock(repoRoot);
  if (standards.path) log(chalk.blue(`\n📏 Standards: ${standards.path}`));
  else log(chalk.yellow('\n⚠  No STANDARDS.md — the review will fall back to generic quality judgement. `lgtm standards init` fixes that.'));
  const charterBlock = (await buildArchitectureContext(repoRoot, basename(repoRoot))).charterBlock;

  const allComments: (ReviewComment & { target: string })[] = [];
  for (const abs of files) {
    const rel = relative(repoRoot, abs);

    // Structural findings change the shape of THIS file, so any judgement about
    // its internals would be stale on arrival — skip it, but keep going.
    const fileStructural = structuralByFile.get(pathKey(abs)) ?? [];
    if (fileStructural.length > 0 && !skipLintGate) {
      gatedFiles.push(rel);
      log(chalk.yellow(`\n🛑 ${rel}: ${fileStructural.length} structural lint finding(s) outstanding — skipping the AI pass for this file.`));
      log(chalk.gray('   Fix them and re-run, or pass --skip-lint-gate to review anyway.'));
      continue;
    }

    const content = readFileSync(abs, 'utf-8');
    const diff = buildWholeFileDiff(repoRoot, abs, content);
    // Report the FILE's size, not the padded diff's — a user told "52k > 50k"
    // will measure their file, find 49k, and be rightly confused.
    if (diff.length > MAX_DIFF_CHARS) {
      skippedTooLarge.push(rel);
      log(chalk.yellow(`\n⊘ ${rel} is too large to review whole (${Math.round(content.length / 1000)}k chars; the limit is ~${MAX_DIFF_CHARS / 1000}k once rendered as a diff). Target a smaller unit within it.`));
      continue;
    }

    // Covering tests are the highest-value context here: without them a refactor
    // finding is unsafe to act on, and the model is told to say so.
    const tests = findCoveringTests(repoRoot, abs);
    const fileContents: Record<string, string> = {};
    for (const t of tests) fileContents[t.path] = t.content;

    log(chalk.blue(`\n🤖 Reviewing ${rel} (${content.split('\n').length} lines${tests.length ? `, ${tests.length} covering test file(s)` : ', NO covering tests found'})...`));

    const fileLint = other.filter((f) => pathKey(f.file) === pathKey(abs));
    const result = await reviewPR(diff, `Standards review: ${rel}`, 'Existing production file under retroactive standards review.', 'medium', ai, tests.length ? fileContents : undefined, '', '', '', {
      standards: standards.block,
      charter: charterBlock,
      retro: true,
      decided: fileLint.length ? lintAsDecided(repoRoot, fileLint) : undefined,
    });

    for (const c of result.comments) allComments.push({ ...c, target: rel });
    if (!agent) {
      log(chalk.gray(`\n${result.summary}\n`));
      result.comments.forEach((c, i) => renderFinding(c, i, result.comments.length, log));
      if (result.comments.length === 0) log(chalk.green('✓ No standards findings for this file.'));
    }
  }

  if (agent) {
    console.log(JSON.stringify({
      success: true,
      mode: 'standards-review',
      filesTargeted: files.length,
      // Every target is accounted for: a file skipped for size must not read as
      // "reviewed, no findings" — that's the same class of ambiguity as lint.ran.
      filesReviewed: files.length - gatedFiles.length - skippedTooLarge.length,
      gatedFiles,
      skippedTooLarge,
      standardsDoc: standards.path ?? null,
      // Three distinct states, not two: the mechanical quarter can be checked,
      // deliberately skipped, or silently unavailable — and a consumer weighing
      // how much to trust these findings needs to tell those apart.
      lint: {
        ran: lintRan,
        status: noLint ? 'skipped-by-flag' : lintRan ? 'ran' : 'no-eslint-config',
        structural: structural.length,
        other: other.length,
        suppressed: other.length,
      },
      commentsFound: allComments.length,
      comments: allComments.map((c) => ({ file: c.file, line: c.line, severity: c.severity, title: c.title, body: c.body, suggestion: c.suggestion })),
    }));
    return;
  }

  log(chalk.white('═'.repeat(60)));
  log(chalk.white(`${allComments.length} finding(s) across ${files.length - gatedFiles.length - skippedTooLarge.length} reviewed file(s)`));
  if (gatedFiles.length > 0) log(chalk.yellow(`${gatedFiles.length} file(s) skipped pending structural lint fixes: ${gatedFiles.join(', ')}`));
  if (skippedTooLarge.length > 0) log(chalk.yellow(`${skippedTooLarge.length} file(s) skipped as too large: ${skippedTooLarge.join(', ')}`));
  if (!lintRan && !noLint) log(chalk.yellow('⚠  ESLint never ran — the mechanical standards were not checked at all.'));
  if (other.length > 0) log(chalk.gray(`(${other.length} lint finding(s) were passed through as already-reported, so no AI slot was spent on them)`));
}
