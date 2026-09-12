import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import prompts from 'prompts';
import chalk from 'chalk';
import { STANDARDS_INIT_LINT_FAILS } from './exitCodes.js';
import { askEntries, F1_MAX_POSITIONAL_ARGS, type RepoProfile, type RequiredTooling } from './standardsCatalog.js';
import { DEFAULT_THRESHOLDS, clampThresholds, generateStandardsDoc, thresholdsConsumed, type StandardsSelections, type StandardsThresholds } from './standards.js';
import { generateEslintFragment, usesEsm, deriveRules, hasEslintConfig } from './standardsLint.js';

/**
 * `lgtm standards init` — produce the repo's STANDARDS.md from the catalog.
 *
 * Deliberately AI-FREE: the catalog is the distillation, the questions are fixed
 * (the repo profile + the five genuinely contested toggles + thresholds + house
 * rules), and the document is generated deterministically — so a re-run with the
 * same answers yields the same doc. The repo SCAN runs first so every threshold
 * question is asked against measured reality ("your p95 is 74 — propose 80?")
 * and every adoption states its existing-violation cost.
 *
 * The scan is heuristic (regex + brace counting, not a parser) and says so; it
 * informs proposals, it never blocks or decides.
 */

export interface StandardsInitOptions {
  out?: string;
  force?: boolean;
  /** Skip emitting the derived ESLint fragment. */
  noEslint?: boolean;
  /** Severity for the emitted mechanical rules (default 'warn' — see the fragment header). */
  severity?: 'warn' | 'error';
  /** JSON file with an array of pre-supplied answers (scripted runs). */
  answers?: string;
  /** Accept every recommendation non-interactively (scan-informed thresholds, default stances). */
  yes?: boolean;
  /** Skip the profile question. */
  profile?: string;
}

// --- Repo scan ---------------------------------------------------------------

export interface RepoScan {
  fileCount: number;
  fileLines: Stats;
  fnLines: Stats;
  /** Tooling actually found in the repo — standards presuming what's absent render as aspirational. */
  toolingPresent: Set<RequiredTooling>;
  /** Count of functions/files exceeding the would-be thresholds, for the violation-cost line. */
  fnOver: (n: number) => number;
  filesOver: (n: number) => number;
  maxPositionalArgs: number;
  profileGuess: RepoProfile;
  profileEvidence: string;
  summary: string;
}

export interface Stats {
  p50: number;
  p95: number;
  max: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted[sorted.length - 1] ?? 0 };
}

/** How long the target repo's own ESLint may take over one file before we stop waiting. */
const LINT_PROBE_TIMEOUT_MS = 60_000;
/**
 * How long the probe may wait for the target repo's ESLint.
 *
 * A parameter with an env default — the shape `verifyMaxContextBytes` uses next door — so a
 * test reaches the timeout branch by passing 300 rather than by mutating process.env and
 * remembering to put it back.
 */
export function lintProbeTimeoutMs(raw = process.env.LGTM_LINT_PROBE_TIMEOUT_MS): number {
  const n = Number(raw?.trim());
  return Number.isFinite(n) && n > 0 ? n : LINT_PROBE_TIMEOUT_MS;
}

/**
 * Why the probe reached no verdict. A field rather than a sentence because TWO of these —
 * `no-eslint` and `no-fragment` — mean there is nothing here to break, and the other four
 * mean we could not find out. The report may say the reassuring thing only for the first
 * two, and keying that on prose put a rewordable sentence between the reader and the truth.
 */
export type FragmentSkipKind =
  /** This repo configures no ESLint, so the fragment has nothing to run in yet. */
  | 'no-eslint'
  /** ESLint is configured but there is no local binary to run (Yarn PnP, workspace package). */
  | 'no-binary'
  /** A preview run wrote the fragment outside the repo, so its ESLint was never the subject. */
  | 'outside-repo'
  /** ESLint did not finish in time. */
  | 'timeout'
  /** ESLint could not be spawned at all. */
  | 'spawn-failed'
  /** No fragment was written, so there is nothing to have broken (`--no-eslint`). */
  | 'no-fragment';

/**
 * What the target repo's ESLint made of the directory we just wrote the fragment into.
 *  - `ok`        — it lints clean; nothing to say.
 *  - `problems`  — it reported lint findings (exit 1). `eslint .` goes red, which the
 *                  operator wants to know. `namesFragment` says whether the output points
 *                  at our file or at a neighbour in the same directory.
 *  - `broken`    — ESLint could not lint at all (exit ≥ 2). The case this check exists for:
 *                  a typed config applies typed rules to a `.js` file in no tsconfig project,
 *                  every rule throws, and `eslint .` takes the whole lint down. `namesFragment`
 *                  false means their lint fails for a reason that may predate this file.
 *  - `skipped`   — no verdict was reached; `kind` says why and what follows from it. Most
 *                  kinds leave the question open, and saying otherwise is the reassurance
 *                  this check exists to stop.
 */
export type FragmentLintResult =
  | { status: 'ok' }
  | { status: 'skipped'; kind: FragmentSkipKind; reason: string }
  /** `namesFragment` false ⇒ the output points at something else in the directory, or nowhere. */
  | { status: 'problems' | 'broken'; detail: string; namesFragment: boolean };

/**
 * The exit code for a completed `standards init`, given what the lint probe concluded.
 *
 * `broken` is the only non-zero case, and it reports the repo's STATE — this lint does not
 * pass — rather than claiming lgtm caused it. `namesFragment` distinguishes those two in the
 * printed report and deliberately does not change the code: someone asking "can I commit
 * this?" needs the same answer either way, and a code meaning only "we broke it" would
 * return 0 to a caller whose pre-commit hook is about to fail.
 *
 * `problems` and `skipped` stay 0. `problems` means the fragment lints with findings, which
 * is a repo with findings rather than a failing lint. `skipped` means no verdict was reached
 * — ESLint absent, a preview run, a timeout — and "I could not tell" is not grounds for
 * failing a caller who asked for a file to be written.
 */
export const exitCodeForStandardsInit = (lint: FragmentLintResult): number => {
  // Exhaustive on purpose, the same way describeFragmentLint is. `broken ? 3 : 0` would
  // compile for a verdict added to FragmentLintResult later and report it as success —
  // a result the caller has to act on, delivered as exit 0, which is this whole ticket.
  switch (lint.status) {
    case 'broken': return STANDARDS_INIT_LINT_FAILS;
    case 'ok':
    case 'problems':
    case 'skipped': return 0;
    default: {
      const unhandled: never = lint;
      throw new Error(`unhandled lint verdict: ${JSON.stringify(unhandled)}`);
    }
  }
};

/**
 * Lint the generated fragment with the TARGET repo's own ESLint, because that is the only
 * thing that knows whether the file we just added breaks its build.
 *
 * This exists because it happened: `standards init` wrote `.lgtm/standards.eslint.js` into a
 * repo linting with `recommendedTypeChecked`, every typed rule threw on a file belonging to
 * no tsconfig project, and the pre-commit hook killed the commit with a stack trace. A
 * generator that writes a file into someone else's repo owns whether that file passes their
 * build — and finding out costs one bounded subprocess.
 */
export function checkFragmentLints(repoRoot: string, fragmentPath: string, timeoutMs = lintProbeTimeoutMs()): FragmentLintResult {
  // A preview run (`--out /tmp/draft/STANDARDS.md`) puts the fragment outside the repo
  // entirely. Linting it with the repo's cwd would answer a question about a file that is
  // not in the repo — most likely "ok", because it sits outside the config's base directory,
  // which is a clean bill of health for a file nothing looked at.
  const rel = relative(repoRoot, dirname(fragmentPath));
  if (rel.startsWith('..') || isAbsolute(rel)) return { status: 'skipped', kind: 'outside-repo', reason: 'the fragment was written outside this repo (preview run)' };
  const bin = join(repoRoot, 'node_modules', '.bin', 'eslint');
  if (!existsSync(bin)) {
    // "I could not find a local binary" is not "this repo has no ESLint": Yarn PnP has no
    // node_modules at all, and in a workspace ESLint may live in a package below the git
    // root. Saying "nothing to break" there would be the exact wrong reassurance.
    return hasEslintConfig(repoRoot)
      ? { status: 'skipped', kind: 'no-binary', reason: 'ESLint is configured here but there is no local binary to run it with (Yarn PnP, or a workspace package) — check it yourself' }
      : { status: 'skipped', kind: 'no-eslint', reason: 'no ESLint configured in this repo' };
  }
  // Lint the fragment's DIRECTORY, not the file. Naming a file explicitly makes ESLint lint
  // it even when the config ignores it — which would report `broken` forever in a repo that
  // has already applied the remedy, the exact false positive this check would then be
  // famous for. A directory pattern is what `eslint .` does, so it answers the question
  // actually being asked: will their lint break?
  const dir = rel || '.';
  try {
    execFileSync(bin, [dir, '--no-error-on-unmatched-pattern'], {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024,
    });
    return { status: 'ok' };
  } catch (e: any) {
    // A timeout is not a verdict on the file: say we could not tell rather than accuse it.
    if (e?.signal === 'SIGTERM' || e?.killed) return { status: 'skipped', kind: 'timeout', reason: `ESLint did not finish within ${timeoutMs / 1000}s` };
    // Nor is a failure to START one. A binary that exists but cannot be executed leaves
    // `status` null and no output, which would otherwise be reported as "your lint will now
    // FAIL" followed by the words "no output" — an accusation with no evidence behind it.
    if (typeof e?.status !== 'number') return { status: 'skipped', kind: 'spawn-failed', reason: `ESLint could not be run (${e?.code ?? e?.message ?? 'spawn failed'})` };
    const out = `${e?.stdout ?? ''}${e?.stderr ?? ''}`;
    // Whether the output names our file decides whether lgtm may claim responsibility, and
    // it applies to BOTH exits. `.lgtm/` is not a one-file directory — the answers JSON is
    // written beside the fragment, `quality baseline` puts its own there — so a rule firing
    // on a neighbour would otherwise be reported as a problem in the fragment, with a remedy
    // aimed at the wrong file. Exit >= 2 has the same shape for a different reason: a
    // missing plugin breaks their lint before the fragment is ever read.
    const namesFragment = out.includes(basename(fragmentPath));
    return { status: e.status === 1 ? 'problems' : 'broken', detail: firstUsefulLine(out), namesFragment };
  }
}

/**
 * The line worth showing out of ESLint's output. Its crash banner ("Oops! Something went
 * wrong! :(", a blank line, then the version) is the first thing printed and says nothing;
 * the sentence that names the rule and the missing parser option is several lines down.
 * Showing the banner would reproduce the original problem in miniature — an operator told
 * something broke and not what.
 */
export function firstUsefulLine(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const noise = /^(Oops!|ESLint: |at |\.\.\.)/;
  const meaty = lines.find((l) => /error/i.test(l) && !noise.test(l));
  return (meaty ?? lines.find((l) => !noise.test(l)) ?? 'no output').slice(0, 300);
}

/**
 * One line of the lint report. `tone` is colour, which vanishes the moment the output is
 * piped — to CI, to an agent, to `| tee` — so the headline carries its own ⚠ and sits at
 * column 0. A warning that reads like a note the moment it is captured is a warning that
 * gets skimmed past, and captured is how most of this output is read.
 */
export interface ReportLine { tone: 'red' | 'yellow' | 'gray'; text: string; indent: boolean }

/**
 * Turn a lint result into the lines the operator reads. Pure, and separate from the
 * printing, because this is where the claims live: whether lgtm asserts that the file it
 * wrote broke their lint or merely that their lint is failing, and whether the remedy is
 * offered as the fix or as a possibility. Both defects DWLF-221's review rounds found were
 * here rather than in the function that computes the result — a fixed tail that contradicted
 * three of its four reasons, and an accusation against the wrong file — and neither could
 * fail a test while this was inline in the printing.
 */
export function describeFragmentLint(lint: FragmentLintResult, repoRoot: string, fragmentPath: string): ReportLine[] {
  const dir = relative(repoRoot, dirname(fragmentPath)) || '.';
  const remedy = ignoreRemedy(repoRoot, fragmentPath);
  // An exhaustive switch with a never guard (G23), not a fallthrough: a future verdict that
  // happened to carry `detail` and `namesFragment` — the likely shape of any new one —
  // would otherwise compile and be described as "reports problems in this generated file",
  // a claim its result does not support. That is the class this whole function pins.
  switch (lint.status) {
    case 'ok':
      return [];
    case 'skipped': {
      // Two skip kinds mean there is nothing here to break; the other four mean we could
      // not find out, and saying otherwise is the reassurance this whole check exists to
      // stop. Keyed on the kind, so rewording a reason cannot change what is implied.
      const nothingToBreak = lint.kind === 'no-eslint' || lint.kind === 'no-fragment';
      const tail = nothingToBreak ? ' — the mechanical rules have nothing to run in yet' : '';
      return [{ tone: 'gray', text: `Not lint-checked: ${lint.reason}${tail}.`, indent: true }];
    }
    case 'broken':
      return [
        { tone: 'red', indent: false, text: lint.namesFragment
          ? '⚠  Your ESLint cannot lint this file — `eslint .` will now FAIL, not warn:'
          : `⚠  Your ESLint exits with an error over ${dir} — this may predate the file just written:` },
        { tone: 'red', text: lint.detail, indent: true },
        { tone: 'yellow', text: `${lint.namesFragment ? 'Fix' : 'If it is this file'}: ${remedy}.`, indent: true },
        { tone: 'gray', text: "(Not done for you: editing a config lgtm did not generate is your call, not the tool's.)", indent: true },
      ];
    case 'problems':
      return [
        { tone: 'yellow', indent: false, text: lint.namesFragment
          ? `⚠  Your ESLint reports problems in this generated file: ${lint.detail}`
          : `⚠  Your ESLint reports problems under ${dir} — not necessarily this file: ${lint.detail}` },
        { tone: 'yellow', text: `Either fix the rule that fires, or ${remedy}.`, indent: true },
      ];
    default: {
      const unreachable: never = lint;
      return unreachable;
    }
  }
}

/** The one-line fix for a config that cannot lint the fragment, naming the actual directory. */
export function ignoreRemedy(repoRoot: string, fragmentPath: string): string {
  const dir = relative(repoRoot, dirname(fragmentPath)) || '.lgtm';
  return `add '${dir}' to the \`ignores\` array in your ESLint config — it is a generated config artefact, not source`;
}

function tryExec(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
  } catch {
    return '';
  }
}

const FN_KEYWORD_START = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/;
const FN_DECL = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|^\s*(?:export\s+)?const\s+[\w$]+\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>\s*\{\s*$|=>\s*\{\s*$/;
// Class-method shape — but `if (x) {` / `for (...) {` / `catch (e) {` fit the same
// `name(...) {` pattern, so control-flow keywords must be excluded or top-level
// blocks get measured as functions and skew the very percentiles the interview quotes.
const METHODISH = /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+)*(?:async\s+)?[\w$]+\s*\([^;{}]*\)\s*\{\s*$/;
const CONTROL_KEYWORD = /^\s*(?:if|for|while|switch|catch|return|else|do|try)\b/;

function isFunctionStart(line: string): boolean {
  return FN_DECL.test(line) || (METHODISH.test(line) && !CONTROL_KEYWORD.test(line));
}

/**
 * From a closing paren at (startLine, closeIdx), walk BACKWARDS — across earlier
 * lines when the signature is formatter-wrapped — to the matching '(' and return
 * the text between them. A wrapped arrow's detected start line is the `) => {`
 * line itself, so its parameters live entirely on the lines above it.
 */
function walkBackParams(lines: string[], startLine: number, closeIdx: number, maxLookbehind = 12): string {
  const buf: string[] = [];
  let depth = 0;
  for (let ln = startLine; ln >= 0 && ln > startLine - maxLookbehind; ln--) {
    const text = ln === startLine ? lines[ln].slice(0, closeIdx + 1) : lines[ln] + '\n';
    for (let p = text.length - 1; p >= 0; p--) {
      const ch = text[p];
      buf.push(ch);
      if (ch === ')') depth++;
      else if (ch === '(') {
        depth--;
        if (depth === 0) return buf.reverse().join('').slice(1, -1);
      }
    }
  }
  return ''; // unbalanced within the lookbehind — skip rather than guess
}

/**
 * Extract a function's parameter text starting at its detected start line,
 * following a WRAPPED signature across lines until the paren closes — long
 * parameter lists are exactly the ones formatters wrap, so reading only the
 * first line would systematically under-report the worst F1 offenders.
 */
function extractParams(lines: string[], start: number, maxLookahead = 12): string {
  // Arrow starts (incl. inline callbacks like `router.get('/x', (req, res) => {`):
  // take the paren group IMMEDIATELY before the arrow — the first '(' on such a
  // line is often the enclosing CALL's, and following it would swallow the whole
  // callback body into the "parameter list". But ONLY for arrow starts: a
  // function/method declaration whose parameter TYPES contain an arrow
  // (`fail: (msg: string) => never`) must stay on the declaration path, or the
  // arrow branch returns the callback type's params as the function's.
  const line = lines[start];
  if (!FN_KEYWORD_START.test(line) && !METHODISH.test(line) && line.includes('=>')) {
    // Anchor on the LAST arrow (the function-body one) and walk back over the
    // balanced paren group before it — a first-match regex would grab an inner
    // function-TYPED param's arrow instead: `const f = (a, cb: (x) => void) => {`.
    const arrowIdx = line.lastIndexOf('=>');
    let k = arrowIdx - 1;
    while (k >= 0 && /\s/.test(line[k])) k--;
    if (k >= 0 && line[k] === ')') return walkBackParams(lines, start, k);
    const bare = line.slice(0, arrowIdx).match(/([\w$]+)\s*$/);
    return bare ? bare[1] : ''; // unrecognized arrow shape — skip rather than guess
  }
  const open = line.indexOf('(');
  if (open === -1) return '';
  let depth = 0;
  let collected = '';
  for (let j = start; j < lines.length && j < start + maxLookahead; j++) {
    const text = j === start ? lines[j].slice(open) : lines[j];
    for (const ch of text) {
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return collected.slice(1); // drop the opening paren
      }
      collected += ch;
    }
    collected += '\n';
  }
  return ''; // unbalanced within the lookahead — skip rather than guess
}

/** Count top-level commas only — object/array/generic commas inside nesting don't add parameters. */
function countTopLevelParams(rawParams: string): number {
  // Drop a trailing comma before counting — it introduces no parameter, and it is
  // Prettier's DEFAULT output for wrapped signatures (trailingComma: "all"), i.e.
  // exactly the long parameter lists this metric exists to catch.
  const params = rawParams.replace(/,\s*$/, '');
  if (!params.trim()) return 0;
  let depth = 0;
  let args = 1;
  for (let k = 0; k < params.length; k++) {
    const ch = params[k];
    // The '>' of a function-typed param's '=>' is not a closing bracket — counting
    // it drives depth negative and silently skips every later top-level comma.
    if (ch === '=' && params[k + 1] === '>') { k++; continue; }
    if ('([{<'.includes(ch)) depth++;
    else if (')]}>'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) args++;
  }
  return args;
}

/** Walk brace depth from a function-start line to its matching close; returns the last line index. */
function findBlockEnd(lines: string[], start: number): number {
  let depth = 0;
  let started = false;
  let j = start;
  for (; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') depth--;
    }
    if (started && depth <= 0) break;
  }
  return j;
}

/**
 * Approximate function lengths in a source file: detect likely function-start
 * lines, then track brace depth to the matching close. String/comment contents
 * can fool it — that is fine, it feeds proposals, not findings.
 */
export function measureFunctions(source: string): { lengths: number[]; maxArgs: number } {
  const lines = source.split('\n');
  const lengths: number[] = [];
  let maxArgs = 0;
  let i = 0;
  while (i < lines.length) {
    if (!isFunctionStart(lines[i])) {
      i++;
      continue;
    }
    maxArgs = Math.max(maxArgs, countTopLevelParams(extractParams(lines, i)));
    const end = findBlockEnd(lines, i);
    lengths.push(end - i + 1);
    i = end + 1;
  }
  return { lengths, maxArgs };
}

const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const EXCLUDE_RE = /(^|\/)(node_modules|dist|build|coverage|\.next)\/|\.d\.ts$|\.min\.js$/;
const MAX_SCAN_FILES = 800;

export function scanRepo(repoRoot: string): RepoScan {
  const all = tryExec('git', ['-C', repoRoot, 'ls-files']).trim().split('\n').filter(Boolean);
  const sources = all.filter((f) => SOURCE_RE.test(f) && !EXCLUDE_RE.test(f)).slice(0, MAX_SCAN_FILES);

  const fileLineCounts: number[] = [];
  const fnLengths: number[] = [];
  let maxArgs = 0;
  for (const rel of sources) {
    const p = join(repoRoot, rel);
    try {
      if (statSync(p).size > 300_000) continue;
      const content = readFileSync(p, 'utf-8');
      fileLineCounts.push(content.split('\n').length);
      const m = measureFunctions(content);
      fnLengths.push(...m.lengths);
      maxArgs = Math.max(maxArgs, m.maxArgs);
    } catch {
      continue;
    }
  }

  // Profile inference + tooling detection from the manifest — guesses, surfaced
  // with their evidence.
  let profileGuess: RepoProfile = 'lib';
  let profileEvidence = 'no framework/platform deps detected';
  const toolingPresent = new Set<RequiredTooling>();
  const FORMATTER_CONFIGS = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js', '.eslintrc', '.eslintrc.json', '.eslintrc.cjs', '.eslintrc.js', 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.ts', 'biome.json'];
  const formatterConfigured = FORMATTER_CONFIGS.some((f) => existsSync(join(repoRoot, f)));
  // FMT-1 claims the config is "enforced in CI" — so a config FILE is not enough
  // evidence. A committed config nobody runs is decorative (SPT had one sitting on
  // 5,030 errors), and marking it adopted would put a claim in the standards doc
  // that the repo does not honour. Require a lint entry point too.
  let formatterEnforced = false;
  try {
    const workflowDir = join(repoRoot, '.github', 'workflows');
    formatterEnforced = existsSync(workflowDir) && readdirSync(workflowDir).some((f) => {
      try { return /\b(eslint|biome|prettier)\b/.test(readFileSync(join(workflowDir, f), 'utf-8')); } catch { return false; }
    });
  } catch { /* no workflows — stays false */ }
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const scriptText = Object.entries(pkg.scripts ?? {})
      .filter(([name]) => /lint|format|check/.test(name))
      .map(([, v]) => String(v))
      .join(' ');
    if (/\b(eslint|biome|prettier)\b/.test(scriptText)) formatterEnforced = true;
    if (deps.some((d) => /^(react|react-dom|next|vue|svelte)$/.test(d))) {
      profileGuess = 'frontend';
      profileEvidence = 'frontend framework in package.json dependencies';
    } else if (
      deps.some((d) => d.startsWith('@aws-sdk/') || d === 'aws-sdk' || d === 'serverless' || d.startsWith('aws-cdk')) ||
      existsSync(join(repoRoot, 'serverless.yml'))
    ) {
      profileGuess = 'service';
      profileEvidence = 'AWS SDK / serverless tooling in the manifest';
    }
    const allScripts = Object.values(pkg.scripts ?? {}).join(' ');
    if (/(--coverage|\bc8\b|\bnyc\b|coverage)/.test(allScripts) || deps.some((d) => /^(c8|nyc|@vitest\/coverage-v8)$/.test(d))) {
      toolingPresent.add('coverage');
    }
  } catch { /* keep the lib default */ }
  if (formatterConfigured && formatterEnforced) toolingPresent.add('formatter');

  const fnStats = stats(fnLengths);
  const fileStats = stats(fileLineCounts);
  return {
    fileCount: sources.length,
    fileLines: fileStats,
    fnLines: fnStats,
    toolingPresent,
    fnOver: (n) => fnLengths.filter((l) => l > n).length,
    filesOver: (n) => fileLineCounts.filter((l) => l > n).length,
    maxPositionalArgs: maxArgs,
    profileGuess,
    profileEvidence,
    summary:
      `${sources.length} source files; function lines p50 ${fnStats.p50} / p95 ${fnStats.p95} / max ${fnStats.max}; ` +
      `file lines p50 ${fileStats.p50} / p95 ${fileStats.p95} / max ${fileStats.max}; ` +
      `max positional args seen ${maxArgs} (F1 caps at ${F1_MAX_POSITIONAL_ARGS}) (approximate scan)`,
  };
}

/** Round a measured p95 up to a friendly threshold, bounded to sane review territory. */
export function proposeThresholds(scan: RepoScan): StandardsThresholds {
  const roundUp10 = (n: number) => Math.ceil(n / 10) * 10;
  const fnWarn = Math.min(100, Math.max(DEFAULT_THRESHOLDS.fnWarn, roundUp10(scan.fnLines.p95)));
  const fileWarn = Math.min(700, Math.max(DEFAULT_THRESHOLDS.fileWarn, roundUp10(scan.fileLines.p95)));
  return {
    fnWarn,
    fnMax: Math.max(DEFAULT_THRESHOLDS.fnMax, fnWarn + 30),
    fileWarn,
    fileMax: Math.max(DEFAULT_THRESHOLDS.fileMax, fileWarn + 400),
  };
}

// --- Interview ---------------------------------------------------------------

/**
 * Answer source: pre-supplied answers first (scripted runs), then the terminal.
 *
 * Two scripted forms:
 *  - OBJECT (preferred): keyed by question id — {"profile":"service","FUN-1":"strict",
 *    "fnWarn":60,"houseRules":["…"]}. Immune to question-order and conditional-
 *    question changes: threshold questions are asked only for consumed stances,
 *    so positional files can silently mis-slot when an earlier answer changes
 *    which questions exist.
 *  - ARRAY (positional, arch-new style): consumed in question order; keep such
 *    files in sync with the stances they choose.
 */
class AnswerSource {
  private queue: string[] = [];
  private map: Record<string, unknown> | null = null;
  /** --yes: never fall through to a terminal prompt — unanswered questions take their recommendation. */
  private neverPrompt: boolean;

  constructor(answersFile?: string, neverPrompt = false) {
    this.neverPrompt = neverPrompt;
    if (!answersFile) return;
    const parsed = JSON.parse(readFileSync(answersFile, 'utf-8'));
    if (Array.isArray(parsed)) {
      this.queue = parsed.map(String);
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('--answers file must contain a JSON array (positional) or object (keyed by question id)');
    }
    this.map = parsed as Record<string, unknown>;
    // A typo'd key would otherwise be silently ignored and the question would take
    // its recommended default — in the unattended mode this form exists for, that
    // diverges from the author's intent with zero signal. Warn loudly.
    const validKeys = new Set(['profile', 'fnWarn', 'fnMax', 'fileWarn', 'fileMax', 'houseRules', ...askEntries().map((e) => e.id)]);
    const unknown = Object.keys(this.map).filter((k) => !validKeys.has(k));
    if (unknown.length > 0) {
      console.error(chalk.yellow(`⚠  --answers: unknown key(s) ignored: ${unknown.join(', ')} — valid keys: ${[...validKeys].join(', ')}`));
    }
  }

  hasScripted(): boolean {
    return this.queue.length > 0 || this.map !== null;
  }

  /** Scripted answer for a question, if one exists (keyed lookup or next positional). */
  private scripted(key: string): string | undefined {
    if (this.map) {
      const v = this.map[key];
      return v === undefined || v === null ? undefined : String(v);
    }
    return this.queue.length > 0 ? this.queue.shift() : undefined;
  }

  async select(key: string, question: string, options: { value: string; label: string }[], initial: string): Promise<string> {
    console.log(chalk.white('─'.repeat(60)));
    console.log(chalk.bold(question));
    const answer = this.scripted(key);
    if (answer !== undefined) {
      const matched = options.find((o) => o.value === answer);
      if (!matched) {
        console.log(chalk.yellow(`   [scripted] "${answer}" is not one of: ${options.map((o) => o.value).join(', ')} — using ${initial}`));
        return initial;
      }
      console.log(chalk.cyan(`   [scripted] ${matched.label}`));
      return matched.value;
    }
    if (this.neverPrompt || !process.stdin.isTTY) return initial; // recommendations stand
    const response = await prompts({
      type: 'select',
      name: 'value',
      message: 'Choose',
      choices: options.map((o) => ({ title: o.label, value: o.value })),
      initial: Math.max(0, options.findIndex((o) => o.value === initial)),
    });
    if (response.value === undefined) throw new Error('Interview cancelled');
    return response.value as string;
  }

  async number(key: string, question: string, initial: number): Promise<number> {
    console.log(chalk.bold(question));
    const answer = this.scripted(key);
    if (answer !== undefined) {
      const n = parseInt(answer, 10);
      // Validate BEFORE echoing — printing the raw value as "[scripted]" while a
      // different number lands in the document would misreport an unattended run.
      if (Number.isFinite(n) && n > 0) {
        console.log(chalk.cyan(`   [scripted] ${n}`));
        return n;
      }
      console.log(chalk.yellow(`   [scripted] "${answer}" is not a positive integer — using ${initial}`));
      return initial;
    }
    if (this.neverPrompt || !process.stdin.isTTY) return initial;
    const response = await prompts({ type: 'text', name: 'value', message: `Value (enter for ${initial})` });
    if (response.value === undefined) throw new Error('Interview cancelled');
    const n = parseInt(String(response.value).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : initial;
  }

  /** Free-text loop for house rules; empty or /done finishes. Keyed form: an array of strings. */
  async textLoop(key: string, question: string): Promise<string[]> {
    console.log(chalk.white('─'.repeat(60)));
    console.log(chalk.bold(question));
    // Keyed form: short-circuit only when the key is PRESENT — an absent key falls
    // through to the interactive loop, consistent with select()/number() where a
    // missing key still prompts in a TTY run (--yes/non-TTY suppress it below).
    if (this.map && key in this.map) {
      const v = this.map[key];
      // Coerce a bare string to one rule — every other key takes a scalar, so this
      // is an easy slip, and silently dropping it defeats the unattended-run mode.
      const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
      const rules = raw.map(String).map((s) => s.trim()).filter(Boolean);
      for (const r of rules) console.log(chalk.cyan(`   [scripted] ${r}`));
      return rules;
    }
    const collected: string[] = [];
    while (true) {
      if (this.queue.length > 0) {
        const answer = this.queue.shift()!;
        if (answer === '/done' || !answer.trim()) return collected;
        console.log(chalk.cyan(`   [scripted] ${answer}`));
        collected.push(answer.trim());
        continue;
      }
      if (this.neverPrompt || !process.stdin.isTTY) return collected;
      const response = await prompts({ type: 'text', name: 'value', message: 'House rule (/done to finish)' });
      if (response.value === undefined) throw new Error('Interview cancelled');
      const answer = String(response.value).trim();
      if (answer === '/done' || !answer) return collected;
      collected.push(answer);
    }
  }
}

const PROFILES: { value: RepoProfile; label: string }[] = [
  { value: 'lib', label: 'lib — pure/published library (no platform at runtime)' },
  { value: 'service', label: 'service — serverless/API backend' },
  { value: 'frontend', label: 'frontend — React/SPA' },
];

function parseProfile(raw: string | undefined): RepoProfile | undefined {
  return raw && (['lib', 'service', 'frontend'] as const).includes(raw as RepoProfile) ? (raw as RepoProfile) : undefined;
}

/**
 * Write the mechanical half — the ESLint fragment and the answers that generated it — and
 * say what it will do to this repo. Split out of `runStandardsInit` because that function
 * was doing the interview, the document, the fragment and the reporting; this is the one
 * piece with its own subject (the target repo's lint) and its own failure modes.
 */
function writeMechanicalHalf(opts: {
  repoRoot: string; repoName: string; outPath: string; profile: RepoProfile;
  selections: StandardsSelections; severity: 'warn' | 'error';
}): FragmentLintResult {
  const { repoRoot, repoName, outPath, profile, selections, severity } = opts;

  // The fragment follows the DOCUMENT. With `--out /tmp/draft/STANDARDS.md`
  // (a preview run), writing the fragment into the real repo would be an
  // unrequested side effect on the working tree.
  const fragmentDir = join(dirname(outPath), '.lgtm');
  const fragmentPath = join(fragmentDir, 'standards.eslint.js');
  const fragment = generateEslintFragment({
    repoName,
    profile,
    selections,
    esm: usesEsm(repoRoot),
    severity,
    fragmentRelPath: relative(repoRoot, fragmentPath) || 'standards.eslint.js',
  });
  mkdirSync(fragmentDir, { recursive: true });
  writeFileSync(fragmentPath, fragment);

  // Persist the answers next to the outputs. Both artefacts are GENERATED, so a
  // hand-edit to either is silently reverted by the next re-run unless the
  // inputs live somewhere durable and versioned — which is exactly how an
  // improvement to a house rule can be lost.
  const answersPath = join(fragmentDir, 'standards.answers.json');
  writeFileSync(
    answersPath,
    JSON.stringify({ profile, ...selections.askChoices, ...selections.thresholds, houseRules: selections.houseRules }, null, 2) + '\n'
  );
  console.log(chalk.green(`✓ Wrote ${answersPath}`));
  console.log(chalk.gray('   Commit it: these documents are generated, so EDIT THE ANSWERS and re-run rather than hand-editing the output.'));
  const ruleCount = deriveRules(selections, severity).length;
  console.log(chalk.green(`✓ Wrote ${fragmentPath}`));
  console.log(chalk.gray(`   ${ruleCount} mechanical rules at "${severity}" — spread \`standardsRules\` into your ESLint config (the file's header shows how).`));
  console.log(chalk.gray('   Every rule here is one the standards review no longer has to spend a finding on.'));

  // Does the file we just wrote pass THIS repo's lint? Asked out loud, because the
  // alternative is the operator meeting the answer as a stack trace from a pre-commit hook.
  const lint = checkFragmentLints(repoRoot, fragmentPath);
  const tones = { red: chalk.red, yellow: chalk.yellow, gray: chalk.gray };
  const lines = describeFragmentLint(lint, repoRoot, fragmentPath);
  // A leading blank line only when there is something to warn about, so an `ok` or a bare
  // skip note does not punch a hole in the summary that follows.
  if (lines.some((l) => !l.indent)) console.log('');
  for (const l of lines) console.log(tones[l.tone](l.indent ? `   ${l.text}` : l.text));
  // Returned, not just printed. A `broken` verdict says this repo's `eslint .` will now
  // fail, and the caller that needs to act on that is a script, which cannot read a ⚠.
  return lint;
}

/** `lgtm standards init` — scan, ask the contested toggles, write STANDARDS.md. */
export async function runStandardsInit(options: StandardsInitOptions): Promise<FragmentLintResult> {
  const repoRoot = tryExec('git', ['rev-parse', '--show-toplevel']).trim() || process.cwd();
  const repoName = basename(repoRoot);
  const outPath = options.out || join(repoRoot, 'STANDARDS.md');

  if (existsSync(outPath) && !options.force) {
    throw new Error(`${outPath} already exists — pass --force to overwrite it.`);
  }
  if (options.profile && !parseProfile(options.profile)) {
    throw new Error(`Invalid --profile "${options.profile}". Use: lib, service, frontend`);
  }
  // --yes and --answers COMPOSE through one path: scripted answers are consulted
  // first, and --yes turns every remaining question into its recommendation
  // instead of a prompt. (A separate --yes branch once skipped the AnswerSource
  // entirely — silently ignoring an --answers file passed alongside it.)
  const answerSource = new AnswerSource(options.answers, options.yes);
  if (!process.stdin.isTTY && !options.yes && !answerSource.hasScripted()) {
    throw new Error('The standards interview needs an interactive terminal (or --yes to accept recommendations, or --answers <file>).');
  }

  console.log(chalk.blue(`\n📏 Selecting engineering standards for "${repoName}" — from lgtm's clean-code catalog.`));
  console.log(chalk.blue('\n🔎 Scanning the repo (approximate — informs proposals, decides nothing)...'));
  const scan = scanRepo(repoRoot);
  console.log(chalk.gray(`   ${scan.summary}`));
  console.log(chalk.gray(`   Profile guess: ${scan.profileGuess} (${scan.profileEvidence})`));
  const missingTooling = (['formatter', 'coverage'] as RequiredTooling[]).filter((t) => !scan.toolingPresent.has(t));
  if (missingTooling.length > 0) {
    console.log(chalk.gray(`   Tooling not detected: ${missingTooling.join(', ')} — standards presuming it render as aspirational.`));
  }

  const proposed = proposeThresholds(scan);

  if (options.yes) console.log(chalk.gray('\n   --yes: unanswered questions take their recommendation.'));

  const profile: RepoProfile =
    parseProfile(options.profile) ??
    (await answerSource.select('profile', 'Repo profile — sets defaults and thresholds:', PROFILES, scan.profileGuess)) as RepoProfile;

  const askChoices: Record<string, string> = {};
  for (const e of askEntries()) {
    askChoices[e.id] = await answerSource.select(e.id, `${e.id} — ${e.ask!.question}`, e.ask!.options, e.ask!.options[0].value);
  }

  // Threshold questions apply only when some CHOSEN rule will actually render
  // the numbers — derived from placeholder consumption across the resolved rule
  // set, so a stance whose rule text carries no threshold (e.g. FUN-1 "strict")
  // never collects numbers it would then discard.
  const consumed = thresholdsConsumed(profile, askChoices);
  let thresholds: StandardsThresholds = proposed;

  if (consumed.fn) {
    console.log(chalk.gray(`   (scan: function lines p95 ${scan.fnLines.p95}, ${scan.fnOver(proposed.fnWarn)} over ${proposed.fnWarn}, ${scan.fnOver(proposed.fnMax)} over ${proposed.fnMax})`));
    const fnWarn = await answerSource.number('fnWarn', `Function-length warn threshold (proposed ${proposed.fnWarn}):`, proposed.fnWarn);
    // Re-propose the finding threshold relative to the warn just entered, so a
    // custom warn can't sit above a stale proposed finding value.
    const fnMaxProposal = Math.max(proposed.fnMax, fnWarn + 30);
    thresholds = { ...thresholds, fnWarn, fnMax: await answerSource.number('fnMax', `Function-length finding threshold (proposed ${fnMaxProposal}):`, fnMaxProposal) };
  }
  if (consumed.file) {
    console.log(chalk.gray(`   (scan: file lines p95 ${scan.fileLines.p95}, ${scan.filesOver(proposed.fileWarn)} over ${proposed.fileWarn}, ${scan.filesOver(proposed.fileMax)} over ${proposed.fileMax})`));
    const fileWarn = await answerSource.number('fileWarn', `File-length warn threshold (proposed ${proposed.fileWarn}):`, proposed.fileWarn);
    const fileMaxProposal = Math.max(proposed.fileMax, fileWarn + 400);
    thresholds = { ...thresholds, fileWarn, fileMax: await answerSource.number('fileMax', `File-length finding threshold (proposed ${fileMaxProposal}):`, fileMaxProposal) };
  }
  thresholds = clampThresholds(thresholds);

  const houseRules = await answerSource.textLoop('houseRules', 'House rules — repo-specific standards no book wrote (e.g. "every list read paginates"). Add any now:');

  // Closing output and the document's provenance honor the same gating as the
  // questions — a stance without thresholds must not be reported (or costed) as
  // having them.
  const consumedOut = thresholdsConsumed(profile, askChoices);
  const legacyViolations = {
    functions: consumedOut.fn ? scan.fnOver(thresholds.fnMax) : 0,
    files: consumedOut.file ? scan.filesOver(thresholds.fileMax) : 0,
  };

  const selections: StandardsSelections = { askChoices, thresholds, houseRules };
  const doc = generateStandardsDoc({ repoName, profile, selections, scanSummary: scan.summary, toolingPresent: scan.toolingPresent, legacyViolations });

  writeFileSync(outPath, doc.endsWith('\n') ? doc : doc + '\n');
  console.log(chalk.green(`\n✓ Wrote ${outPath}`));

  // The mechanical half, derived from the same selections so the two can't drift.
  // --no-eslint emits no fragment, so there is nothing to have broken: `skipped`, not `ok`.
  let lintVerdict: FragmentLintResult = { status: 'skipped', kind: 'no-fragment', reason: 'no ESLint fragment was written (--no-eslint)' };
  if (!options.noEslint) {
    lintVerdict = writeMechanicalHalf({ repoRoot, repoName, outPath, profile, selections, severity: options.severity ?? 'warn' });
  }
  const summaryParts = [`Profile ${profile}`];
  if (consumedOut.fn) summaryParts.push(`function >${thresholds.fnWarn}/${thresholds.fnMax} lines`);
  if (consumedOut.file) summaryParts.push(`file >${thresholds.fileWarn}/${thresholds.fileMax} lines`);
  summaryParts.push(`${houseRules.length} house rule(s)`);
  console.log(chalk.gray(`   ${summaryParts.join(' · ')}`));
  if (legacyViolations.functions + legacyViolations.files > 0) {
    console.log(chalk.yellow(`   Existing-violation cost: ~${legacyViolations.functions} function(s) and ~${legacyViolations.files} file(s) already exceed the finding thresholds — standards apply to NEW code, so these become findings only when touched.`));
  }
  console.log(chalk.gray('\nReview the file, edit freely, commit it. `lgtm review` will now cite `(standard <id>)` findings against it (opt out per run with --no-standards).'));
  return lintVerdict;
}
