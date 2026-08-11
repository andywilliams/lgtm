import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import prompts from 'prompts';
import chalk from 'chalk';
import { askEntries, F1_MAX_POSITIONAL_ARGS, type RepoProfile } from './standardsCatalog.js';
import { DEFAULT_THRESHOLDS, clampThresholds, generateStandardsDoc, thresholdsConsumed, type StandardsSelections, type StandardsThresholds } from './standards.js';

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
    const parenParams = line.match(/\(([^()]*)\)\s*=>/);
    if (parenParams) return parenParams[1];
    const bareParam = line.match(/(?:^|[,(=]\s*)([\w$]+)\s*=>/);
    return bareParam ? bareParam[1] : ''; // unrecognized arrow shape — skip rather than guess
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
function countTopLevelParams(params: string): number {
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

  // Profile inference from the manifest — a guess, surfaced with its evidence.
  let profileGuess: RepoProfile = 'lib';
  let profileEvidence = 'no framework/platform deps detected';
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
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
  } catch { /* keep the lib default */ }

  const fnStats = stats(fnLengths);
  const fileStats = stats(fileLineCounts);
  return {
    fileCount: sources.length,
    fileLines: fileStats,
    fnLines: fnStats,
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

  constructor(answersFile?: string) {
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
    if (!process.stdin.isTTY) return initial; // scripted answers exhausted — recommendations stand
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
      console.log(chalk.cyan(`   [scripted] ${answer}`));
      return Number.isFinite(n) && n > 0 ? n : initial;
    }
    if (!process.stdin.isTTY) return initial;
    const response = await prompts({ type: 'text', name: 'value', message: `Value (enter for ${initial})` });
    if (response.value === undefined) throw new Error('Interview cancelled');
    const n = parseInt(String(response.value).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : initial;
  }

  /** Free-text loop for house rules; empty or /done finishes. Keyed form: an array of strings. */
  async textLoop(key: string, question: string): Promise<string[]> {
    console.log(chalk.white('─'.repeat(60)));
    console.log(chalk.bold(question));
    if (this.map) {
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
      if (!process.stdin.isTTY) return collected;
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

/** `lgtm standards init` — scan, ask the contested toggles, write STANDARDS.md. */
export async function runStandardsInit(options: StandardsInitOptions): Promise<void> {
  const repoRoot = tryExec('git', ['rev-parse', '--show-toplevel']).trim() || process.cwd();
  const repoName = basename(repoRoot);
  const outPath = options.out || join(repoRoot, 'STANDARDS.md');

  if (existsSync(outPath) && !options.force) {
    throw new Error(`${outPath} already exists — pass --force to overwrite it.`);
  }
  if (options.profile && !parseProfile(options.profile)) {
    throw new Error(`Invalid --profile "${options.profile}". Use: lib, service, frontend`);
  }
  const answerSource = new AnswerSource(options.answers);
  if (!process.stdin.isTTY && !options.yes && !answerSource.hasScripted()) {
    throw new Error('The standards interview needs an interactive terminal (or --yes to accept recommendations, or --answers <file>).');
  }

  console.log(chalk.blue(`\n📏 Selecting engineering standards for "${repoName}" — from lgtm's clean-code catalog.`));
  console.log(chalk.blue('\n🔎 Scanning the repo (approximate — informs proposals, decides nothing)...'));
  const scan = scanRepo(repoRoot);
  console.log(chalk.gray(`   ${scan.summary}`));
  console.log(chalk.gray(`   Profile guess: ${scan.profileGuess} (${scan.profileEvidence})`));

  const proposed = proposeThresholds(scan);

  let profile: RepoProfile;
  let askChoices: Record<string, string> = {};
  let thresholds: StandardsThresholds = proposed;
  let houseRules: string[] = [];

  if (options.yes) {
    profile = parseProfile(options.profile) ?? scan.profileGuess;
    for (const e of askEntries()) askChoices[e.id] = e.ask!.options[0].value;
    console.log(chalk.gray('\n   --yes: accepting every recommendation.'));
  } else {
    profile =
      parseProfile(options.profile) ??
      (await answerSource.select('profile', 'Repo profile — sets defaults and thresholds:', PROFILES, scan.profileGuess)) as RepoProfile;

    for (const e of askEntries()) {
      askChoices[e.id] = await answerSource.select(e.id, `${e.id} — ${e.ask!.question}`, e.ask!.options, e.ask!.options[0].value);
    }

    // Threshold questions apply only when some CHOSEN rule will actually render
    // the numbers — derived from placeholder consumption across the resolved rule
    // set, so a stance whose rule text carries no threshold (e.g. FUN-1 "strict")
    // never collects numbers it would then discard.
    const consumed = thresholdsConsumed(profile, askChoices);

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

    houseRules = await answerSource.textLoop('houseRules', 'House rules — repo-specific standards no book wrote (e.g. "every list read paginates"). Add any now:');
  }

  const selections: StandardsSelections = { askChoices, thresholds, houseRules };
  const doc = generateStandardsDoc({ repoName, profile, selections, scanSummary: scan.summary });

  writeFileSync(outPath, doc.endsWith('\n') ? doc : doc + '\n');
  console.log(chalk.green(`\n✓ Wrote ${outPath}`));
  // Closing output honors the same gating as the questions and the document —
  // a stance without thresholds must not be reported (or costed) as having them.
  const consumedOut = thresholdsConsumed(profile, askChoices);
  const summaryParts = [`Profile ${profile}`];
  if (consumedOut.fn) summaryParts.push(`function >${thresholds.fnWarn}/${thresholds.fnMax} lines`);
  if (consumedOut.file) summaryParts.push(`file >${thresholds.fileWarn}/${thresholds.fileMax} lines`);
  summaryParts.push(`${houseRules.length} house rule(s)`);
  console.log(chalk.gray(`   ${summaryParts.join(' · ')}`));
  const fnCost = consumedOut.fn ? scan.fnOver(thresholds.fnMax) : 0;
  const fileCost = consumedOut.file ? scan.filesOver(thresholds.fileMax) : 0;
  if (fnCost + fileCost > 0) {
    console.log(chalk.yellow(`   Existing-violation cost: ~${fnCost} function(s) and ~${fileCost} file(s) already exceed the finding thresholds — standards apply to NEW code, so these become findings only when touched.`));
  }
  console.log(chalk.gray('\nReview the file, edit freely, commit it. `lgtm review` will now cite `(standard <id>)` findings against it (opt out per run with --no-standards).'));
}
