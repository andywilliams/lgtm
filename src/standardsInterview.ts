import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import prompts from 'prompts';
import chalk from 'chalk';
import { askEntries, type RepoProfile } from './standardsCatalog.js';
import { DEFAULT_THRESHOLDS, generateStandardsDoc, type StandardsSelections, type StandardsThresholds } from './standards.js';

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

const FN_START = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b|^\s*(?:export\s+)?const\s+[\w$]+\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>\s*\{\s*$|=>\s*\{\s*$|^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+)*(?:async\s+)?[\w$]+\s*\([^;{}]*\)\s*\{\s*$/;

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
    const line = lines[i];
    if (FN_START.test(line)) {
      const params = line.match(/\(([^)]*)\)/)?.[1] ?? '';
      if (params.trim()) {
        // Count top-level commas only — object/array/generic commas inside nesting don't add parameters.
        let depth = 0;
        let args = 1;
        for (const ch of params) {
          if ('([{<'.includes(ch)) depth++;
          else if (')]}>'.includes(ch)) depth--;
          else if (ch === ',' && depth === 0) args++;
        }
        maxArgs = Math.max(maxArgs, args);
      }
      let depth = 0;
      let started = false;
      let j = i;
      for (; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') depth--;
        }
        if (started && depth <= 0) break;
      }
      lengths.push(j - i + 1);
      i = j + 1;
    } else {
      i++;
    }
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
      `file lines p50 ${fileStats.p50} / p95 ${fileStats.p95} / max ${fileStats.max} (approximate scan)`,
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

/** Answer source: pre-supplied answers first (scripted runs), then the terminal. */
class AnswerSource {
  private queue: string[];
  constructor(answersFile?: string) {
    this.queue = [];
    if (answersFile) {
      const parsed = JSON.parse(readFileSync(answersFile, 'utf-8'));
      if (!Array.isArray(parsed)) throw new Error('--answers file must contain a JSON array of strings');
      this.queue = parsed.map(String);
    }
  }

  hasScripted(): boolean {
    return this.queue.length > 0;
  }

  async select(question: string, options: { value: string; label: string }[], initial: string): Promise<string> {
    console.log(chalk.white('─'.repeat(60)));
    console.log(chalk.bold(question));
    if (this.queue.length > 0) {
      const answer = this.queue.shift()!;
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

  async number(question: string, initial: number): Promise<number> {
    console.log(chalk.bold(question));
    if (this.queue.length > 0) {
      const answer = this.queue.shift()!;
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

  /** Free-text loop for house rules; empty or /done finishes. */
  async textLoop(question: string): Promise<string[]> {
    console.log(chalk.white('─'.repeat(60)));
    console.log(chalk.bold(question));
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
      (await answerSource.select('Repo profile — sets defaults and thresholds:', PROFILES, scan.profileGuess)) as RepoProfile;

    for (const e of askEntries()) {
      askChoices[e.id] = await answerSource.select(`${e.id} — ${e.ask!.question}`, e.ask!.options, e.ask!.options[0].value);
    }

    if (askChoices['FUN-1'] !== 'off') {
      console.log(chalk.gray(`   (scan: function lines p95 ${scan.fnLines.p95}, ${scan.fnOver(proposed.fnWarn)} over ${proposed.fnWarn}, ${scan.fnOver(proposed.fnMax)} over ${proposed.fnMax})`));
      thresholds = { ...thresholds, fnWarn: await answerSource.number(`Function-length warn threshold (proposed ${proposed.fnWarn}):`, proposed.fnWarn) };
      thresholds = { ...thresholds, fnMax: await answerSource.number(`Function-length finding threshold (proposed ${proposed.fnMax}):`, proposed.fnMax) };
    }
    if (askChoices['FMT-2'] !== 'off') {
      console.log(chalk.gray(`   (scan: file lines p95 ${scan.fileLines.p95}, ${scan.filesOver(proposed.fileWarn)} over ${proposed.fileWarn}, ${scan.filesOver(proposed.fileMax)} over ${proposed.fileMax})`));
      thresholds = { ...thresholds, fileWarn: await answerSource.number(`File-length warn threshold (proposed ${proposed.fileWarn}):`, proposed.fileWarn) };
      thresholds = { ...thresholds, fileMax: await answerSource.number(`File-length finding threshold (proposed ${proposed.fileMax}):`, proposed.fileMax) };
    }

    houseRules = await answerSource.textLoop('House rules — repo-specific standards no book wrote (e.g. "every list read paginates"). Add any now:');
  }

  const selections: StandardsSelections = { askChoices, thresholds, houseRules };
  const doc = generateStandardsDoc({ repoName, profile, selections, scanSummary: scan.summary });

  writeFileSync(outPath, doc.endsWith('\n') ? doc : doc + '\n');
  console.log(chalk.green(`\n✓ Wrote ${outPath}`));
  console.log(chalk.gray(`   Profile ${profile} · function >${thresholds.fnWarn}/${thresholds.fnMax} lines · file >${thresholds.fileWarn}/${thresholds.fileMax} lines · ${houseRules.length} house rule(s)`));
  const fnCost = scan.fnOver(thresholds.fnMax);
  const fileCost = scan.filesOver(thresholds.fileMax);
  if (fnCost + fileCost > 0) {
    console.log(chalk.yellow(`   Existing-violation cost: ~${fnCost} function(s) and ~${fileCost} file(s) already exceed the finding thresholds — standards apply to NEW code, so these become findings only when touched.`));
  }
  console.log(chalk.gray('\nReview the file, edit freely, commit it. `lgtm review` will now cite `(standard <id>)` findings against it (opt out per run with --no-standards).'));
}
