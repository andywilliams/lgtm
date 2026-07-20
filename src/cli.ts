#!/usr/bin/env node

import { program, Option } from 'commander';
import prompts from 'prompts';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { getPRDetails, getPRDiff, getChangedFiles, getFileContent, submitReview, postBatchReview, postReviewComment, getPRComments, getExistingReviewComments, resolveComment } from './github.js';
import { getLocalDetails, getLocalDiff, getLocalChangedFiles, getLocalFileContent, detectDefaultBase } from './git.js';
import { reviewPR, recheckComments, generateQuiz, checkClaudeCli, checkCodexCli, getAvailableProviders, type AIProvider } from './review.js';
import { fetchBrainContext } from './brain.js';
import { extractChangedSymbols, findUsages, formatUsageContext, getRepoRoot } from './usage.js';
import { expandContext } from './contextExpander.js';
import { logReview } from './db.js';
import { savePendingReview, loadPendingReview, deletePendingReview, listPendingReviews } from './cache.js';
import type { Harshness, ReviewComment, ExistingComment, ExistingReviewComment, DecidedFinding } from './types.js';

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
    '  LGTM_BRAIN_DIR   a second-brain vault on disk\n'
);

program
  .command('review [pr-number]')
  .description('Review a pull request (or local working-tree changes with --local)')
  .option('-r, --repo <owner/repo>', 'GitHub repository (default: current repo)')
  .option('--local', 'Review local working-tree changes vs a base ref (no GitHub PR; never posts)', false)
  .option('--base <ref>', 'Base ref for --local mode (default: auto-detected default branch)')
  .option('--scope <text>', 'What this change is meant to do — out-of-scope quality issues become SUGGESTION follow-ups (genuine bugs/security are still flagged)')
  .option('--decided <file>', 'JSON file of previously-dismissed findings ({file?,line?,title,reason}[]) the reviewer must not re-raise')
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
  .addOption(new Option('--context', 'deprecated alias for --related-files').default(false).hideHelp())
  .action(async (prNumberStr: string | undefined, options) => {
    const agent = options.agent;
    const local = options.local;
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

    // Determine AI provider
    let ai: AIProvider;
    if (options.ai) {
      if (!['claude', 'codex'].includes(options.ai)) {
        exitWithError('Invalid AI provider. Use: claude, codex');
      }
      ai = options.ai as AIProvider;

      // Check if specified provider is available
      if (ai === 'claude' && !checkClaudeCli()) {
        exitWithError('Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code && claude login');
      }
      if (ai === 'codex' && !checkCodexCli()) {
        exitWithError('Codex CLI not found. Install: npm install -g @openai/codex');
      }
    } else {
      // Auto-detect available provider
      const available = getAvailableProviders();
      if (available.length === 0) {
        exitWithError('No AI CLI found. Install claude or codex.');
      }
      // Prefer claude, fall back to codex
      ai = available.includes('claude') ? 'claude' : 'codex';
    }

    const batch = auto || options.batch;

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
        scope: options.scope,
        decided,
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
}

function formatReviewCommentBody(comment: ReviewComment): string {
  let body = `**${comment.title}**\n\n${comment.body}`;
  if (comment.suggestion) {
    body += `\n\n**Suggested fix:**\n\`\`\`suggestion\n${comment.suggestion}\n\`\`\``;
  }
  return body;
}

function normalizeFingerprintText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isDuplicateComment(candidate: ReviewComment, existing: ExistingReviewComment[]): boolean {
  const candidateKey = `${candidate.file}:${candidate.line}`;
  const fingerprint = normalizeFingerprintText(formatReviewCommentBody(candidate)).slice(0, 50);
  if (!fingerprint) return false;

  return existing.some((comment) => {
    if (comment.line == null) return false;
    const existingKey = `${comment.path}:${comment.line}`;
    if (existingKey !== candidateKey) return false;
    return normalizeFingerprintText(comment.body).includes(fingerprint);
  });
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

// A finding plus whether it duplicates a comment already on the PR.
type AnnotatedComment = ReviewComment & { duplicate: boolean };

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
  recovered?: boolean;
  error?: string;
}): string {
  const duplicates = options.comments.filter(c => c.duplicate).length;
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
      file: c.file,
      line: c.line,
      severity: c.severity,
      title: c.title,
      body: c.body,
      suggestion: c.suggestion,
      duplicate: c.duplicate,
    })),
    context: {
      maxContext: true,
      relatedFiles: (options.relatedFiles ?? []).map(f => ({ path: f.path, reason: f.reason })),
      tokenEstimate: options.tokenEstimate ?? 0,
    },
    ...(options.error ? { error: options.error } : {}),
  });
}

/**
 * Best-effort metrics logging for a completed review. Returns the rough token
 * estimate (diff + expanded context) so callers can surface it. Never throws.
 */
function recordReviewMetrics(opts: {
  repo?: string;
  prNumber: number;
  diff: string;
  expanded: { path: string; reason: string; content: string }[];
  relatedFiles: boolean;
  ai: AIProvider;
  local?: boolean;
}): number {
  const { repo, prNumber, diff, expanded, relatedFiles, ai, local } = opts;
  let tokenEstimate = Math.ceil(diff.length / 4);
  for (const file of expanded) {
    tokenEstimate += Math.ceil(file.content.length / 4);
  }
  // The metrics DB is keyed on GitHub PRs — skip persistence for local reviews (still
  // return the token estimate so agent-mode output is populated).
  if (local) return tokenEstimate;
  try {
    const repoName = repo || getRepoRoot();
    const changedFiles = getChangedFiles(prNumber, repo);
    logReview({
      repo: repoName,
      prNumber,
      reviewedAt: new Date().toISOString(),
      filesReviewed: changedFiles.length,
      contextFilesAdded: expanded.length,
      contextReasons: JSON.stringify(expanded.map(f => f.reason)),
      tokenCount: tokenEstimate,
      model: ai,
      usedContextExpansion: relatedFiles && expanded.length > 0,
      falseNegative: false,
    });
  } catch (e) {
    // Metrics logging is non-critical — don't fail the review.
    process.stderr.write(`Warning: metrics logging failed: ${e}\n`);
  }
  return tokenEstimate;
}

async function runReview(options: RunOptions): Promise<void> {
  const { prNumber, repo, local, base, harshness, dryRun, batch, auto, agent, fullContext, usageContext, relatedFiles, ai, scope, decided } = options;

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
  const pr = local ? getLocalDetails(base!) : getPRDetails(prNumber, repo);
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

  // Auto-expand context if requested
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

    if (expanded.length > 0) {
      log(chalk.gray(`   Found ${expanded.length} context file(s):`));
      let tokenEstimate = 0;
      expandedContextStr = `\n## Expanded Context (Auto-discovered)\n`;
      expandedContextStr += `The following files were automatically discovered as relevant context:\n\n`;
      for (const file of expanded) {
        log(chalk.gray(`   • ${file.path} (${file.reason})`));
        expandedContextStr += `### ${file.path}\n`;
        expandedContextStr += `_Reason: ${file.reason}_\n\n`;
        expandedContextStr += `\`\`\`\n${file.content}\n\`\`\`\n\n`;
        tokenEstimate += Math.ceil(file.content.length / 4);
      }
      log(chalk.gray(`   Estimated tokens: ~${tokenEstimate}`));
    } else {
      log(chalk.gray(`   No additional context found`));
    }
  }

  // Optional domain context from a local second-brain (opt-in via LGTM_BRAIN_DIR /
  // LGTM_BRAIN_URL). No-op — and silent — for anyone who hasn't configured one.
  const handbookContextStr = await fetchBrainContext(repo);
  if (handbookContextStr) {
    log(chalk.blue(`\n📖 Loaded engineering handbook context from second-brain`));
  }

  // Review with AI
  const aiLabel = ai === 'codex' ? 'Codex' : 'Claude';
  const contextModes = [harshness + ' mode'];
  if (fullContext) contextModes.push('full context');
  if (usageContext && usageContextStr) contextModes.push('usage context');
  if (relatedFiles && expandedContextStr) contextModes.push('related files');
  if (handbookContextStr) contextModes.push('handbook');
  const modeLabel = contextModes.join(' + ');
  log(chalk.blue(`\n🤖 Reviewing with ${aiLabel} (${modeLabel})...`));
  const result = await reviewPR(truncatedDiff, pr.title, pr.body, harshness, ai, fileContents, usageContextStr, expandedContextStr, handbookContextStr, { scope, decided });

  log(chalk.gray(`\n${result.summary}\n`));

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
    const annotated: AnnotatedComment[] = result.comments.map((comment) => ({
      ...comment,
      duplicate: isDuplicateComment(comment, existingComments),
    }));

    const tokenEstimate = recordReviewMetrics({ repo, prNumber, diff, expanded, relatedFiles, ai, local });

    console.log(formatAgentResult({
      success: true,
      summary: result.summary,
      comments: annotated,
      relatedFiles: expanded,
      tokenEstimate,
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

  // Log review metadata for metrics (non-critical, never throws).
  recordReviewMetrics({ repo, prNumber, diff, expanded, relatedFiles, ai });
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

    // Determine AI provider (same logic as review)
    let ai: AIProvider;
    if (options.ai) {
      if (!['claude', 'codex'].includes(options.ai)) {
        exitWithError('Invalid AI provider. Use: claude, codex');
      }
      ai = options.ai as AIProvider;
      if (ai === 'claude' && !checkClaudeCli()) {
        exitWithError('Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code && claude login');
      }
      if (ai === 'codex' && !checkCodexCli()) {
        exitWithError('Codex CLI not found. Install: npm install -g @openai/codex');
      }
    } else {
      const available = getAvailableProviders();
      if (available.length === 0) {
        exitWithError('No AI CLI found. Install claude or codex.');
      }
      ai = available.includes('claude') ? 'claude' : 'codex';
    }

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
    console.log(`PRs Reviewed:           ${stats.total}`);
    console.log(`False Negatives:        ${stats.falseNegatives}`);
    console.log(`False Negative Rate:    ${falseNegativeRate}%`);
    console.log(`Context Expansion Used: ${contextCoverage}%\n`);
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

    // Determine AI provider
    let ai: AIProvider;
    if (options.ai) {
      if (!['claude', 'codex'].includes(options.ai)) {
        console.error(chalk.red('Invalid AI provider. Use: claude, codex'));
        process.exit(1);
      }
      ai = options.ai as AIProvider;
      if (ai === 'claude' && !checkClaudeCli()) {
        console.error(chalk.red('Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code && claude login'));
        process.exit(1);
      }
      if (ai === 'codex' && !checkCodexCli()) {
        console.error(chalk.red('Codex CLI not found. Install: npm install -g @openai/codex'));
        process.exit(1);
      }
    } else {
      const available = getAvailableProviders();
      if (available.length === 0) {
        console.error(chalk.red('No AI CLI found. Install claude or codex.'));
        process.exit(1);
      }
      ai = available.includes('claude') ? 'claude' : 'codex';
    }

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

program.parse();
