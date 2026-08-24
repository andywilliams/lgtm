/**
 * lgtm quality — the 4th altitude: do the tests actually hold the code down?
 *
 * Phase 1: the deterministic spine. `quality baseline` reads a Stryker
 * `mutation.json` and writes per-file scores to a COMMITTED repo file
 * (`.lgtm/mutation-baseline.json`); `quality hotspots` ranks the burn-down
 * worklist. NO AI call in either — same posture as `standards init`
 * (detection is mechanical; judgement is a later, capped, AI phase).
 *
 * Design decisions (Phase 0 interview, 24-Aug-2026 — Andy):
 * - CONSUME, don't execute: producing mutation.json is the target repo's job
 *   (CI or a local Stryker run). lgtm reads the artifact. A missing report is
 *   a loud, actionable error on these explicit commands — but must degrade to
 *   a NO-OP WARNING wherever quality participates in a review (Phase 2+), the
 *   brain.ts posture: never break a review over an optional input.
 * - COMMITTED baseline, not the sqlite store: the ratchet must travel with
 *   the repo (visible in PRs, diffable, CI-readable). The store is
 *   single-machine and already flagged as accepted debt in the charter.
 * - Ratchet resets are LOUD, never inherited: a file absent from the baseline
 *   is seeded at its current score and REPORTED. No git-rename archaeology —
 *   you can shed a file's history, but never silently. (The gate itself is
 *   Phase 2; the baseline schema here carries what it needs: score, counts,
 *   commit, date.)
 * - hotspots is a REPORT, deliberately uncapped: only the Phase-3 AI triage
 *   emits capped findings (tagged `(mutant <mutator>)`, mirroring
 *   `(standard <id>)`).
 *
 * Score definition (Stryker's own): detected / valid, where
 * detected = Killed + Timeout and valid = detected + Survived + NoCoverage.
 * Ignored / CompileError / RuntimeError mutants are excluded from both sides.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/** Git toplevel, falling back to cwd outside a repo — the same resolution the
 * other repo-artifact writers use, so a committed file cannot silently land in
 * a subdirectory because of where the command was run from. */
export function resolveRepoRoot(cwd?: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: cwd ?? process.cwd(), encoding: 'utf8',
    }).trim() || (cwd ?? process.cwd());
  } catch {
    return cwd ?? process.cwd();
  }
}

export interface FileQuality {
  path: string;
  mutants: number;      // valid mutants (denominator)
  killed: number;       // includes Timeout — both count as detected
  survived: number;
  noCoverage: number;
  score: number;        // 0–100, Stryker definition
}

export interface HotspotRow extends FileQuality {
  churn: number;        // commits touching the file (git --follow, full history)
  risk: number;         // (1 - score/100) * mutants * (1 + churn)
  blockedBy: Array<{ number: number; title: string }>; // open issues naming the file
}

export interface BaselineDoc {
  /** Schema version — bump on any breaking change so a Phase-2 gate can tell
   * a v1 baseline from a v2 one in a repo it is not looking at. */
  version: 1;
  generatedAt: string;
  commit: string | null;
  reportPath: string;
  files: Record<string, Omit<FileQuality, 'path'>>;
}

/** Where a repo's mutation report is looked for, in order. */
const REPORT_LOCATIONS = [
  'reports/mutation/mutation.json', // Stryker's default jsonReporter path
  '.lgtm/mutation.json',
  'mutation.json',
];

export function findReportPath(repoRoot: string, override?: string): string | null {
  if (override) {
    const p = path.resolve(repoRoot, override);
    return fs.existsSync(p) ? p : null;
  }
  for (const rel of REPORT_LOCATIONS) {
    const p = path.join(repoRoot, rel);
    if (fs.existsSync(p)) { return p; }
  }
  return null;
}

/**
 * Per-file aggregation of a Stryker mutation.json. Files whose valid-mutant
 * count is zero (everything ignored / compile-errored) are dropped rather
 * than reported as 100% or 0% — either number would be a claim the data does
 * not hold.
 */
export function parseMutationReport(report: any): FileQuality[] {
  const files = report?.files;
  if (!files || typeof files !== 'object') {
    throw new Error('Not a Stryker mutation report: no `files` map (expected schemaVersion 1.x mutation.json)');
  }
  const out: FileQuality[] = [];
  for (const [filePath, entry] of Object.entries<any>(files)) {
    let killed = 0, survived = 0, noCoverage = 0;
    for (const m of entry?.mutants ?? []) {
      switch (m?.status) {
        case 'Killed':
        case 'Timeout': killed += 1; break;
        case 'Survived': survived += 1; break;
        case 'NoCoverage': noCoverage += 1; break;
        default: break; // Ignored / CompileError / RuntimeError — excluded
      }
    }
    const valid = killed + survived + noCoverage;
    if (valid === 0) { continue; }
    out.push({
      path: filePath,
      mutants: valid,
      killed,
      survived,
      noCoverage,
      score: (killed / valid) * 100,
    });
  }
  return out;
}

export function buildBaseline(files: FileQuality[], meta: { commit: string | null; reportPath: string }): BaselineDoc {
  const doc: BaselineDoc = {
    version: 1,
    generatedAt: new Date().toISOString(),
    commit: meta.commit,
    reportPath: meta.reportPath,
    files: {},
  };
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    doc.files[f.path] = {
      mutants: f.mutants,
      killed: f.killed,
      survived: f.survived,
      noCoverage: f.noCoverage,
      score: Number(f.score.toFixed(2)),
    };
  }
  return doc;
}

export function gitCommit(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Commits touching each file, full history, following renames. Churn is a
 * RISK input, not a metric anyone optimises, so full history (rather than a
 * windowed count) is deliberate: a file that has needed touching forty times
 * is structurally hot even if it has been quiet for a month.
 */
export function churnFor(repoRoot: string, paths: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of paths) {
    try {
      const log = execFileSync('git', ['log', '--follow', '--format=%H', '--', p], {
        cwd: repoRoot, encoding: 'utf8',
      });
      out.set(p, log.split('\n').filter(Boolean).length);
    } catch {
      out.set(p, 0); // outside git / new file — churn 0, never a failure
    }
  }
  return out;
}

/**
 * Open issues that NAME each file (basename match in title or body), via the
 * gh CLI. This is the fix-before-harden guard: hardening a file with an open
 * correctness bug CEMENTS the bug into the suite (regime.ts #93 is the
 * canonical example). Degrades to "unchecked" with a warning when gh is
 * unavailable — the ranking still prints; the guard column says it couldn't
 * look, rather than silently claiming nothing blocks.
 */
export function crossCheckIssues(
  repoRoot: string,
  paths: string[],
): { byFile: Map<string, Array<{ number: number; title: string }>>; checked: boolean; truncated: boolean } {
  const byFile = new Map<string, Array<{ number: number; title: string }>>();
  let issues: Array<{ number: number; title: string; body: string }>;
  let truncated = false;
  try {
    const raw = execFileSync('gh', ['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,body'], {
      cwd: repoRoot, encoding: 'utf8',
    });
    issues = JSON.parse(raw);
    // At the cap we cannot know what we did not see — a truncated check must
    // not report itself as a completed one.
    truncated = issues.length >= 500;
  } catch {
    return { byFile, checked: false, truncated: false };
  }
  for (const p of paths) {
    const base = path.basename(p);
    const hits = issues
      .filter((i) => (i.title ?? '').includes(base) || (i.body ?? '').includes(base))
      .map((i) => ({ number: i.number, title: i.title }));
    if (hits.length > 0) { byFile.set(p, hits); }
  }
  return { byFile, checked: !truncated, truncated };
}

/**
 * Risk ranking: (1 - score/100) * validMutants * (1 + churn).
 * Deterministic; noCoverage is not a separate factor because uncovered
 * mutants are already inside both (1-score) and the mutant count — but it IS
 * surfaced as its own column, because a whole-function no-cov block is the
 * cheapest possible work unit (usually one test) and the reader should see it.
 */
export function rankHotspots(
  files: FileQuality[],
  churn: Map<string, number>,
  blocked: Map<string, Array<{ number: number; title: string }>>,
): HotspotRow[] {
  return files
    .map((f) => {
      const c = churn.get(f.path) ?? 0;
      return {
        ...f,
        churn: c,
        risk: (1 - f.score / 100) * f.mutants * (1 + c),
        blockedBy: blocked.get(f.path) ?? [],
      };
    })
    .sort((a, b) => b.risk - a.risk);
}

// ── command entry points ─────────────────────────────────────────────

export async function runQualityBaseline(opts: { report?: string; out?: string; cwd?: string; force?: boolean }): Promise<void> {
  const repoRoot = resolveRepoRoot(opts.cwd);
  const reportPath = findReportPath(repoRoot, opts.report);
  if (!reportPath) {
    throw new Error(
      'No mutation.json found (looked in: ' + REPORT_LOCATIONS.join(', ') + ').\n' +
      'Producing the report is the repo\'s job — run Stryker (e.g. `npm run test:mutation`) or pass --report <path>.'
    );
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const files = parseMutationReport(report);
  if (files.length === 0) {
    throw new Error(`Report at ${reportPath} contains no valid mutants — refusing to write an empty baseline.`);
  }
  const doc = buildBaseline(files, { commit: gitCommit(repoRoot), reportPath: path.relative(repoRoot, reportPath) });
  const outPath = path.resolve(repoRoot, opts.out ?? '.lgtm/mutation-baseline.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Loud-reset visibility (Phase 0 decision): when a baseline already exists,
  // report files that DROPPED OUT and files that are NEW — a rename shows as
  // one of each, so shedding history is always visible in the diff and here.
  let prior: BaselineDoc | null = null;
  if (fs.existsSync(outPath)) {
    try { prior = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { prior = null; }
  }

  // The ratchet-clearing guard: this file IS the ratchet, so a rewrite that
  // LOWERS any file's committed score must be a conscious act, not a side
  // effect of re-running the command against a weaker report. Score RISES
  // rewrite freely (that is the ratchet working); falls require --force and
  // are then still listed loudly. Membership changes alone never gate — the
  // DROPPED/NEW reporting below covers them.
  const regressions: Array<{ path: string; from: number; to: number }> = [];
  if (prior?.files) {
    for (const [fp, entry] of Object.entries(doc.files)) {
      const before = prior.files[fp];
      if (before && entry.score < before.score) {
        regressions.push({ path: fp, from: before.score, to: entry.score });
      }
    }
  }
  if (regressions.length > 0 && !opts.force) {
    const lines = regressions.map((r) => `   ${r.path}: ${r.from}% → ${r.to}%`).join('\n');
    throw new Error(
      `Refusing to LOWER ${regressions.length} committed baseline score(s) without --force:\n${lines}\n` +
      'A falling ratchet is either a weaker report (wrong input?) or a real regression — either way it must be deliberate.'
    );
  }
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
  for (const r of regressions) {
    console.log(`   ⚠ baseline score LOWERED (--force): ${r.path} ${r.from}% → ${r.to}%`);
  }

  const total = files.reduce((a, f) => a + f.mutants, 0);
  const detected = files.reduce((a, f) => a + f.killed, 0);
  console.log(`✓ Baseline written: ${outPath}`);
  console.log(`   ${files.length} files · ${total} valid mutants · overall score ${((detected / total) * 100).toFixed(1)}%`);
  if (prior?.files) {
    const oldPaths = new Set(Object.keys(prior.files));
    const newPaths = new Set(Object.keys(doc.files));
    const dropped = [...oldPaths].filter((p) => !newPaths.has(p));
    const added = [...newPaths].filter((p) => !oldPaths.has(p));
    for (const p of dropped) { console.log(`   ⚠ baseline entry DROPPED: ${p} (score history shed — was ${prior.files[p].score}%)`); }
    for (const p of added) { console.log(`   ⚠ baseline entry NEW: ${p} (no history; seeded at ${doc.files[p].score}%)`); }
  }
  console.log('   Commit .lgtm/mutation-baseline.json — the ratchet travels with the repo.');
}

export async function runQualityHotspots(opts: { report?: string; top?: number; cwd?: string; json?: boolean; noIssues?: boolean }): Promise<void> {
  const repoRoot = resolveRepoRoot(opts.cwd);
  const reportPath = findReportPath(repoRoot, opts.report);
  if (!reportPath) {
    throw new Error(
      'No mutation.json found (looked in: ' + REPORT_LOCATIONS.join(', ') + ').\n' +
      'Run Stryker first (e.g. `npm run test:mutation`) or pass --report <path>.'
    );
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const files = parseMutationReport(report);
  const churn = churnFor(repoRoot, files.map((f) => f.path));
  const issueCheck = opts.noIssues
    ? { byFile: new Map<string, Array<{ number: number; title: string }>>(), checked: false, truncated: false }
    : crossCheckIssues(repoRoot, files.map((f) => f.path));
  const ranked = rankHotspots(files, churn, issueCheck.byFile);
  const top = ranked.slice(0, opts.top ?? 10);

  if (opts.json) {
    console.log(JSON.stringify({ reportPath, issuesChecked: issueCheck.checked, hotspots: top }, null, 2));
    return;
  }

  console.log(`🔥 Hotspots — ranked by (1−score) × mutants × (1+churn) · report: ${path.relative(repoRoot, reportPath)}`);
  if (!issueCheck.checked && !opts.noIssues) {
    console.log(issueCheck.truncated
      ? '   ⚠ open-issue cross-check PARTIAL (500-issue cap hit) — files may be blocked by issues this run never saw.'
      : '   ⚠ open-issue cross-check UNAVAILABLE (gh failed) — the fix-before-harden column could not look.');
  }
  for (const [i, h] of top.entries()) {
    const flag = h.blockedBy.length > 0
      ? `  🛑 FIX BEFORE HARDEN: ${h.blockedBy.map((b) => `#${b.number}`).join(' ')} (${h.blockedBy[0].title.slice(0, 60)})`
      : '';
    console.log(
      `  ${String(i + 1).padStart(2)}. ${h.path}` +
      `\n      score ${h.score.toFixed(1)}% · ${h.survived} survived · ${h.noCoverage} no-cov · churn ${h.churn} · risk ${Math.round(h.risk)}${flag}`
    );
  }
  console.log('\n   Hardening a file with an open correctness bug CEMENTS the bug — fix first, harden second.');
}
