#!/usr/bin/env node

import { program, Option } from 'commander';
import prompts from 'prompts';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { getPRDetails, getPRDiff, getChangedFiles, getFileContent, submitReview, postBatchReview, postReviewComment, postIssueComment, getPRComments, getExistingReviewComments, resolveComment, getCurrentRepoSlug } from './github.js';
import { getLocalDetails, getLocalDiff, getLocalChangedFiles, getLocalFileContent, detectDefaultBase, getCurrentBranch } from './git.js';
import { reviewPR, recheckComments, generateQuiz, checkClaudeCli, checkCodexCli, getAvailableProviders, SYSTEM_PROMPT as REVIEW_SYSTEM_PROMPT, type AIProvider } from './review.js';
import { SYSTEM_PROMPT_KEY } from './session.js';
import { archReview, formatArchComment } from './arch.js';
import { runArchNew, runArchInit } from './archInterview.js';
import { runStandardsInit } from './standardsInterview.js';
import { runQualityBaseline, runQualityHotspots } from './quality.js';
import { runStandardsReview } from './standardsReview.js';
import { buildArchitectureContext } from './charter.js';
import { buildStandardsBlock } from './standards.js';
import { fetchBrainContext } from './brain.js';
import { extractChangedSymbols, findUsages, formatUsageContext, getRepoRoot } from './usage.js';
import { expandContext } from './contextExpander.js';
import { logReview, logFindings, disposePreviousRound, getLoopSummary, loopContext, dismissFindings, stopAdvice, ROUND_BUDGET, type DispositionSummary, type StopAdvice, type LoopSession } from './db.js';
import { createHash, randomUUID } from 'node:crypto';
import { takeUsage, promptTokens, setModelOverride, pickRoundModel, isModelId, LATE_ROUND, type AIUsage, type RoundModelChoice } from './ai.js';
import { reviewWithRecovery } from './recovery.js';
import { planSession, modelRoleOf } from './session.js';
import { extractWriteIdentifiers, failedSearchRoots, fieldsFromHelpers, findReaders, formatReadersContext, mergeIdentifiers, readersSearchRan, searchRoots } from './readers.js';
import { formatReviewCommentBody, isDuplicateComment } from './comments.js';
import { savePendingReview, loadPendingReview, deletePendingReview, listPendingReviews } from './cache.js';
import type { Harshness, ReviewComment, ReviewResult, ExistingComment, ExistingReviewComment, DecidedFinding, ArchResult, ArchAuthority, ArchReversibility, PRDetails } from './types.js';

/**
 * Resolve which AI CLI to use: validate an explicit --ai choice, otherwise auto-detect
 * (preferring claude). `fail` carries each command's own error contract (plain text vs
 * JSON-to-stdout), so this stays usable from every subcommand.
 */
function resolveProvider(requested: string | undefined, fail: (msg: string) => never): AIProvider {
  if (requested) {
    if (!['claude', 'codex'].includes(requested)) {
      fail('Invalid AI provider. Use: claude, codex');
    }
    const ai = requested as AIProvider;
    if (ai === 'claude' && !checkClaudeCli()) {
      fail('Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code && claude login');
    }
    if (ai === 'codex' && !checkCodexCli()) {
      fail('Codex CLI not found. Install: npm install -g @openai/codex');
    }
    return ai;
  }
  const available = getAvailableProviders();
  if (available.length === 0) {
    fail('No AI CLI found. Install claude or codex.');
  }
  return available.includes('claude') ? 'claude' : 'codex';
}

/** Plain-text error exit, for commands with no JSON output contract. */
function exitWithTextError(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

/**
 * The cwd checkout's root — but only when the cwd checkout IS the repo under
 * review. With `--repo` pointing at a different repository, the cwd repo's
 * ARCHITECTURE.md must not leak in as that repo's charter; returning null keeps
 * charter resolution to the (repo-name-keyed) brain fallback instead.
 */
function charterRepoRoot(repo?: string): string | null {
  let root: string | null = null;
  try { root = getRepoRoot(); } catch { return null; }
  if (!repo) return root;
  const cwdSlug = getCurrentRepoSlug();
  return cwdSlug && cwdSlug.toLowerCase() === repo.toLowerCase() ? root : null;
}

const SEVERITY_COLORS: Record<string, (s: string) => string> = {
  BUG: chalk.red,
  SECURITY: chalk.magenta,
  SUGGESTION: chalk.yellow,
  NITPICK: chalk.gray,
};

const SEVERITY_ICONS: Record<string, string> = {
  BUG: '🐛',
  SECURITY: '🔒',
  SUGGESTION: '💡',
  NITPICK: '📝',
};

program
  .name('lgtm')
  .description('AI-powered PR review CLI — you stay in control')
  .version('0.1.0');

// Discoverable breadcrumb for the optional second-brain integration (off by default).
program.addHelpText(
  'after',
  '\nOptional context (a "second brain") — enrich reviews with the repo\'s engineering\n' +
    'handbook + related systems. Off unless one of these is set:\n' +
    '  LGTM_BRAIN_CMD   command that prints context for a repo (any brain)\n' +
    '  LGTM_BRAIN_URL   a second-brain HTTP API\n' +
    '  LGTM_BRAIN_DIR   a second-brain vault on disk\n' +
    '\nModel calls run `claude --print` as a stripped session (no MCP servers, no settings or\n' +
    'CLAUDE.md from the cwd, no saved transcript) and record the billed usage per review:\n' +
    '  LGTM_MODEL                    model id to review with (default: your ~/.claude/settings.json model)\n' +
    '  LGTM_EFFORT                   low|medium|high|xhigh|max (default: your settings effort for that model)\n' +
    '  LGTM_LATE_MODEL               model for late (round 4+) chill review rounds (default claude-sonnet-5; "off" = always the full model)\n' +
    '  LGTM_SESSIONS                 "off" = every round is a one-off call (default: one Claude session per loop, resumed each round for the prompt cache)\n' +
    '  LGTM_SIBLING_DIRS             colon-separated repos to also search for readers of what a diff writes (same as repeating --add-dir)\n' +
    '  LGTM_CLAUDE_SETTING_SOURCES   set to "user" if your settings.json carries auth/env routing lgtm must keep\n' +
    '  LGTM_DB_PATH                  where the review log lives (default ~/.lgtm/reviews.db)\n'
);

program
  .command('review [pr-number]')
  .description('Review a pull request (or local working-tree changes with --local)')
  .option('-r, --repo <owner/repo>', 'GitHub repository (default: current repo)')
  .option('--local', 'Review local working-tree changes vs a base ref (no GitHub PR; never posts)', false)
  .option('--base <ref>', 'Base ref for --local mode (default: auto-detected default branch)')
  .option('--scope <text>', 'What this change is meant to do — out-of-scope quality issues become SUGGESTION follow-ups (genuine bugs/security are still flagged)')
  .option('--decided <file>', 'JSON file of previously-dismissed findings ({file?,line?,title,reason}[]) the reviewer must not re-raise (findings dismissed with `lgtm dismiss` are injected automatically)')
  .option('--override <reason>', `Run a round past the ${ROUND_BUDGET}-round budget; the reason is recorded with the round`)
  .option('--model <id>', 'Model to review with (default: your settings model; late chill rounds use LGTM_LATE_MODEL, claude-sonnet-5, unless set to off)')
  .option('--fresh', 'Start a new loop session instead of continuing the existing one (LGTM_SESSIONS=off disables sessions entirely)', false)
  .option('--add-dir <path>', 'Also search this directory for readers of what the diff writes (repeatable; LGTM_SIBLING_DIRS does the same)', (v: string, acc: string[]) => [...acc, v], [])
  .option('--no-readers', 'Skip the readers-of-what-this-writes search (on by default)')
  .option('-a, --ai <provider>', 'AI provider: claude, codex (default: auto-detect)')
  .option('-H, --harshness <level>', 'Review harshness: chill, medium, pedantic', 'medium')
  .option('--dry-run', 'Show comments without posting', false)
  .option('--batch', 'Post all comments without prompting', false)
  .option('--auto', 'Non-interactive mode for agents: implies --batch, outputs JSON to stdout', false)
  .option('--agent', 'Agent mode: max context, read-only, returns ALL findings as JSON (never posts)', false)
  .option('--full-context', 'Include full file contents for pattern analysis', false)
  .option('--usage-context', 'Include files that use changed symbols', false)
  .option('--related-files', 'Include related files (imports, callers, tests, infra) discovered via static analysis', false)
  .option('--max-context', 'Shorthand: enables --full-context, --usage-context, and --related-files', false)
  .option('--no-charter', 'Skip the ARCHITECTURE.md charter conformance context (on by default when the repo has one)')
  .option('--no-standards', 'Skip the STANDARDS.md engineering-standards check (on by default when the repo has one)')
  .addOption(new Option('--context', 'deprecated alias for --related-files').default(false).hideHelp())
  .action(async (prNumberStr: string | undefined, options, command) => {
    const agent = options.agent;
    const local = options.local;
    // Whether -H was given: a late round of a settled loop drops to chill by itself otherwise.
    const harshnessExplicit = command.getOptionValueSource('harshness') !== 'default';
    // Agent mode is built on top of auto mode: same suppressed-output + JSON-to-stdout
    // machinery, but read-only and with a richer findings-focused payload.
    const auto = options.auto || agent;

    // Helper for validation errors: emit JSON in agent/auto mode, plain text otherwise
    function exitWithError(message: string): never {
      if (agent) {
        console.log(formatAgentResult({ success: false, error: message, summary: '', comments: [] }));
      } else if (auto) {
        console.log(formatAutoResult({ success: false, error: message, dryRun: options.dryRun ?? false, summary: '', commentsPosted: 0, duplicatesSkipped: 0, comments: [] }));
      } else {
        console.error(chalk.red(message));
      }
      process.exit(1);
    }

    // PR number is required unless we're in --local mode (which reviews the working tree).
    let prNumber = 0;
    if (!local) {
      prNumber = parseInt(prNumberStr ?? '', 10);
      if (isNaN(prNumber)) {
        exitWithError('Invalid PR number (or pass --local to review working-tree changes)');
      }
    }

    // Resolve the base ref for local mode up front so a bad base fails fast.
    let base: string | undefined;
    if (local) {
      try {
        base = options.base || detectDefaultBase();
      } catch (e: any) {
        exitWithError(e?.message ?? String(e));
      }
    }

    const harshness = options.harshness as Harshness;
    if (!['chill', 'medium', 'pedantic'].includes(harshness)) {
      exitWithError('Invalid harshness level. Use: chill, medium, pedantic');
    }

    const ai = resolveProvider(options.ai, exitWithError);

    const batch = auto || options.batch;
    if (options.model && !isModelId(options.model)) exitWithError(`--model ${JSON.stringify(options.model)} is not a model id`);

    // A plain interactive `review` drives an arrow-key selector via prompts(). If stdin isn't
    // a real terminal (piped, CI, or run from inside another tool/agent), that selector prints
    // its escape codes and then blocks forever waiting for keypresses that can never arrive —
    // the "hang with no interface". Degrade to read-only so we still show the findings and exit
    // cleanly. Explicit non-interactive modes (--auto/--agent/--batch/--dry-run) are untouched,
    // and --local is skipped — it never posts under any flag, so the "to post…" hint would just
    // mislead (its read-only path already prints findings without prompting).
    let dryRun = Boolean(options.dryRun);
    if (!local && !auto && !batch && !dryRun && !process.stdin.isTTY) {
      console.error(chalk.yellow(
        '⚠  stdin is not an interactive terminal — showing findings read-only (nothing will be posted).\n' +
        '   To post, rerun in a terminal, or use --batch (post all) / --auto / --agent (JSON output).'
      ));
      dryRun = true;
    }

    // Back-compat: --context is the deprecated name for --related-files.
    if (options.context && !options.relatedFiles) {
      console.error(chalk.yellow('⚠  --context is deprecated; use --related-files instead.'));
    }
    // --max-context (and --agent, which always runs with max context) turn on all
    // three individual context flags.
    const fullContext = options.fullContext || options.maxContext || agent;
    const usageContext = options.usageContext || options.maxContext || agent;
    const relatedFiles = options.relatedFiles || options.context || options.maxContext || agent;

    // Previously-dismissed findings for the fix-review loop (--decided). Best-effort: a bad or
    // missing file must not kill the review.
    let decided: DecidedFinding[] | undefined;
    if (options.decided) {
      try {
        const parsed = JSON.parse(readFileSync(options.decided, 'utf-8'));
        if (Array.isArray(parsed)) {
          decided = parsed.filter((d: any) => d && typeof d.title === 'string' && typeof d.reason === 'string');
        } else {
          console.error(chalk.yellow('⚠  Ignoring --decided file (expected a JSON array)'));
        }
      } catch (e: any) {
        // Warn on stderr even in auto/agent mode — stderr isn't part of the stdout JSON contract, so an
        // agent driving the loop can still see that its dismissed-findings feedback was dropped.
        console.error(chalk.yellow(`⚠  Ignoring --decided file (${e?.message ?? e})`));
      }
    }

    // The loop's own memory, applied before any model call is paid for.
    const memory = applyLoopMemory({ repo: options.repo, local, prNumber, agent, scope: options.scope, decided, overrideReason: options.override, exitWithError });
    const scope = memory.scope;
    decided = memory.decided;
    const overrideReason: string | undefined = options.override;

    try {
      await runReview({
        prNumber,
        repo: options.repo,
        local,
        base,
        harshness,
        dryRun,
        batch,
        auto,
        agent,
        fullContext,
        usageContext,
        relatedFiles,
        ai,
        scope,
        decided,
        overrideReason,
        pr: memory.pr,
        explicitModel: options.model,
        harshnessExplicit,
        fresh: options.fresh,
        addDirs: options.addDir ?? [],
        readersEnabled: options.readers !== false,
        policy: memory.policy,
        charterEnabled: options.charter !== false,
        standardsEnabled: options.standards !== false,
      });
    } catch (error: any) {
      if (agent) {
        try {
          console.log(formatAgentResult({ success: false, error: error?.message ?? String(error), summary: '', comments: [] }));
        } catch {
          console.log(JSON.stringify({ success: false, mode: 'agent', error: String(error), summary: '', posted: false, commentsFound: 0, duplicates: 0, comments: [] }));
        }
      } else if (auto) {
        // Auto-mode error contract: JSON with success:false goes to stdout so consumers
        // can parse it via $(lgtm review ... --auto). Note: subprocess stderr (e.g. from
        // gh CLI) may still leak to stderr — consumers should use 2>/dev/null if needed.
        try {
          console.log(formatAutoResult({ success: false, error: error?.message ?? String(error), dryRun: options.dryRun ?? false, summary: '', commentsPosted: 0, duplicatesSkipped: 0, comments: [] }));
        } catch {
          // Fallback if formatAutoResult itself throws (e.g., unexpected error shape)
          console.log(JSON.stringify({ success: false, error: String(error), dryRun: false, commentsPosted: 0, duplicatesSkipped: 0, summary: '', comments: [] }));
        }
      } else {
        console.error(chalk.red(`Error: ${error?.message ?? String(error)}`));
      }
      process.exit(1);
    }
  });

interface RunOptions {
  prNumber: number;
  repo?: string;
  local: boolean;
  base?: string;
  harshness: Harshness;
  dryRun: boolean;
  batch: boolean;
  auto: boolean;
  agent: boolean;
  fullContext: boolean;
  usageContext: boolean;
  relatedFiles: boolean;
  ai: AIProvider;
  scope?: string;
  decided?: DecidedFinding[];
  overrideReason?: string;
  /** PR details already fetched by the pre-flight, so runReview need not fetch them again. */
  pr?: PRDetails;
  /** `--model`, verbatim. */
  explicitModel?: string;
  /** False when -H was not given, so the round policy may lower it on a late, settled round. */
  harshnessExplicit?: boolean;
  /** `--fresh`: do not continue the loop's session. */
  fresh?: boolean;
  /** Extra roots to search for readers of what the diff writes. */
  addDirs?: string[];
  readersEnabled?: boolean;
  /**
   * What the round policy needs from the log; absent when the log was unavailable.
   * `loopRound` counts the whole current run (local + PR), which is what the policy keys on.
   */
  policy?: { loopRound: number; openBugs: number; lastDiffLines: number | null; session: LoopSession | null };
  charterEnabled: boolean;
  standardsEnabled: boolean;
}

/**
 * The loop's memory, applied BEFORE any model call is paid for: inherit the scope the
 * last round stated (required on an agent-mode loop's first scoped round), hand the
 * reviewer every dismissal recorded so far, and refuse a round past the budget unless a
 * reason is given (and recorded). The log must never block a review — if it cannot be
 * read, the round runs stateless with a warning.
 */
function applyLoopMemory(opts: {
  repo?: string;
  local: boolean;
  prNumber: number;
  agent: boolean;
  scope?: string;
  decided?: DecidedFinding[];
  overrideReason?: string;
  exitWithError: (message: string) => never;
}): { scope?: string; decided?: DecidedFinding[]; pr?: PRDetails; policy?: RunOptions['policy'] } {
  const { repo, local, prNumber, agent, overrideReason, exitWithError } = opts;
  let { scope, decided } = opts;
  let pr: PRDetails | undefined;
  let repoName: string;
  let roundKey: string;
  let ctx: ReturnType<typeof loopContext>;
  let summary: ReturnType<typeof getLoopSummary>;
  try {
    ({ repoName, roundKey } = loopIdentity(repo, local, prNumber));
    // For a PR, the branch's --local rounds are the first half of this loop. The
    // details fetched here are handed on so the review does not fetch them twice.
    if (!local) {
      try { pr = getPRDetails(prNumber, repo); } catch { /* memory then covers the PR key only */ }
    }
    // Every read of the log happens here, inside the guard: a busy or unreadable
    // store degrades to a stateless round, never a failed one.
    ctx = loopContext(repoName, roundKey, pr?.headRef);
    summary = getLoopSummary(repoName, roundKey, pr?.headRef);
  } catch (e: any) {
    console.error(chalk.yellow(`⚠  loop memory unavailable (${e?.message ?? e}); running without it`));
    return { scope, decided, pr };
  }
  if (!scope && ctx.lastScope) {
    scope = ctx.lastScope;
    console.error(chalk.gray(`↩  --scope inherited from ${ctx.scopeFrom}: "${scope.slice(0, 80)}${scope.length > 80 ? '…' : ''}"`));
  }
  if (agent && !scope) {
    exitWithError(
      `--scope is required in agent mode: no round of ${roundKey} has recorded one yet (this would be round ${ctx.nextRound}). ` +
        'Say what this change is meant to do; later rounds inherit it.'
    );
  }
  if (ctx.dismissed.length > 0) {
    const have = new Set((decided ?? []).map((d) => `${d.file ?? '*'}#${d.title.toLowerCase()}`));
    const extra = ctx.dismissed.filter((d) => !have.has(`${d.file}#${d.title.toLowerCase()}`));
    decided = [...(decided ?? []), ...extra];
    if (extra.length > 0) console.error(chalk.gray(`↩  ${extra.length} dismissal(s) from earlier rounds injected`));
  }
  // The budget counts the whole loop — the branch's local rounds and the PR's — since
  // its last 7-day gap; a PR round is not a fresh start after eight local ones.
  if (summary.budgetUsed >= ROUND_BUDGET && !overrideReason) {
    const advice = stopAdvice(summary.budgetUsed, summary.lastBugRound, summary.cleanRounds, summary.lastRoundEmpty);
    exitWithError(
      `This would be round ${summary.budgetUsed + 1} of the loop behind ${roundKey} (${summary.budgetUsed} used of the ${ROUND_BUDGET}-round budget; ${advice.reason}). ` +
        `File what is left as follow-ups, or rerun with --override "<why this loop must continue>". See: lgtm rounds ${local ? '--local' : prNumber}`
    );
  }
  return { scope, decided, pr, policy: { loopRound: summary.budgetUsed + 1, openBugs: summary.openBugs, lastDiffLines: summary.lastDiffLines, session: ctx.session } };
}

/** Added + removed lines in a unified diff — the size the round policy compares between rounds. */
function countDiffLines(diff: string): number {
  let n = 0;
  for (const line of diff.split('\n')) {
    // File headers are `+++ a/…` / `--- b/…` (with a space); a removed `-- comment` or an added `++i;` is a real line.
    if ((line.startsWith('+') && !line.startsWith('+++ ')) || (line.startsWith('-') && !line.startsWith('--- '))) n++;
  }
  return n;
}

/**
 * One identity per loop: the repo (the --repo slug, else the checkout's slug, else its
 * path) and the round key (`pr:<n>`, or `local:<branch>` for a working-tree review).
 */
function loopIdentity(repo: string | undefined, local: boolean, prNumber: number): { repoName: string; roundKey: string } {
  const repoName = repo || getCurrentRepoSlug() || getRepoRoot();
  const roundKey = local ? `local:${getCurrentBranch()}` : `pr:${prNumber}`;
  return { repoName, roundKey };
}



function formatAutoResult(options: {
  success: boolean;
  summary: string;
  commentsPosted: number;
  duplicatesSkipped?: number;
  dryRun?: boolean;
  comments: ReviewComment[];
  error?: string;
}): string {
  return JSON.stringify({
    success: options.success,
    summary: options.summary,
    dryRun: options.dryRun ?? false,
    commentsPosted: options.commentsPosted,
    duplicatesSkipped: options.duplicatesSkipped ?? 0,
    comments: options.comments.map(c => ({ file: c.file, line: c.line, severity: c.severity, title: c.title, body: c.body, suggestion: c.suggestion })),
    ...(options.error ? { error: options.error } : {}),
  });
}

// A finding plus whether it duplicates a comment already on the PR, and its id in the
// review log (so `lgtm dismiss <id>` can settle it) when the log recorded it.
type AnnotatedComment = ReviewComment & { duplicate: boolean; id?: number };

/**
 * Agent-mode payload. Unlike formatAutoResult (which reports what was *posted*),
 * this reports every finding the review produced — read-only — so an agent has the
 * full picture. Duplicates of existing PR comments are flagged, not dropped.
 */
function formatAgentResult(options: {
  success: boolean;
  summary: string;
  comments: AnnotatedComment[];
  relatedFiles?: { path: string; reason: string }[];
  tokenEstimate?: number;
  usage?: AIUsage;
  loop?: LoopState | null;
  recovered?: boolean;
  error?: string;
}): string {
  const duplicates = options.comments.filter(c => c.duplicate).length;
  const u = options.usage;
  return JSON.stringify({
    success: options.success,
    mode: 'agent',
    summary: options.summary,
    posted: false,
    // True when the model's JSON was salvaged via jsonrepair — the review may be partial
    // (e.g. a truncated final finding), so a driving agent should treat it with suspicion.
    recovered: options.recovered ?? false,
    commentsFound: options.comments.length,
    duplicates,
    comments: options.comments.map(c => ({
      id: c.id ?? null,
      // Triage fields first: what kind of problem, how sure the reviewer is, and the one
      // check that settles it — read these before the body.
      kind: c.kind ?? 'added',
      confidence: c.confidence ?? 'medium',
      how_to_verify: c.how_to_verify ?? null,
      evidence: c.evidence ?? [],
      file: c.file,
      line: c.line,
      severity: c.severity,
      title: c.title,
      body: c.body,
      suggestion: c.suggestion,
      fingerprint: c.fingerprint ?? null,
      duplicate: c.duplicate,
    })),
    context: {
      maxContext: true,
      relatedFiles: (options.relatedFiles ?? []).map(f => ({ path: f.path, reason: f.reason })),
      tokenEstimate: options.tokenEstimate ?? 0,
      // What the provider billed for this run — tokenEstimate above is only the diff+context size.
      usage: u && u.measured && u.calls > 0
        ? { promptTokens: promptTokens(u), cacheReadTokens: u.cacheReadTokens, outputTokens: u.outputTokens, costUsd: u.costUsd, durationMs: u.durationMs, models: u.models }
        : null,
    },
    // Where this run sits in its fix→review loop, from the log: the round number, what
    // became of last round's findings, and the last round that found a BUG/SECURITY —
    // the inputs to the stopping rule ("no BUG/SECURITY for two rounds ⇒ stop").
    loop: options.loop ?? null,
    ...(options.error ? { error: options.error } : {}),
  });
}

/** The loop facts an agent-mode caller sees; null fields mean the log could not say. */
interface LoopState {
  mode: 'pr' | 'local';
  key: string;
  round: number;
  /** What became of earlier rounds' findings; null when this round could not judge (round 1, salvaged JSON, unchanged diff). */
  previous: DispositionSummary | null;
  lastBugRound: number | null;
  roundsSinceBug: number | null;
  /** The stopping rule, from the log. */
  advice: StopAdvice;
  budget: { limit: number; overrideReason: string | null };
  /** Ids of this round's findings, in output order — `lgtm dismiss <id> --reason …` settles one. */
  findingIds: number[];
  /** Which model this round ran on and why (`null` model = the operator's default, the full model). */
  model: { id: string | null; reason: string } | null;
}

/**
 * Best-effort metrics logging for a completed review: the review row (with measured
 * usage drained from the AI ledger), one row per finding, and the disposition of the
 * previous round's findings now that this round has run. Local rounds are logged too,
 * keyed on the branch, so a pre-PR loop is as visible as a PR one. Never throws.
 */
function recordReviewMetrics(opts: {
  repo?: string;
  prNumber: number;
  diff: string;
  expanded: { path: string; reason: string; content: string }[];
  relatedFiles: boolean;
  ai: AIProvider;
  local?: boolean;
  /** Deferred so a failing gh/git call lands inside the never-throws guard, not before it. */
  filesReviewed: () => number;
  harshness: Harshness;
  comments: ReviewComment[];
  decided?: DecidedFinding[];
  /** True when the model's JSON was salvaged — the list may be missing its tail. */
  recovered?: boolean;
  /** The branch under review: the PR's head, or the checkout's for --local. */
  branch?: string;
  scope?: string;
  overrideReason?: string;
  diffLines?: number;
  modelChoice?: RoundModelChoice;
  /** Set when the round produced no review — the error text. The row is logged; nothing is judged. */
  failed?: string;
  sessionId?: string;
  fileShas?: Record<string, string>;
  modelRole?: string;
}): { tokenEstimate: number; usage: AIUsage; loop: LoopState | null } {
  const { repo, prNumber, diff, expanded, relatedFiles, ai, local, filesReviewed, harshness, comments, decided, recovered, branch, scope, overrideReason, diffLines, modelChoice, failed, sessionId, fileShas, modelRole } = opts;
  let tokenEstimate = Math.ceil(diff.length / 4);
  for (const file of expanded) {
    tokenEstimate += Math.ceil(file.content.length / 4);
  }
  const usage = takeUsage();
  // A failure before any model call (a session the CLI could not find) spent nothing:
  // there is no round to record and no budget slot to charge.
  if (failed && (usage.calls === 0 || (usage.measured && promptTokens(usage) === 0 && usage.costUsd === 0))) {
    return { tokenEstimate, usage, loop: null };
  }
  let loop: LoopState | null = null;
  try {
    // Rows logged before the slug became the key used the path; `rounds` reads both.
    const { repoName, roundKey } = loopIdentity(repo, Boolean(local), prNumber);
    const mode: 'pr' | 'local' = local ? 'local' : 'pr';
    const diffSha = createHash('sha1').update(diff).digest('hex');
    const { id: reviewId, round: allocated } = logReview({
      repo: repoName,
      prNumber: local ? 0 : prNumber,
      reviewedAt: new Date().toISOString(),
      filesReviewed: filesReviewed(),
      contextFilesAdded: expanded.length,
      contextReasons: JSON.stringify(expanded.map(f => f.reason)),
      tokenCount: tokenEstimate,
      model: ai,
      usedContextExpansion: relatedFiles && expanded.length > 0,
      falseNegative: false,
      usage,
      mode,
      roundKey,
      harshness,
      diffSha,
      branch: branch || (local ? getCurrentBranch() : undefined),
      scope,
      overrideReason,
      recovered,
      diffLines,
      modelReason: modelChoice && ai === 'claude' ? modelChoice.reason : undefined,
      failed: Boolean(failed),
      sessionId,
      fileShas,
      modelRole,
    });
    const round = allocated ?? 1;
    if (failed) return { tokenEstimate, usage, loop: null };
    const findingIds = logFindings(reviewId, repoName, roundKey, round, comments);
    // The log decides whether this round can judge earlier ones (round 1, salvaged
    // output, unchanged code) — null means it could not.
    const previous = disposePreviousRound(repoName, roundKey, round, comments, { decided, harshness, diffSha, recovered, branch: local ? undefined : branch });
    const summary = getLoopSummary(repoName, roundKey, branch);
    loop = {
      mode,
      key: roundKey,
      round,
      previous,
      lastBugRound: summary.lastBugRound,
      roundsSinceBug: summary.lastBugRound === null ? null : round - summary.lastBugRound,
      advice: stopAdvice(round, summary.lastBugRound, summary.cleanRounds, summary.lastRoundEmpty),
      budget: { limit: ROUND_BUDGET, overrideReason: overrideReason ?? null },
      findingIds,
      model: modelChoice && ai === 'claude' ? { id: modelChoice.model ?? null, reason: modelChoice.reason } : null,
    };
  } catch (e) {
    // Metrics logging is non-critical — don't fail the review.
    process.stderr.write(`Warning: metrics logging failed: ${e}\n`);
  }
  return { tokenEstimate, usage, loop };
}

async function runReview(options: RunOptions): Promise<void> {
  const { prNumber, repo, local, base, dryRun, batch, auto, agent, fullContext, usageContext, relatedFiles, ai, scope, decided, overrideReason, explicitModel, harshnessExplicit, fresh, addDirs, readersEnabled, policy, charterEnabled, standardsEnabled } = options;
  let harshness = options.harshness;
  // The loop chooses harshness too: a late round with no unverified BUG/SECURITY is
  // asking "is it safe now?", which is chill's question — unless -H said otherwise.
  if (!harshnessExplicit && policy && policy.loopRound >= LATE_ROUND && policy.openBugs === 0 && harshness !== 'chill') {
    harshness = 'chill';
    const line = `↓  harshness: chill — round ${policy.loopRound} of the loop with no BUG/SECURITY open (pass -H to override)`;
    if (auto) console.error(chalk.gray(line)); else console.log(chalk.gray(line));
  }

  // In auto mode, suppress decorative output — only JSON goes to stdout.
  // Note: these wrappers suppress our own output but cannot capture stderr from
  // subprocesses (e.g. gh CLI). Consumers should use 2>/dev/null if needed.
  const log = auto ? (..._args: any[]) => {} : console.log;
  const logErr = auto ? (..._args: any[]) => {} : console.error;

  // Data sourcing: --local reads the working tree via git; otherwise the GitHub PR.
  const changedFilesOf = (): string[] => (local ? getLocalChangedFiles(base!) : getChangedFiles(prNumber, repo));
  const fileContentOf = (file: string): string | null => (local ? getLocalFileContent(file) : getFileContent(prNumber, file, repo));

  // Fetch details
  log(chalk.blue(`\n🔍 ${local ? `Analysing local changes (vs ${base})` : `Fetching PR #${prNumber}`}...`));
  const pr = local ? getLocalDetails(base!) : (options.pr ?? getPRDetails(prNumber, repo));
  log(chalk.white(`   "${pr.title}" by ${pr.author}`));
  log(chalk.gray(`   ${pr.changedFiles} files, +${pr.additions}/-${pr.deletions}`));

  // Fetch diff
  log(chalk.blue(`\n📄 ${local ? 'Computing local diff' : 'Fetching diff'}...`));
  const diff = local ? getLocalDiff(base!) : getPRDiff(prNumber, repo);

  // Truncate very large diffs
  const maxDiffLength = 50000;
  const truncatedDiff = diff.length > maxDiffLength
    ? diff.slice(0, maxDiffLength) + '\n... (diff truncated)'
    : diff;

  // Fetch full file contents if requested
  let fileContents: Record<string, string> | undefined;
  if (fullContext) {
    log(chalk.blue(`\n📁 Fetching full file contents...`));
    const changedFiles = changedFilesOf();
    fileContents = {};
    for (const file of changedFiles) {
      // Skip very large files and non-code files
      if (file.endsWith('.lock') || file.endsWith('.json') && file.includes('package-lock')) {
        continue;
      }
      const content = fileContentOf(file);
      if (content) {
        if (content.length > 300000) { // Skip files > 300KB
          log(chalk.yellow(`   ⊘ ${file} (too large: ${Math.round(content.length / 1024)}KB)`));
        } else {
          fileContents[file] = content;
          log(chalk.gray(`   ✓ ${file} (${Math.round(content.length / 1024)}KB)`));
        }
      }
    }
  }

  // Extract usage context if requested
  let usageContextStr = '';
  if (usageContext) {
    log(chalk.blue(`\n🔗 Finding symbol usages...`));
    const symbols = extractChangedSymbols(diff);
    log(chalk.gray(`   Found ${symbols.length} changed symbol(s): ${symbols.map(s => s.name).join(', ') || '(none)'}`));

    if (symbols.length > 0) {
      const repoRoot = getRepoRoot();
      const usages = findUsages(symbols, repoRoot, {
        maxUsagesPerSymbol: 5,
        contextLines: 3
      });

      if (usages.length > 0) {
        log(chalk.gray(`   Found ${usages.length} usage(s) across ${new Set(usages.map(u => u.file)).size} file(s)`));
        usageContextStr = formatUsageContext(usages);
      } else {
        log(chalk.gray(`   No external usages found`));
      }
    }
  }

  // Auto-expand context if requested. Related files come back with absolute paths;
  // everything downstream (the prompt heading and the session's file keys) uses the
  // repo-relative form, so the same file is one identity in both.
  const repoRootForKeys = getRepoRoot();
  const relKey = (p: string) => (p.startsWith('/') && p.startsWith(repoRootForKeys) ? relative(repoRootForKeys, p) : p);
  let expandedContextStr = '';
  let expanded: { path: string; reason: string; content: string }[] = [];
  if (relatedFiles) {
    log(chalk.blue(`\n📚 Finding related files (static analysis)...`));
    const changedFiles = changedFilesOf();
    const repoRoot = getRepoRoot();
    expanded = await expandContext(changedFiles, repoRoot, {
      maxFiles: 20,
      importDepth: 3,
    });
    // Path order, not discovery order: the same set of files must render identically
    // from one round to the next or the prompt cache never matches past this point.
    expanded.sort((a, b) => a.path.localeCompare(b.path));

    if (expanded.length > 0) {
      log(chalk.gray(`   Found ${expanded.length} context file(s):`));
      let tokenEstimate = 0;
      expandedContextStr = `\n## Expanded Context (Auto-discovered)\n`;
      expandedContextStr += `The following files were automatically discovered as relevant context:\n\n`;
      for (const file of expanded) {
        log(chalk.gray(`   • ${relKey(file.path)} (${file.reason})`));
        expandedContextStr += `### ${relKey(file.path)}\n`;
        expandedContextStr += `_Reason: ${file.reason}_\n\n`;
        expandedContextStr += `\`\`\`\n${file.content}\n\`\`\`\n\n`;
        tokenEstimate += Math.ceil(file.content.length / 4);
      }
      log(chalk.gray(`   Estimated tokens: ~${tokenEstimate}`));
    } else {
      log(chalk.gray(`   No additional context found`));
    }
  }

  // Who READS what this diff writes — the question a diff review structurally cannot
  // answer, because the reader never appears in the diff (DWLF-127's Telegram alerts,
  // indicators' pivotTime sort key). Deterministic: identifiers out, grep in.
  let readersContextStr = '';
  if (readersEnabled !== false) {
    const identifiers = mergeIdentifiers(extractWriteIdentifiers(diff), fieldsFromHelpers(diff, getRepoRoot()));
    if (identifiers.length > 0) {
      const repoRootForReaders = getRepoRoot();
      const { roots, missing } = searchRoots(repoRootForReaders, addDirs ?? []);
      for (const m of missing) console.error(chalk.yellow(`⚠  --add-dir/LGTM_SIBLING_DIRS names ${m}, which does not exist — its readers were NOT searched.`));
      const changedAbs = changedFilesOf().map((f) => (f.startsWith('/') ? f : `${repoRootForReaders}/${f}`));
      const hits = findReaders(identifiers, roots, { changedFiles: changedAbs });
      readersContextStr = formatReadersContext(hits, repoRootForReaders);
      if (hits.length > 0) {
        log(chalk.blue(`\n📡 Readers of what this diff writes:`));
        // The same foreign test the prompt uses — the carried root, not a path prefix.
        for (const h of hits) log(chalk.gray(`   • ${h.identifier} ← ${h.root === repoRootForReaders ? relative(repoRootForReaders, h.file) : `${h.file} (another repo)`}`));
      }
      for (const f of failedSearchRoots()) console.error(chalk.yellow(`⚠  the reader search failed under ${f} — this review is blind to consumers there.`));
      if (hits.length > 0) {
        // reported above
      } else if (readersSearchRan()) {
        log(chalk.gray(`\n📡 Nothing outside the changed files reads what this diff writes (${identifiers.length} identifier(s) searched)`));
      } else {
        // Never report an absence the search could not have found: no rg, no grep, no answer.
        log(chalk.yellow(`\n📡 Could not search for readers — neither rg nor grep ran. This review is blind to who reads what it writes.`));
      }
    }
  }

  // Optional domain context from a local second-brain (opt-in via LGTM_BRAIN_DIR /
  // LGTM_BRAIN_URL). No-op — and silent — for anyone who hasn't configured one.
  const handbookContextStr = await fetchBrainContext(repo);
  if (handbookContextStr) {
    log(chalk.blue(`\n📖 Loaded engineering handbook context from second-brain`));
  }

  // In-repo architecture charter (ARCHITECTURE.md; optional brain fallback) — adds one
  // conformance check to the review. On by default when the repo has a charter;
  // --no-charter is the off switch. Full architecture altitude is `lgtm arch`.
  let charterContextStr = '';
  if (charterEnabled) {
    try {
      const repoRoot = charterRepoRoot(repo);
      const repoName = repo ? repo.split('/').pop() : repoRoot ? basename(repoRoot) : undefined;
      charterContextStr = (await buildArchitectureContext(repoRoot, repoName)).charterBlock;
    } catch { /* charter resolution must never block a review */ }
  }
  if (charterContextStr) {
    log(chalk.blue(`\n📐 Loaded architecture charter (conformance check enabled)`));
  }

  // In-repo engineering standards (STANDARDS.md) — up to three `(standard <id>)`
  // findings citing the repo's own adopted standards. Same leak guard as the
  // charter: with --repo pointing elsewhere, the cwd's STANDARDS.md must not apply.
  let standardsContextStr = '';
  if (standardsEnabled) {
    try {
      standardsContextStr = buildStandardsBlock(charterRepoRoot(repo)).block;
    } catch { /* standards resolution must never block a review */ }
  }
  if (standardsContextStr) {
    log(chalk.blue(`\n📏 Loaded engineering standards (STANDARDS.md check enabled)`));
  }

  // Which model this round runs on: --model, else the round policy (full model for
  // every first look; the cheaper model only on a late chill round of a settled diff).
  const diffLines = countDiffLines(diff);
  // The policy's round is the LOOP's round (local + PR rounds in the current run), not
  // the key's ordinal — a PR opened after five local rounds is on round six.
  const initialChoice: RoundModelChoice = pickRoundModel({
    explicit: explicitModel,
    provider: ai,
    round: policy?.loopRound ?? 1,
    harshness,
    openBugs: policy?.openBugs ?? 0,
    diffLines,
    lastDiffLines: policy?.lastDiffLines ?? null,
  });
  // The loop's session, if it can be continued (see planSession); the file set covers the
  // related files too, so a newly discovered import is sent to a resumed session.
  // Related files come back with absolute paths; key them like the changed files (repo-relative)
  // or the same file is hashed twice and "changed" forever.
  const contentsSeen: Record<string, string> = { ...(fileContents ?? {}) };
  for (const f of expanded) { const k = relKey(f.path); if (!(k in contentsSeen)) contentsSeen[k] = f.content; }
  // The stable prefix is fingerprinted like a file, under pseudo-paths: a charter edited
  // mid-loop reaches the resumed session as "updated context"; a changed system prompt
  // (lgtm upgraded) restarts the session, since the reviewer's rules themselves moved.
  contentsSeen[SYSTEM_PROMPT_KEY] = REVIEW_SYSTEM_PROMPT;
  if (charterContextStr) contentsSeen['@charter'] = charterContextStr;
  if (standardsContextStr) contentsSeen['@standards'] = standardsContextStr;
  if (handbookContextStr) contentsSeen['@handbook'] = handbookContextStr;
  const plan = planSession({ prior: policy?.session ?? null, contents: contentsSeen, ai, fresh, choice: initialChoice });
  const { fileShas } = plan;
  const sessionPlan = plan.session;
  let choice: RoundModelChoice = plan.choice;
  if (plan.note) { if (auto) console.error(chalk.gray(plan.note)); else log(chalk.gray(plan.note)); }
  // The model is an argument of each attempt, not hidden state the ladder has to reset;
  // `fresh` abandons the resumed session for ONE new one (minted once, so the schema retry
  // and the full-model fallback continue it rather than opening a third and fourth).
  // A holder rather than a `let`: the attempts assign it from inside `review`, and the
  // logging calls below read whichever session the last attempt actually used.
  const sessionUsed: { current: { id: string; resume: boolean } | null } = { current: null };
  // One session per RESTART REASON: a session abandoned because the loop's was gone must
  // not be the one the model fallback then resumes (its transcript is the cheaper model's).
  const freshSessions = new Map<string, { id: string; resume: boolean; changedSinceLast: Record<string, string>; unchangedFiles: string[] }>();
  const freshFor = (why: string) => {
    if (!sessionPlan) return null;
    if (!freshSessions.has(why)) freshSessions.set(why, { id: randomUUID(), resume: false, changedSinceLast: {}, unchangedFiles: [] });
    return freshSessions.get(why)!;
  };
  // Which session ids this process has already handed to the CLI. An attempt that opened
  // a session (even one whose reply was unusable) leaves it on disk, so every later rung
  // must --resume it rather than pass --session-id again, which the CLI refuses. The
  // session then already holds the full prompt, so resuming is also the cheap form.
  const started = new Set<string>();
  const review = (attempt: { enforceSchema?: boolean; model?: string; fresh?: string } = {}) => {
    if (ai === 'claude') setModelOverride(attempt.model);
    const planned = attempt.fresh ? freshFor(attempt.fresh) : sessionPlan;
    const session = planned ? { ...planned, resume: planned.resume || started.has(planned.id) } : null;
    sessionUsed.current = session ? { id: session.id, resume: session.resume } : null;
    if (session) started.add(session.id);
    return reviewPR(truncatedDiff, pr.title, pr.body, harshness, ai, fileContents, usageContextStr, expandedContextStr, handbookContextStr, {
      scope, decided, charter: charterContextStr, standards: standardsContextStr, enforceSchema: attempt.enforceSchema,
      readersContext: readersContextStr,
      session: session ? { ...session, round: policy?.loopRound ?? 1 } : undefined,
    });
  };
  if (sessionPlan) {
    const line = sessionPlan.resume
      ? `⟳  session: continuing ${sessionPlan.id.slice(0, 8)} — ${Object.keys(sessionPlan.changedSinceLast).length} file(s) changed since last round, ${sessionPlan.unchangedFiles.length} unchanged`
      : `⟳  session: new ${sessionPlan.id.slice(0, 8)} for this loop`;
    if (auto) console.error(chalk.gray(line)); else log(chalk.gray(line));
  }
  // The failed attempt's model choice is passed in, not closed over: the recovery ladder
  // changes the choice between attempts and the row must name the model that actually failed.
  const logFailedRound = (why: string, attempted: RoundModelChoice) => recordReviewMetrics({
    repo, prNumber, diff, expanded, relatedFiles, ai, local,
    filesReviewed: () => changedFilesOf().length, harshness, comments: [], decided,
    branch: local ? undefined : pr.headRef, scope, overrideReason, diffLines, modelChoice: attempted, failed: why,
    sessionId: sessionUsed.current?.id, fileShas, modelRole: modelRoleOf(attempted),
  });
  let result: Awaited<ReturnType<typeof review>>;
  let freshReason: string | undefined;
  ({ result, choice, freshReason } = await reviewWithRecovery({ review, ai, choice, initialChoice, resuming: Boolean(sessionPlan?.resume), logFailedRound, say: (line) => (auto ? console.error(chalk.yellow(line)) : log(chalk.yellow(line))) }));
  if (freshReason) choice = { ...choice, reason: `${freshReason} (${choice.reason})` };

  log(chalk.gray(`\n${result.summary}\n`));

  // Log the round NOW, before any output or posting branch: every path below (agent,
  // local, dry-run, nothing-to-post, cancelled) is a review that happened and costs
  // the same to have run. Non-critical, never throws.
  const metrics = recordReviewMetrics({
    repo, prNumber, diff, expanded, relatedFiles, ai, local,
    filesReviewed: () => changedFilesOf().length, harshness, comments: result.comments, decided, recovered: result.recovered,
    branch: local ? undefined : pr.headRef, scope, overrideReason, diffLines, modelChoice: choice,
    sessionId: sessionUsed.current?.id, fileShas, modelRole: modelRoleOf(choice),
  });
  // The stopping rule, said out loud every round — on stderr in agent mode so the
  // stdout JSON contract is untouched, but a driving agent still sees it.
  if (metrics.loop) {
    const { advice, round } = metrics.loop;
    const line = `${advice.stop ? '🛑 STOP' : '↻'}  ${advice.reason}${round > ROUND_BUDGET ? ` (past the ${ROUND_BUDGET}-round budget)` : ''}`;
    if (auto) console.error(advice.stop ? chalk.yellow(line) : chalk.gray(line));
    else log(advice.stop ? chalk.yellow(`\n${line}`) : chalk.gray(`\n${line}`));
  }

  // Agent mode: read-only. Return EVERY finding (flagging duplicates of existing PR
  // comments) and never post. The agent decides what to do with the results.
  if (agent) {
    // Fetch existing comments only to flag duplicates — best-effort, non-critical.
    // Local mode has no PR, so there are no existing comments to dedupe against.
    let existingComments: ExistingReviewComment[] = [];
    if (!local) {
      try {
        existingComments = getExistingReviewComments(prNumber, repo);
      } catch {
        // If we can't fetch existing comments, return findings without duplicate flags.
      }
    }
    const annotated: AnnotatedComment[] = result.comments.map((comment, i) => ({
      ...comment,
      duplicate: isDuplicateComment(comment, existingComments),
      id: metrics.loop?.findingIds[i],
    }));

    console.log(formatAgentResult({
      success: true,
      summary: result.summary,
      comments: annotated,
      relatedFiles: expanded,
      tokenEstimate: metrics.tokenEstimate,
      usage: metrics.usage,
      loop: metrics.loop,
      recovered: result.recovered,
    }));
    return;
  }

  // Local mode is read-only — there is no PR to post to. Emit findings (JSON in auto mode,
  // a rendered list otherwise) and stop before any dedup/posting logic.
  if (local) {
    if (auto) {
      console.log(formatAutoResult({ success: true, dryRun: true, summary: result.summary, commentsPosted: 0, duplicatesSkipped: 0, comments: result.comments }));
      return;
    }
    if (result.comments.length === 0) {
      log(chalk.green('✓ LGTM — no issues found in local changes'));
      return;
    }
    log(chalk.white(`Found ${result.comments.length} finding(s) — local, read-only:\n`));
    for (let i = 0; i < result.comments.length; i++) {
      const comment = result.comments[i];
      const severityColor = SEVERITY_COLORS[comment.severity] || chalk.white;
      const severityIcon = SEVERITY_ICONS[comment.severity] || '•';
      log(chalk.white('─'.repeat(60)));
      log(
        chalk.white(`[${i + 1}/${result.comments.length}] `) +
        severityIcon + ' ' +
        severityColor(comment.severity) +
        chalk.gray(` | ${comment.file}:${comment.line}`)
      );
      log(chalk.white('─'.repeat(60)));
      log(chalk.bold(comment.title));
      log(chalk.white(comment.body));
      if (comment.suggestion) {
        log(chalk.green('\nSuggested fix:'));
        log(chalk.gray(comment.suggestion));
      }
      log();
    }
    return;
  }

  if (result.comments.length === 0) {
    if (auto) {
      console.log(formatAutoResult({ success: true, dryRun, summary: result.summary, commentsPosted: 0, duplicatesSkipped: 0, comments: [] }));
    } else {
      log(chalk.green('✓ LGTM — no issues found'));
    }
    return;
  }

  log(chalk.blue(`\n💬 Checking existing comments for duplicates...`));
  const existingComments = getExistingReviewComments(prNumber, repo);
  const commentsToReview = result.comments.filter((comment) => !isDuplicateComment(comment, existingComments));
  const duplicateCount = result.comments.length - commentsToReview.length;

  if (duplicateCount > 0) {
    log(chalk.yellow(`   Skipped ${duplicateCount} duplicate comment(s)`));
  }

  if (commentsToReview.length === 0) {
    if (auto) {
      console.log(formatAutoResult({ success: true, dryRun, summary: result.summary, commentsPosted: 0, duplicatesSkipped: duplicateCount, comments: [] }));
    } else {
      log(chalk.green('✓ All detected issues were already commented on'));
    }
    return;
  }

  log(chalk.white(`Found ${commentsToReview.length} potential comment(s):\n`));

  // Interactive selection
  const selectedComments: ReviewComment[] = [];

  for (let i = 0; i < commentsToReview.length; i++) {
    const comment = commentsToReview[i];
    const severityColor = SEVERITY_COLORS[comment.severity] || chalk.white;
    const severityIcon = SEVERITY_ICONS[comment.severity] || '•';

    log(chalk.white('─'.repeat(60)));
    log(
      chalk.white(`[${i + 1}/${commentsToReview.length}] `) +
      severityIcon + ' ' +
      severityColor(comment.severity) +
      chalk.gray(` | ${comment.file}:${comment.line}`)
    );
    log(chalk.white('─'.repeat(60)));
    log(chalk.bold(comment.title));
    log(chalk.white(comment.body));
    if (comment.suggestion) {
      log(chalk.green('\nSuggested fix:'));
      log(chalk.gray(comment.suggestion));
    }
    log();

    if (dryRun) {
      // In auto dry-run mode, collect comments into selectedComments so they appear in the JSON output.
      // In non-auto dry-run, we skip collection — the later "no comments" early return is fine
      // because interactive dry-run just prints each comment inline above.
      if (auto) {
        selectedComments.push(comment);
      }
      log(chalk.gray('(dry-run mode — not posting)\n'));
      continue;
    }

    if (batch) {
      selectedComments.push(comment);
      log(chalk.green('✓ Queued\n'));
      continue;
    }

    const response = await prompts({
      type: 'select',
      name: 'action',
      message: 'Action',
      choices: [
        { title: 'Add', value: 'add' },
        { title: 'Skip', value: 'skip' },
        { title: 'Quit', value: 'quit' },
      ],
    });

    if (response.action === 'quit') {
      log(chalk.yellow('\nQuitting review.'));
      break;
    }

    if (response.action === 'add') {
      selectedComments.push(comment);
      log(chalk.green('✓ Queued\n'));
    } else {
      log(chalk.gray('⊘ Skipped\n'));
    }
  }

  // Summary
  log(chalk.white('═'.repeat(60)));
  log(chalk.white(`Summary: ${selectedComments.length} to post, ${commentsToReview.length - selectedComments.length} skipped`));
  log(chalk.white('═'.repeat(60)));

  if (selectedComments.length === 0) {
    if (auto) {
      console.log(formatAutoResult({ success: true, dryRun, summary: result.summary, commentsPosted: 0, duplicatesSkipped: duplicateCount, comments: [] }));
    } else {
      log(chalk.gray('\nNo comments to post.'));
    }
    return;
  }

  if (dryRun) {
    if (auto) {
      console.log(formatAutoResult({
        success: true,
        dryRun: true,
        summary: result.summary,
        commentsPosted: 0,
        duplicatesSkipped: duplicateCount,
        comments: selectedComments,
      }));
    } else {
      log(chalk.yellow('\n(dry-run mode — skipping post)'));
    }
    return;
  }

  if (!batch) {
    // Confirm in interactive mode (skip in --batch mode for CI/non-interactive use)
    const confirm = await prompts({
      type: 'confirm',
      name: 'value',
      message: `Post ${selectedComments.length} comment(s) to PR #${prNumber}?`,
      initial: true,
    });

    if (!confirm.value) {
      log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  // Post comments
  log(chalk.blue('\n📤 Posting review...'));

  const formattedComments = selectedComments.map(c => {
    return {
      path: c.file,
      line: c.line,
      body: formatReviewCommentBody(c),
    };
  });

  // Save to local cache before attempting upload — so we can retry if it fails
  const repoForCache = repo || 'unknown';
  savePendingReview({
    prNumber,
    repo: repoForCache,
    createdAt: new Date().toISOString(),
    comments: formattedComments.map((c) => ({ file: c.path, line: c.line, body: c.body })),
  });

  let commentsPostedCount = 0;
  try {
    if (batch) {
      postBatchReview(prNumber, formattedComments, repo);
      commentsPostedCount = formattedComments.length;
    } else {
      for (const comment of formattedComments) {
        postReviewComment(prNumber, comment.path, comment.line, comment.body, repo);
        commentsPostedCount++;
      }
    }
  } catch (uploadError: any) {
    if (auto) {
      console.log(formatAutoResult({ success: false, error: uploadError?.message ?? String(uploadError), summary: result.summary, commentsPosted: commentsPostedCount, duplicatesSkipped: duplicateCount, comments: selectedComments.slice(0, commentsPostedCount) }));
    } else {
      logErr(chalk.red(`\n✗ Upload failed: ${uploadError?.message ?? String(uploadError)}`));
      log(chalk.yellow(`\n💾 Comments saved locally. Retry with:`));
      log(chalk.white(`   lgtm retry ${prNumber}${repo ? ` -r ${repo}` : ''}`));
    }
    process.exit(1);
  }

  // Upload succeeded — clean up the cache (non-critical)
  try { deletePendingReview(prNumber, repoForCache); } catch { /* ignore */ }

  if (auto) {
    console.log(formatAutoResult({
      success: true,
      dryRun,
      summary: result.summary,
      commentsPosted: commentsPostedCount,
      duplicatesSkipped: duplicateCount,
      comments: selectedComments,
    }));
  } else {
    log(chalk.green(`\n✓ Posted ${selectedComments.length} comment(s)`));
  }

}

program
  .command('recheck <pr-number>')
  .description('Check if existing review comments are still valid')
  .option('-r, --repo <owner/repo>', 'GitHub repository (default: current repo)')
  .option('-a, --ai <provider>', 'AI provider: claude, codex (default: auto-detect)')
  .option('--batch', 'Resolve all outdated/resolved comments without prompting', false)
  .option('--dry-run', 'Show results without resolving any comments', false)
  .option('--auto', 'Non-interactive mode for agents: implies --batch, outputs JSON to stdout', false)
  .option('--author <login>', 'Only recheck comments from a specific author')
  .action(async (prNumberStr: string, options) => {
    const auto = options.auto;

    function exitWithError(message: string): never {
      if (auto) {
        console.log(formatRecheckResult({ success: false, error: message, summary: '', dryRun: options.dryRun ?? false, stillValid: 0, resolved: 0, results: [] }));
      } else {
        console.error(chalk.red(message));
      }
      process.exit(1);
    }

    const prNumber = parseInt(prNumberStr, 10);
    if (isNaN(prNumber)) {
      exitWithError('Invalid PR number');
    }

    const ai = resolveProvider(options.ai, exitWithError);

    const batch = auto || options.batch;

    // Like `review`, interactive recheck prompts per comment. Non-TTY stdin can't drive
    // prompts() (it would hang), so fall back to read-only: show the recheck results and
    // resolve nothing. --auto/--batch/--dry-run stay non-interactive as chosen.
    let dryRun = Boolean(options.dryRun);
    if (!auto && !batch && !dryRun && !process.stdin.isTTY) {
      console.error(chalk.yellow(
        '⚠  stdin is not an interactive terminal — showing recheck results read-only (nothing will be resolved).\n' +
        '   To resolve, rerun in a terminal, or use --batch (resolve all) / --auto (JSON output).'
      ));
      dryRun = true;
    }

    try {
      await runRecheck({
        prNumber,
        repo: options.repo,
        ai,
        batch,
        auto,
        dryRun,
        author: options.author,
      });
    } catch (error: any) {
      if (auto) {
        console.log(formatRecheckResult({ success: false, error: error?.message ?? String(error), summary: '', dryRun: options.dryRun ?? false, stillValid: 0, resolved: 0, results: [] }));
      } else {
        console.error(chalk.red(`Error: ${error?.message ?? String(error)}`));
      }
      process.exit(1);
    }
  });

interface RecheckOptions {
  prNumber: number;
  repo?: string;
  ai: AIProvider;
  batch: boolean;
  auto: boolean;
  dryRun: boolean;
  author?: string;
}

const STATUS_COLORS: Record<string, (s: string) => string> = {
  still_valid: chalk.yellow,
  resolved: chalk.green,
  outdated: chalk.gray,
};

const STATUS_ICONS: Record<string, string> = {
  still_valid: '⚠',
  resolved: '✓',
  outdated: '♻',
};

function formatRecheckResult(opts: {
  success: boolean;
  summary: string;
  dryRun?: boolean;
  stillValid: number;
  resolved: number;
  failed?: number;
  results: { commentId: number; file: string; line: number | null; status: string; reason: string }[];
  error?: string;
}): string {
  return JSON.stringify({
    success: opts.success,
    summary: opts.summary,
    dryRun: opts.dryRun ?? false,
    stillValid: opts.stillValid,
    resolved: opts.resolved,
    failed: opts.failed ?? 0,
    results: opts.results,
    ...(opts.error ? { error: opts.error } : {}),
  });
}

async function runRecheck(options: RecheckOptions): Promise<void> {
  const { prNumber, repo, ai, batch, auto, dryRun, author } = options;

  // In auto mode, suppress decorative output — only JSON goes to stdout.
  const log = auto ? (..._args: any[]) => {} : console.log;
  const logErr = auto ? (..._args: any[]) => {} : console.error;

  // Fetch PR details
  log(chalk.blue(`\n🔍 Fetching PR #${prNumber}...`));
  const pr = getPRDetails(prNumber, repo);
  log(chalk.white(`   "${pr.title}" by ${pr.author}`));

  // Fetch existing comments
  log(chalk.blue(`\n💬 Fetching review comments...`));
  let comments = getPRComments(prNumber, repo);

  if (author) {
    comments = comments.filter(c => c.author === author);
    log(chalk.gray(`   Filtered to comments by ${author}`));
  }

  if (comments.length === 0) {
    if (auto) {
      console.log(formatRecheckResult({ success: true, summary: 'No review comments found', dryRun, stillValid: 0, resolved: 0, results: [] }));
    } else {
      log(chalk.green('\n✓ No review comments found on this PR.'));
    }
    return;
  }

  log(chalk.white(`   Found ${comments.length} review comment(s)`));

  // Fetch current diff
  log(chalk.blue(`\n📄 Fetching current diff...`));
  const diff = getPRDiff(prNumber, repo);
  const maxDiffLength = 50000;
  const truncatedDiff = diff.length > maxDiffLength
    ? diff.slice(0, maxDiffLength) + '\n... (diff truncated)'
    : diff;

  // Run AI recheck
  const aiLabel = ai === 'codex' ? 'Codex' : 'Claude';
  log(chalk.blue(`\n🤖 Rechecking comments with ${aiLabel}...`));
  const result = await recheckComments(truncatedDiff, pr.title, comments, ai);

  log(chalk.gray(`\n${result.summary}\n`));

  // Build a lookup from comment ID to the original comment
  const commentMap = new Map<number, ExistingComment>();
  for (const c of comments) {
    commentMap.set(c.id, c);
  }

  // Display results and collect comments to resolve
  const toResolve: ExistingComment[] = [];
  const stillValidIds: number[] = [];
  const recheckResults: { commentId: number; file: string; line: number | null; status: string; reason: string }[] = [];

  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    const comment = commentMap.get(r.commentId);
    if (!comment) continue;

    recheckResults.push({ commentId: r.commentId, file: comment.file, line: comment.line, status: r.status, reason: r.reason });

    const statusColor = STATUS_COLORS[r.status] || chalk.white;
    const statusIcon = STATUS_ICONS[r.status] || '•';

    log(chalk.white('─'.repeat(60)));
    log(
      chalk.white(`[${i + 1}/${result.results.length}] `) +
      statusIcon + ' ' +
      statusColor(r.status.replaceAll('_', ' ').toUpperCase()) +
      chalk.gray(` | ${comment.file}${comment.line ? ':' + comment.line : ''}`)
    );
    log(chalk.white('─'.repeat(60)));
    // Show a truncated version of the comment body
    const bodyPreview = comment.body.length > 200
      ? comment.body.slice(0, 200) + '...'
      : comment.body;
    log(chalk.dim(bodyPreview));
    log(chalk.white(`\nReason: ${r.reason}`));
    log();

    if (r.status === 'still_valid') {
      stillValidIds.push(r.commentId);
      continue;
    }

    // For resolved/outdated comments, offer to resolve them
    if (dryRun) {
      log(chalk.gray('(dry-run mode — not resolving)\n'));
      continue;
    }

    if (batch) {
      toResolve.push(comment);
      log(chalk.green('✓ Queued for resolution\n'));
      continue;
    }

    // Interactive mode
    const response = await prompts({
      type: 'select',
      name: 'action',
      message: 'Action',
      choices: [
        { title: 'Resolve (minimize comment)', value: 'resolve' },
        { title: 'Keep', value: 'keep' },
        { title: 'Quit', value: 'quit' },
      ],
    });

    if (response.action === 'quit' || !response.action) {
      log(chalk.yellow('\nQuitting recheck.'));
      break;
    }

    if (response.action === 'resolve') {
      toResolve.push(comment);
      log(chalk.green('✓ Queued for resolution\n'));
    } else {
      log(chalk.gray('⊘ Kept\n'));
    }
  }

  // Summary
  log(chalk.white('═'.repeat(60)));
  const kept = comments.length - stillValidIds.length - toResolve.length;
  log(chalk.white(`Summary: ${stillValidIds.length} still valid, ${toResolve.length} to resolve, ${kept} kept`));
  log(chalk.white('═'.repeat(60)));

  if (toResolve.length === 0) {
    if (auto) {
      console.log(formatRecheckResult({ success: true, dryRun, summary: result.summary, stillValid: stillValidIds.length, resolved: 0, results: recheckResults }));
    } else {
      log(chalk.gray('\nNo comments to resolve.'));
    }
    return;
  }

  if (dryRun) {
    if (auto) {
      console.log(formatRecheckResult({ success: true, dryRun: true, summary: result.summary, stillValid: stillValidIds.length, resolved: 0, results: recheckResults }));
    } else {
      log(chalk.yellow('\n(dry-run mode — skipping resolution)'));
    }
    return;
  }

  if (!batch) {
    // Confirm before resolving (skip in batch mode for non-interactive use)
    const confirm = await prompts({
      type: 'confirm',
      name: 'value',
      message: `Resolve (minimize) ${toResolve.length} comment(s) on PR #${prNumber}?`,
      initial: true,
    });

    if (!confirm.value) {
      log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  log(chalk.blue('\n📤 Resolving comments...'));
  let resolved = 0;
  let failed = 0;
  for (const comment of toResolve) {
    try {
      resolveComment(comment.nodeId);
      resolved++;
    } catch (error: any) {
      failed++;
      logErr(chalk.red(`   Failed to resolve comment ${comment.id}: ${error?.message ?? String(error)}`));
    }
  }

  if (auto) {
    console.log(formatRecheckResult({
      success: failed === 0,
      dryRun,
      summary: result.summary,
      stillValid: stillValidIds.length,
      resolved,
      failed: failed > 0 ? failed : undefined,
      results: recheckResults,
      error: failed > 0 ? `Failed to resolve ${failed} of ${toResolve.length} comment(s)` : undefined,
    }));
  } else {
    log(chalk.green(`\n✓ Resolved ${resolved} comment(s)`));
    if (failed > 0) {
      logErr(chalk.yellow(`   ⚠ ${failed} comment(s) failed to resolve`));
    }
  }
}

// Tag command: mark a PR as false negative
program
  .command('tag <repo> <pr>')
  .description('Tag a reviewed PR as a false negative (bug slipped through)')
  .action(async (repo: string, pr: string) => {
    const { tagFalseNegative } = await import('./db.js');
    const prNumber = parseInt(pr, 10);
    if (isNaN(prNumber)) {
      console.error(chalk.red('Invalid PR number'));
      process.exit(1);
    }
    const success = tagFalseNegative(repo, prNumber);
    if (success) {
      console.log(chalk.yellow(`Tagged ${repo}#${pr} as false negative`));
    } else {
      console.log(chalk.red(`No review found for ${repo}#${pr}`));
    }
  });

// Retry command: re-upload cached comments after a failed upload
program
  .command('retry [pr-number]')
  .description('Retry a previously failed comment upload')
  .option('-r, --repo <owner/repo>', 'GitHub repository (default: current repo)')
  .action(async (prNumberStr?: string, options?: { repo?: string }) => {
    const repo = options?.repo || 'unknown';

    // No PR number — list all pending
    if (!prNumberStr) {
      const pending = listPendingReviews();
      if (pending.length === 0) {
        console.log(chalk.green('✓ No pending reviews to retry.'));
        return;
      }
      console.log(chalk.yellow(`\n💾 Pending reviews (${pending.length}):\n`));
      for (const r of pending) {
        const age = Math.round((Date.now() - new Date(r.createdAt).getTime()) / 60000);
        console.log(
          chalk.white(`  PR #${r.prNumber}`) +
          chalk.gray(` — ${r.repo} — ${r.comments.length} comment(s) — ${age}m ago`)
        );
        console.log(chalk.dim(`    lgtm retry ${r.prNumber} -r ${r.repo}`));
      }
      return;
    }

    const prNumber = parseInt(prNumberStr, 10);
    if (isNaN(prNumber)) {
      console.error(chalk.red('Invalid PR number'));
      process.exit(1);
    }

    const pending = loadPendingReview(prNumber, repo);
    if (!pending) {
      console.error(chalk.red(`No pending review found for PR #${prNumber} (${repo})`));
      console.log(chalk.dim('Run `lgtm retry` with no arguments to list all pending reviews.'));
      process.exit(1);
    }

    const age = Math.round((Date.now() - new Date(pending.createdAt).getTime()) / 60000);
    console.log(chalk.blue(`\n🔄 Retrying upload for PR #${prNumber} (${repo})`));
    console.log(chalk.gray(`   ${pending.comments.length} comment(s) saved ${age} minute(s) ago\n`));

    for (const c of pending.comments) {
      console.log(chalk.gray(`  • ${c.file}:${c.line}`));
    }

    // Re-uploading posts to the PR, so it needs an explicit confirmation. On non-TTY stdin
    // we can't ask — the comments are listed above; keep the cache and stop rather than hang.
    // Signal a non-zero exit (like the quiz guard) so a script can tell this no-op apart from
    // a successful upload; process.exitCode (not process.exit) lets buffered output flush.
    if (!process.stdin.isTTY) {
      console.error(chalk.yellow(
        '⚠  stdin is not an interactive terminal — not re-uploading (cache kept).\n' +
        '   Rerun `lgtm retry` in a terminal to confirm the upload.'
      ));
      process.exitCode = 1;
      return;
    }

    const confirm = await prompts({
      type: 'confirm',
      name: 'value',
      message: `Re-upload ${pending.comments.length} comment(s) to PR #${prNumber}?`,
      initial: true,
    });

    if (!confirm.value) {
      console.log(chalk.yellow('Cancelled. Cache kept for future retry.'));
      return;
    }

    console.log(chalk.blue('\n📤 Uploading...'));
    try {
      submitReview(prNumber, pending.comments, repo === 'unknown' ? undefined : repo);
      deletePendingReview(prNumber, repo);
      console.log(chalk.green(`\n✓ Posted ${pending.comments.length} comment(s)`));
    } catch (error: any) {
      console.error(chalk.red(`\n✗ Upload failed again: ${error.message}`));
      console.log(chalk.yellow('Cache kept — try again later with `lgtm retry`'));
      process.exit(1);
    }
  });

// Report command: generate monthly review metrics
program
  .command('report [month] [year]')
  .description('Generate monthly review metrics report')
  .action(async (monthStr?: string, yearStr?: string) => {
    const { getMonthlyStats } = await import('./db.js');
    const now = new Date();
    const month = monthStr ? parseInt(monthStr, 10) : now.getMonth() + 1;
    const year = yearStr ? parseInt(yearStr, 10) : now.getFullYear();
    
    const stats = getMonthlyStats(year, month);
    const falseNegativeRate = stats.total > 0 ? ((stats.falseNegatives / stats.total) * 100).toFixed(1) : '0.0';
    const contextCoverage = stats.total > 0 ? ((stats.withContextExpansion / stats.total) * 100).toFixed(1) : '0.0';
    
    console.log(chalk.bold(`\nlgtm Review Metrics — ${month}/${year}\n`));
    console.log(`Reviews logged:         ${stats.total}`);
    console.log(`False Negatives:        ${stats.falseNegatives}`);
    console.log(`False Negative Rate:    ${falseNegativeRate}%`);
    console.log(`Context Expansion Used: ${contextCoverage}%`);
    // Measured figures cover only rows with a provider envelope; the rest carry the old diff-length estimate.
    console.log(`Measured reviews:       ${stats.measured} of ${stats.total}`);
    if (stats.measured > 0) {
      console.log(`Prompt tokens (billed): ${stats.promptTokens.toLocaleString()}`);
      console.log(`Output tokens:          ${stats.outputTokens.toLocaleString()}`);
      console.log(`API-equiv. cost:        $${stats.costUsd.toFixed(2)}  (logged reviews; the CLI's total_cost_usd — a metric, not a bill, on a subscription plan)`);
    }
    console.log('');
  });

// Dismiss: settle findings by id with a reason. The next round injects every
// dismissal automatically, so nothing has to be carried in a --decided file.
program
  .command('dismiss <finding-id...>')
  .description('Dismiss open findings by id (from agent-mode output / lgtm rounds) — the next round will not re-raise them')
  .requiredOption('--reason <text>', 'Why this finding does not apply — recorded, and shown to the reviewer next round')
  .option('--json', 'Structured JSON to stdout', false)
  .action((idStrs: string[], options: any) => {
    // parseInt('12abc') is 12 — a mistyped id must not dismiss a different finding.
    const ids = idStrs.filter((x) => /^[1-9]\d*$/.test(x)).map((x) => parseInt(x, 10));
    if (ids.length !== idStrs.length) {
      console.error(chalk.red('Finding ids must be positive integers (see the `id` field in agent output).'));
      process.exit(1);
    }
    const out = dismissFindings(ids, options.reason);
    // Nothing dismissed is a failure in both output modes — an agent must not have to parse the payload to notice.
    if (out.dismissed.length === 0) process.exitCode = 1;
    if (options.json) {
      console.log(JSON.stringify(out));
      return;
    }
    if (out.dismissed.length > 0) console.log(chalk.green(`✓ Dismissed ${out.dismissed.length}: ${out.dismissed.join(', ')}`));
    if (out.skipped.length > 0) console.log(chalk.yellow(`⊘ Not open (unknown id or already settled): ${out.skipped.join(', ')}`));
  });

// Rounds: the fix→review loop for one PR or branch, from the log. This is the
// stopping rule's evidence — findings per round, what became of them, and the last
// round that found a BUG/SECURITY.
program
  .command('rounds [pr-number]')
  .description('Show the review rounds logged for a PR (or, with --local, the current branch)')
  .option('-r, --repo <owner/repo>', 'GitHub repository (default: current repo)')
  .option('--local', 'Rounds for the current branch (local working-tree reviews)', false)
  .option('--json', 'Structured JSON to stdout', false)
  .action((prStr: string | undefined, options: any) => {
    let key: string;
    if (options.local) key = `local:${getCurrentBranch()}`;
    else if (prStr && /^\d+$/.test(prStr)) key = `pr:${parseInt(prStr, 10)}`;
    else {
      console.error(chalk.red('Give a PR number, or --local for the current branch.'));
      process.exit(1);
    }
    // The log's repo column is whatever `review` was given: the --repo slug, or the
    // checkout path when it was run bare. With --repo, look up exactly that; bare,
    // try the checkout path and then its slug — never another repo's loop.
    const candidates: string[] = options.repo ? [options.repo] : [];
    if (!options.repo) {
      const slug = getCurrentRepoSlug(); // null when the checkout has no GitHub remote
      if (slug) candidates.push(slug);
      candidates.push(getRepoRoot()); // rows written before the slug became the key
    }
    let summary = getLoopSummary(candidates[0], key);
    for (const c of candidates.slice(1)) {
      if (summary.rounds.length > 0) break;
      summary = getLoopSummary(c, key);
    }
    if (options.json) {
      console.log(JSON.stringify(summary));
      return;
    }
    if (summary.rounds.length === 0) {
      console.log(`No logged rounds for ${key} in ${candidates.join(' or ')}.`);
      return;
    }
    const mixed = summary.rounds.some((r) => r.key !== key);
    console.log(chalk.bold(`\nReview rounds — ${key}${mixed ? ' (with the branch\'s local rounds first)' : ''}\n`));
    console.log(`${mixed ? 'loop   ' : ''}round  when              harsh    BUG SEC SUG NIT  abs high  fixed dism carr supp    cost  model`);
    for (const r of summary.rounds) {
      const when = r.reviewedAt.slice(0, 16).replace('T', ' ');
      const s = r.bySeverity;
      const cost = r.costUsd === null ? '      —' : `$${r.costUsd.toFixed(2)}`.padStart(7);
      const loopCol = mixed ? `${(r.key.startsWith('pr:') ? 'pr' : 'local').padEnd(6)} ` : '';
      const modelCol = `${r.model ?? '—'}${r.failed ? '  (failed — no review)' : ''}`;
      console.log(
        `${loopCol}${String(r.round).padStart(5)}  ${when}  ${(r.harshness ?? '—').padEnd(8)} ` +
          `${String(s.BUG).padStart(3)} ${String(s.SECURITY).padStart(3)} ${String(s.SUGGESTION).padStart(3)} ${String(s.NITPICK).padStart(3)}  ` +
          `${String(r.absences).padStart(3)} ${String(r.highConfidence).padStart(4)}  ` +
          `${String(r.fixed).padStart(5)} ${String(r.dismissed).padStart(4)} ${String(r.carried).padStart(4)} ${String(r.suppressed).padStart(4)} ${cost}  ${modelCol}`
      );
    }
    const own = summary.rounds.filter((r) => r.key === key);
    const last = own.length > 0 ? own[own.length - 1].round : 0;
    console.log('');
    console.log(`API-equivalent cost so far: $${summary.totalCostUsd.toFixed(2)}  (the CLI's total_cost_usd — a metric, not a bill, on a subscription plan)`);
    if (last > 0) {
      const advice = stopAdvice(last, summary.lastBugRound, summary.cleanRounds, summary.lastRoundEmpty);
      console.log(advice.stop ? chalk.yellow(`🛑 ${advice.reason}`) : `↻ ${advice.reason}`);
      console.log(`Budget: ${summary.budgetUsed} of ${ROUND_BUDGET} rounds used in the current loop${summary.budgetUsed >= ROUND_BUDGET ? ' — the next needs --override "<reason>"' : ''}.`);
    }
    console.log('');
  });

// Quiz command: test your understanding of a PR
program
  .command('quiz <pr-number>')
  .description('Take a quiz to test your understanding of a PR')
  .option('-r, --repo <owner/repo>', 'GitHub repository (default: current repo)')
  .option('-a, --ai <provider>', 'AI provider: claude, codex (default: auto-detect)')
  .option('-n, --questions <count>', 'Number of questions', '5')
  .action(async (prNumberStr: string, options) => {
    const prNumber = parseInt(prNumberStr, 10);
    if (isNaN(prNumber)) {
      console.error(chalk.red('Invalid PR number'));
      process.exit(1);
    }

    const questionCount = parseInt(options.questions, 10);
    if (isNaN(questionCount) || questionCount < 1 || questionCount > 10) {
      console.error(chalk.red('Question count must be between 1 and 10'));
      process.exit(1);
    }

    // A comprehension quiz is inherently interactive — there's nothing to degrade to. Refuse
    // up front on non-TTY stdin so we don't spend an AI call generating a quiz that can't be
    // taken (and so prompts() never hangs).
    if (!process.stdin.isTTY) {
      console.error(chalk.red('The quiz needs an interactive terminal, but stdin is not a TTY. Run `lgtm quiz` directly in your terminal.'));
      process.exit(1);
    }

    const ai = resolveProvider(options.ai, exitWithTextError);

    try {
      await runQuiz({ prNumber, repo: options.repo, ai, questionCount });
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error?.message ?? String(error)}`));
      process.exit(1);
    }
  });

const OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const;

async function runQuiz(options: { prNumber: number; repo?: string; ai: AIProvider; questionCount: number }): Promise<void> {
  const { prNumber, repo, ai, questionCount } = options;

  // Fetch PR details
  console.log(chalk.blue(`\n🔍 Fetching PR #${prNumber}...`));
  const pr = getPRDetails(prNumber, repo);
  console.log(chalk.white(`   "${pr.title}" by ${pr.author}`));
  console.log(chalk.gray(`   ${pr.changedFiles} files, +${pr.additions}/-${pr.deletions}`));

  // Fetch diff
  console.log(chalk.blue(`\n📄 Fetching diff...`));
  const diff = getPRDiff(prNumber, repo);
  const maxDiffLength = 50000;
  const truncatedDiff = diff.length > maxDiffLength
    ? diff.slice(0, maxDiffLength) + '\n... (diff truncated)'
    : diff;

  // Generate quiz
  const aiLabel = ai === 'codex' ? 'Codex' : 'Claude';
  console.log(chalk.blue(`\n🧠 Generating quiz with ${aiLabel}...\n`));
  const quiz = await generateQuiz(truncatedDiff, pr.title, pr.body, ai, questionCount);

  if (quiz.questions.length === 0) {
    console.log(chalk.yellow('Could not generate questions for this PR.'));
    return;
  }

  // Run the quiz interactively
  console.log(chalk.bold.white(`📝 PR Comprehension Quiz: "${pr.title}"\n`));
  console.log(chalk.gray(`Answer ${quiz.questions.length} questions to test your understanding.\n`));

  let correct = 0;

  for (let i = 0; i < quiz.questions.length; i++) {
    const q = quiz.questions[i];

    console.log(chalk.white('─'.repeat(60)));
    console.log(chalk.bold(`Question ${i + 1}/${quiz.questions.length}`));
    console.log(chalk.white(q.question) + '\n');

    const response = await prompts({
      type: 'select',
      name: 'answer',
      message: 'Your answer',
      choices: q.options.map((opt, idx) => ({
        title: `${OPTION_LETTERS[idx]}) ${opt}`,
        value: idx,
      })),
    });

    // User pressed Ctrl+C or escaped
    if (response.answer === undefined) {
      console.log(chalk.yellow('\nQuiz cancelled.'));
      return;
    }

    if (response.answer === q.correctIndex) {
      correct++;
      console.log(chalk.green(`\n  ✓ Correct!`));
    } else {
      console.log(chalk.red(`\n  ✗ Incorrect — the answer was ${OPTION_LETTERS[q.correctIndex]}) ${q.options[q.correctIndex]}`));
    }
    console.log(chalk.gray(`  ${q.explanation}\n`));
  }

  // Results
  const total = quiz.questions.length;
  const pct = Math.round((correct / total) * 100);

  console.log(chalk.white('═'.repeat(60)));
  console.log(chalk.bold(`\n  Result: ${correct}/${total} (${pct}%)\n`));

  if (pct === 100) {
    console.log(chalk.green('  🌟 Perfect score! You have a strong understanding of this PR.'));
  } else if (pct >= 80) {
    console.log(chalk.green('  👍 Great job — you understand this PR well.'));
  } else if (pct >= 60) {
    console.log(chalk.yellow('  📖 Decent, but consider re-reading the parts you missed before approving.'));
  } else {
    console.log(chalk.red('  🔎 You may want to spend more time reviewing this PR before approving.'));
    console.log(chalk.red('     Try reading the diff more carefully and check the PR description for context.'));
  }

  console.log();
}

// ---------------------------------------------------------------------------
// `lgtm arch` — architecture review: a second altitude. `review` asks "is this
// code correct?"; `arch` asks "was this the right thing to build, built in the
// right place, and what does it cost us later?" Output is decision records, never
// inline comments. Design rationale: docs/ARCHITECTURE-REVIEW.md.
// ---------------------------------------------------------------------------

const ARCH_AUTHORITY_COLORS: Record<ArchAuthority, (s: string) => string> = {
  charter: chalk.magenta,
  'codebase-pattern': chalk.cyan,
  'diff-evidence': chalk.blue,
  judgement: chalk.gray,
};

const ARCH_REVERSIBILITY_LABELS: Record<ArchReversibility, string> = {
  cheap: chalk.gray('cheap to reverse'),
  costly: chalk.yellow('costly to reverse'),
  'one-way': chalk.red.bold('ONE-WAY DOOR'),
};

function formatArchAgentResult(opts: {
  success: boolean;
  result?: ArchResult;
  charterPath?: string;
  charterSource?: string;
  systemPath?: string;
  error?: string;
}): string {
  const r = opts.result;
  return JSON.stringify({
    success: opts.success,
    mode: 'arch',
    posted: false,
    verdict: r?.verdict ?? 'no-decisions',
    summary: r?.summary ?? '',
    recovered: r?.recovered ?? false,
    decisions: r?.decisions ?? [],
    skipped_checks: r?.skipped_checks ?? [],
    context: {
      charter: opts.charterPath ?? null,
      charterSource: opts.charterSource ?? null,
      system: opts.systemPath ?? null,
    },
    ...(opts.error ? { error: opts.error } : {}),
  });
}

function renderArchResult(result: ArchResult, log: (...args: any[]) => void): void {
  log(chalk.gray(`\n${result.summary}\n`));
  if (result.decisions.length === 0) {
    log(chalk.green('✓ No architectural decisions found in this change.'));
  }
  result.decisions.forEach((d, i) => {
    log(chalk.white('─'.repeat(60)));
    log(
      chalk.white(`[${i + 1}/${result.decisions.length}] `) +
      ARCH_AUTHORITY_COLORS[d.authority](d.authority.toUpperCase()) +
      chalk.gray(' | ') +
      ARCH_REVERSIBILITY_LABELS[d.reversibility] +
      chalk.gray(` | confidence: ${d.confidence}`)
    );
    log(chalk.white('─'.repeat(60)));
    log(chalk.bold(d.decision));
    if (d.evidence.length) log(chalk.gray(`Evidence: ${d.evidence.join(' · ')}`));
    log(chalk.white(`Rationale found: ${d.rationale_found}`));
    if (d.alternatives_not_taken.length) log(chalk.white(`Alternatives not taken: ${d.alternatives_not_taken.join('; ')}`));
    for (const ram of d.ramifications) log(chalk.yellow(`  ↳ ${ram}`));
    if (d.falsifiable_by) log(chalk.gray(`Wrong if: ${d.falsifiable_by}`));
    if (d.ask_the_author) log(chalk.green(`❓ Ask the author: ${d.ask_the_author}`));
    log();
  });
  if (result.skipped_checks.length) log(chalk.gray(`Skipped checks: ${result.skipped_checks.join('; ')}`));
  if (result.recovered) log(chalk.yellow('⚠ Model JSON was salvaged — this review may be partial.'));
}

interface ArchRunOptions {
  prNumber: number;
  repo?: string;
  local: boolean;
  base?: string;
  agent: boolean;
  dryRun: boolean;
  fullContext: boolean;
  ai: AIProvider;
}

async function runArchReview(options: ArchRunOptions): Promise<void> {
  const { prNumber, repo, local, base, agent, dryRun, fullContext, ai } = options;
  const log = agent ? (..._args: any[]) => {} : console.log;

  log(chalk.blue(`\n🏛  ${local ? `Architecture review of local changes (vs ${base})` : `Architecture review of PR #${prNumber}`}...`));
  const pr = local ? getLocalDetails(base!) : getPRDetails(prNumber, repo);
  log(chalk.white(`   "${pr.title}" by ${pr.author}`));
  log(chalk.gray(`   ${pr.changedFiles} files, +${pr.additions}/-${pr.deletions}`));

  const diff = local ? getLocalDiff(base!) : getPRDiff(prNumber, repo);
  const maxDiffLength = 50000;
  const truncatedDiff = diff.length > maxDiffLength ? diff.slice(0, maxDiffLength) + '\n... (diff truncated)' : diff;

  // Full contents of changed files (always on in agent mode) — pattern claims must be
  // countable, and placement judgements need to see the whole file, not the hunk.
  let fileContents: Record<string, string> | undefined;
  if (fullContext || agent) {
    log(chalk.blue(`\n📁 Fetching full file contents...`));
    const changedFiles = local ? getLocalChangedFiles(base!) : getChangedFiles(prNumber, repo);
    fileContents = {};
    for (const file of changedFiles) {
      if (file.endsWith('.lock') || (file.endsWith('.json') && file.includes('package-lock'))) continue;
      const content = local ? getLocalFileContent(file) : getFileContent(prNumber, file, repo);
      if (content && content.length <= 300000) fileContents[file] = content;
    }
  }

  const repoRoot = charterRepoRoot(repo);
  const repoName = repo ? repo.split('/').pop() : repoRoot ? basename(repoRoot) : undefined;

  const archCtx = await buildArchitectureContext(repoRoot, repoName);
  if (archCtx.charterBlock) {
    log(chalk.blue(`\n📐 Charter: ${archCtx.charterPath ?? `${repoName}-charter (second-brain)`}`));
  } else {
    log(chalk.yellow(`\n📐 No charter found — charter-grounded checks will be skipped. Bootstrap one: lgtm arch init`));
  }
  if (archCtx.systemPath) log(chalk.blue(`🗺  System doc: ${archCtx.systemPath}`));

  const handbookBlock = await fetchBrainContext(repo);
  if (handbookBlock) log(chalk.blue(`📖 Handbook context loaded from second-brain`));

  const aiLabel = ai === 'codex' ? 'Codex' : 'Claude';
  log(chalk.blue(`\n🤖 Reviewing architecture with ${aiLabel}...`));
  const result = await archReview(truncatedDiff, pr.title, pr.body, ai, {
    charterBlock: archCtx.charterBlock,
    systemBlock: archCtx.systemBlock,
    handbookBlock,
    fileContents,
  });

  if (agent) {
    console.log(formatArchAgentResult({
      success: true,
      result,
      charterPath: archCtx.charterPath,
      charterSource: archCtx.charterSource,
      systemPath: archCtx.systemPath,
    }));
    return;
  }

  renderArchResult(result, log);

  // One summary comment, never inline — and nothing worth posting on "no-decisions".
  if (local || result.verdict === 'no-decisions') return;
  if (dryRun) {
    log(chalk.yellow('\n(dry-run — not posting)'));
    return;
  }
  if (!process.stdin.isTTY) {
    console.error(chalk.yellow('\n⚠  stdin is not an interactive terminal — not posting. Use --agent for JSON output.'));
    return;
  }
  const confirm = await prompts({
    type: 'confirm',
    name: 'value',
    message: `Post this architecture review as ONE summary comment on PR #${prNumber}?`,
    initial: true,
  });
  if (!confirm.value) {
    log(chalk.yellow('Not posted.'));
    return;
  }
  postIssueComment(prNumber, formatArchComment(result), repo);
  log(chalk.green('\n✓ Posted architecture review comment'));
}

const arch = program
  .command('arch')
  .description('Architecture review — the decisions a change commits the system to (also: arch init, arch new)');

arch
  .command('review [pr-number]', { isDefault: true })
  .description('Review a PR (or --local changes) for architectural decisions and their consequences')
  .option('-r, --repo <owner/repo>', 'GitHub repository (default: current repo)')
  .option('--local', 'Review local working-tree changes vs a base ref (never posts)', false)
  .option('--base <ref>', 'Base ref for --local mode (default: auto-detected default branch)')
  .option('--agent', 'Agent mode: read-only, full JSON to stdout (never posts)', false)
  .option('--dry-run', 'Show the review without posting', false)
  .option('--full-context', 'Include full contents of changed files (always on in agent mode)', false)
  .option('-a, --ai <provider>', 'AI provider: claude, codex (default: auto-detect)')
  .option('--model <id>', 'Model to review with (default: your settings model)')
  .action(async (prNumberStr: string | undefined, options) => {
    const agent = options.agent;
    function exitWithError(message: string): never {
      if (agent) {
        console.log(formatArchAgentResult({ success: false, error: message }));
      } else {
        console.error(chalk.red(message));
      }
      process.exit(1);
    }
    if (options.model) {
      try { setModelOverride(options.model); } catch (e: any) { exitWithError(e.message); }
    }

    const local = options.local;
    let prNumber = 0;
    if (!local) {
      prNumber = parseInt(prNumberStr ?? '', 10);
      if (isNaN(prNumber)) {
        exitWithError('Invalid PR number (or pass --local to review working-tree changes)');
      }
    }
    let base: string | undefined;
    if (local) {
      try {
        base = options.base || detectDefaultBase();
      } catch (e: any) {
        exitWithError(e?.message ?? String(e));
      }
    }
    const ai = resolveProvider(options.ai, exitWithError);
    if (options.model && ai === 'codex') console.error(chalk.yellow('⚠  --model applies to claude only; codex chooses its own model.'));

    try {
      await runArchReview({
        prNumber,
        repo: options.repo,
        local,
        base,
        agent,
        dryRun: options.dryRun,
        fullContext: options.fullContext,
        ai,
      });
    } catch (error: any) {
      exitWithError(error?.message ?? String(error));
    }
  });

arch
  .command('new')
  .description('Design a NEW repo before any code: interview → draft ARCHITECTURE.md → critique → write')
  .option('--name <repo-name>', 'Repo name (default: current directory name)')
  .option('--out <file>', 'Output path (default: ./ARCHITECTURE.md)')
  .option('--system <path>', 'System doc or directory to check fit against (default: $LGTM_SYSTEM_DIR)')
  .option('--answers <file>', 'JSON array of pre-supplied answers (scripted/rehearsal run)')
  .option('--force', 'Overwrite an existing file', false)
  .option('-a, --ai <provider>', 'AI provider: claude, codex (default: auto-detect)')
  .action(async (options) => {
    const ai = resolveProvider(options.ai, exitWithTextError);
    try {
      await runArchNew({ ai, out: options.out, name: options.name, system: options.system, answers: options.answers, force: options.force });
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error?.message ?? String(error)}`));
      process.exit(1);
    }
  });

arch
  .command('init')
  .description('Infer a draft ARCHITECTURE.md for an EXISTING repo — every claim marked with its evidence, for correction')
  .option('--out <file>', 'Output path (default: <repo-root>/ARCHITECTURE.md)')
  .option('--system <path>', 'System doc or directory this repo belongs to (default: $LGTM_SYSTEM_DIR)')
  .option('--force', 'Overwrite an existing file', false)
  .option('-a, --ai <provider>', 'AI provider: claude, codex (default: auto-detect)')
  .action(async (options) => {
    const ai = resolveProvider(options.ai, exitWithTextError);
    try {
      await runArchInit({ ai, out: options.out, system: options.system, force: options.force });
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error?.message ?? String(error)}`));
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// `lgtm standards` — the maintainability altitude's document. `standards init`
// selects the repo's standards from the built-in clean-code catalog (AI-free:
// fixed contested-toggle questions against a repo scan) and writes STANDARDS.md,
// which `lgtm review` then cites as `(standard <id>)` findings.
// ---------------------------------------------------------------------------

const standards = program
  .command('standards')
  .description("Engineering standards — select the repo's maintainability standards from lgtm's clean-code catalog");

standards
  .command('init')
  .description('Scan the repo, ask the contested toggles, write STANDARDS.md (no AI call)')
  .option('--out <file>', 'Output path (default: <repo-root>/STANDARDS.md)')
  .option('--force', 'Overwrite an existing file', false)
  .option('--answers <file>', 'Scripted answers: JSON object keyed by question id (profile, FUN-1…, fnWarn…, houseRules) — or a positional array')
  .option('--yes', 'Accept every recommendation non-interactively (scan-informed)', false)
  .option('--profile <profile>', 'Repo profile: lib, service, frontend (skips the profile question)')
  .option('--no-eslint', 'Skip emitting the derived ESLint rules fragment (.lgtm/standards.eslint.js)')
  .option('--severity <level>', 'Severity for the emitted mechanical rules: warn, error', 'warn')
  .action(async (options, command) => {
    if (!['warn', 'error'].includes(options.severity)) {
      exitWithTextError('Invalid --severity. Use: warn, error');
    }
    // --severity only affects the fragment, so pairing it with --no-eslint is a
    // no-op the user almost certainly didn't intend. `eslint === false` only
    // happens when --no-eslint was passed; the source check distinguishes an
    // explicit --severity from its default.
    if (options.eslint === false && command.getOptionValueSource('severity') !== 'default') {
      console.error(chalk.yellow('⚠  --severity has no effect with --no-eslint (no fragment is emitted).'));
    }
    try {
      await runStandardsInit({ out: options.out, force: options.force, answers: options.answers, yes: options.yes, profile: options.profile, noEslint: options.eslint === false, severity: options.severity });
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error?.message ?? String(error)}`));
      process.exit(1);
    }
  });

standards
  .command('review <target>')
  .description('Retroactively review an existing file or directory against STANDARDS.md (ESLint first, then the AI pass)')
  .option('-a, --ai <provider>', 'AI provider: claude, codex (default: auto-detect)')
  .option('--agent', 'Agent mode: read-only JSON to stdout', false)
  .option('--skip-lint-gate', 'Review even when structural lint findings are outstanding', false)
  .option('--no-lint', 'Skip the ESLint pass entirely (no gate, no suppression)')
  .option('--max-files <n>', 'Cap files reviewed when the target is a directory', '5')
  .option('--model <id>', 'Model to review with (default: your settings model)')
  .action(async (target: string, options) => {
    const agent = options.agent;
    function exitWithError(message: string): never {
      if (agent) console.log(JSON.stringify({ success: false, mode: 'standards-review', error: message, comments: [] }));
      else console.error(chalk.red(message));
      process.exit(1);
    }
    if (options.model) {
      try { setModelOverride(options.model); } catch (e: any) { exitWithError(e.message); }
    }
    // parseInt('5abc') is 5 — reject malformed input rather than guessing intent.
    if (!/^\d+$/.test(String(options.maxFiles).trim())) exitWithError('--max-files must be a positive integer');
    const maxFiles = parseInt(options.maxFiles, 10);
    if (maxFiles < 1) exitWithError('--max-files must be a positive integer');
    const ai = resolveProvider(options.ai, exitWithError);
    if (options.model && ai === 'codex') console.error(chalk.yellow('⚠  --model applies to claude only; codex chooses its own model.'));
    try {
      await runStandardsReview({ target, ai, agent, skipLintGate: options.skipLintGate, noLint: options.lint === false, maxFiles });
    } catch (error: any) {
      exitWithError(error?.message ?? String(error));
    }
  });

const quality = program
  .command('quality')
  .description('Mutation-testing quality — do the tests actually hold the code down? (Phase 1: baseline + hotspots; no AI call. Ranking is deterministic from the report; the fix-before-harden column reads LIVE tracker state)');

quality
  .command('baseline')
  .description('Read the repo\'s Stryker mutation.json and write per-file scores to .lgtm/mutation-baseline.json (committed — the ratchet travels with the repo)')
  .option('--report <path>', 'Path to mutation.json (default: reports/mutation/mutation.json, .lgtm/mutation.json, mutation.json)')
  .option('--out <file>', 'Baseline output path (default: .lgtm/mutation-baseline.json)')
  .option('--force', 'Allow the rewrite to LOWER committed scores (a falling ratchet must be deliberate)', false)
  .action(async (options) => {
    try {
      await runQualityBaseline({ report: options.report, out: options.out, force: options.force });
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error?.message ?? String(error)}`));
      process.exit(1);
    }
  });

quality
  .command('hotspots')
  .description('Ranked burn-down worklist from mutation.json — (1−score) × mutants × (1+churn), cross-checked against open issues (fix before you harden). No AI call; ranking is deterministic from report+git, the issue column reads live tracker state')
  .option('--report <path>', 'Path to mutation.json (default: standard locations)')
  .option('--top <n>', 'How many hotspots to print', '10')
  .option('--json', 'Structured JSON to stdout', false)
  .option('--no-issues', 'Skip the open-issue cross-check')
  .action(async (options) => {
    // Mirror standards review's two-step check: the regex admits '0', which
    // would print an empty list that reads as "no hotspots".
    if (!/^\d+$/.test(String(options.top).trim()) || parseInt(options.top, 10) < 1) {
      console.error(chalk.red('--top must be a positive integer'));
      process.exit(1);
    }
    try {
      await runQualityHotspots({ report: options.report, top: parseInt(options.top, 10), json: options.json, noIssues: options.issues === false });
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error?.message ?? String(error)}`));
      process.exit(1);
    }
  });

program.parse();
