import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
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

function tryExec(cmd: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], cwd, maxBuffer: 20 * 1024 * 1024 });
  } catch (e: any) {
    // ESLint exits non-zero when it reports problems — that's success for us.
    return e?.stdout ? String(e.stdout) : '';
  }
}

export function repoRootOf(from: string): string {
  return tryExec('git', ['-C', from, 'rev-parse', '--show-toplevel']).trim() || process.cwd();
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

/** Run ESLint over the targets, using the repo's own config. Best-effort. */
export function runEslint(repoRoot: string, files: string[]): LintFinding[] {
  if (!hasEslintConfig(repoRoot)) return [];
  const raw = tryExec('npx', ['--no-install', 'eslint', '--format', 'json', ...files], repoRoot);
  return raw.trim() ? parseEslintJson(raw) : [];
}

/** Lint findings become "already reported" entries so the model never re-spends a slot on them. */
export function lintAsDecided(findings: LintFinding[]): DecidedFinding[] {
  return findings.map((f) => ({
    file: relative(process.cwd(), f.file) || f.file,
    line: f.line,
    title: `${f.rule}: ${f.message}`,
    reason: 'Already reported deterministically by ESLint — do not spend a finding on it.',
  }));
}

/** Test files that reference the target, so the reviewer can see whether a refactor is covered. */
export function findCoveringTests(repoRoot: string, absPath: string, maxTests = 3): { path: string; content: string }[] {
  const stem = basename(absPath).replace(/\.[jt]sx?$/, '');
  const hits = tryExec('git', ['-C', repoRoot, 'grep', '-l', '-e', stem, '--', '*test*', '*spec*'])
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(0, maxTests);
  const out: { path: string; content: string }[] = [];
  for (const rel of hits) {
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
  let lintFindings: LintFinding[] = [];
  let structural: LintFinding[] = [];
  let other: LintFinding[] = [];
  if (!noLint) {
    if (!hasEslintConfig(repoRoot)) {
      log(chalk.yellow('\n⚠  No ESLint config found — skipping the deterministic pass. Run `lgtm standards init` to emit the rules your standards imply.'));
    } else {
      log(chalk.blue('\n🔧 Running ESLint first (deterministic — nothing here should cost an AI finding)...'));
      lintFindings = runEslint(repoRoot, files);
      ({ structural, other } = partitionStructural(lintFindings));
      log(chalk.gray(`   ${lintFindings.length} lint finding(s): ${structural.length} structural, ${other.length} other`));
      for (const f of structural) {
        log(chalk.yellow(`   ⚠ ${relative(repoRoot, f.file)}:${f.line}  ${f.rule} — ${f.message}`));
      }
    }
  }

  // Structural violations gate the judgement pass: splitting a function invalidates
  // any finding about naming or cohesion inside it.
  if (structural.length > 0 && !skipLintGate) {
    log(chalk.yellow(`\n🛑 ${structural.length} structural lint finding(s) outstanding — stopping before the AI pass.`));
    log(chalk.white('   These change the SHAPE of the code, so judgement findings about it would be stale on arrival.'));
    log(chalk.white('   Fix them, then re-run. To review anyway: --skip-lint-gate'));
    if (agent) {
      console.log(JSON.stringify({
        success: true, mode: 'standards-review', gated: true,
        reason: 'structural lint findings outstanding',
        lint: { structural: structural.length, other: other.length, findings: structural },
        comments: [],
      }));
    }
    return;
  }

  // --- Judgement half ------------------------------------------------------
  const standards = buildStandardsBlock(repoRoot);
  if (standards.path) log(chalk.blue(`\n📏 Standards: ${standards.path}`));
  else log(chalk.yellow('\n⚠  No STANDARDS.md — the review will fall back to generic quality judgement. `lgtm standards init` fixes that.'));
  const charterBlock = (await buildArchitectureContext(repoRoot, basename(repoRoot))).charterBlock;

  const allComments: (ReviewComment & { target: string })[] = [];
  for (const abs of files) {
    const rel = relative(repoRoot, abs);
    const content = readFileSync(abs, 'utf-8');
    const diff = buildWholeFileDiff(repoRoot, abs, content);
    if (diff.length > MAX_DIFF_CHARS) {
      log(chalk.yellow(`\n⊘ ${rel} is too large to review whole (${Math.round(diff.length / 1000)}k chars > ${MAX_DIFF_CHARS / 1000}k). Target a smaller unit within it.`));
      continue;
    }

    // Covering tests are the highest-value context here: without them a refactor
    // finding is unsafe to act on, and the model is told to say so.
    const tests = findCoveringTests(repoRoot, abs);
    const fileContents: Record<string, string> = {};
    for (const t of tests) fileContents[t.path] = t.content;

    log(chalk.blue(`\n🤖 Reviewing ${rel} (${content.split('\n').length} lines${tests.length ? `, ${tests.length} covering test file(s)` : ', NO covering tests found'})...`));

    const fileLint = other.filter((f) => resolve(f.file) === abs);
    const result = await reviewPR(diff, `Standards review: ${rel}`, 'Existing production file under retroactive standards review.', 'medium', ai, tests.length ? fileContents : undefined, '', '', '', {
      standards: standards.block,
      charter: charterBlock,
      retro: true,
      decided: fileLint.length ? lintAsDecided(fileLint) : undefined,
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
      gated: false,
      filesReviewed: files.length,
      standardsDoc: standards.path ?? null,
      lint: { structural: structural.length, other: other.length, suppressed: other.length },
      commentsFound: allComments.length,
      comments: allComments.map((c) => ({ file: c.file, line: c.line, severity: c.severity, title: c.title, body: c.body, suggestion: c.suggestion })),
    }));
    return;
  }

  log(chalk.white('═'.repeat(60)));
  log(chalk.white(`${allComments.length} finding(s) across ${files.length} file(s)`));
  if (other.length > 0) log(chalk.gray(`(${other.length} lint finding(s) were passed through as already-reported, so no AI slot was spent on them)`));
}
