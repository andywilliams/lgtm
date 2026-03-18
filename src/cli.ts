#!/usr/bin/env node

import { program } from 'commander';
import prompts from 'prompts';
import chalk from 'chalk';
import { getPRDetails, getPRDiff, getChangedFiles, getFileContent, submitReview, postBatchReview, postReviewComment, getPRComments, getExistingReviewComments, resolveComment } from './github.js';
import { reviewPR, recheckComments, checkClaudeCli, checkCodexCli, getAvailableProviders, type AIProvider } from './review.js';
import { extractChangedSymbols, findUsages, formatUsageContext, getRepoRoot } from './usage.js';
import { expandContext } from './contextExpander.js';
import { logReview } from './db.js';
import { savePendingReview, loadPendingReview, deletePendingReview, listPendingReviews } from './cache.js';
import type { Harshness, ReviewComment, ExistingComment, ExistingReviewComment } from './types.js';

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

program
  .command('review <pr-number>')
  .description('Review a pull request')
  .option('-r, --repo <owner/repo>', 'GitHub repository (default: current repo)')
  .option('-a, --ai <provider>', 'AI provider: claude, codex (default: auto-detect)')
  .option('-H, --harshness <level>', 'Review harshness: chill, medium, pedantic', 'medium')
  .option('--dry-run', 'Show comments without posting', false)
  .option('--batch', 'Post all comments without prompting', false)
  .option('--auto', 'Non-interactive mode for agents: implies --batch, outputs JSON to stdout', false)
  .option('--full-context', 'Include full file contents for pattern analysis', false)
  .option('--usage-context', 'Include files that use changed symbols', false)
  .option('--context', 'Auto-expand context using static analysis', false)
  .action(async (prNumberStr: string, options) => {
    const auto = options.auto;

    // Helper for validation errors: emit JSON in auto mode, plain text otherwise
    function exitWithError(message: string): never {
      if (auto) {
        console.log(formatAutoResult({ success: false, error: message, dryRun: options.dryRun ?? false, summary: '', commentsPosted: 0, duplicatesSkipped: 0, comments: [] }));
      } else {
        console.error(chalk.red(message));
      }
      process.exit(1);
    }

    const prNumber = parseInt(prNumberStr, 10);
    if (isNaN(prNumber)) {
      exitWithError('Invalid PR number');
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

    try {
      await runReview({
        prNumber,
        repo: options.repo,
        harshness,
        dryRun: options.dryRun,
        batch,
        auto,
        fullContext: options.fullContext,
        usageContext: options.usageContext,
        context: options.context,
        ai,
      });
    } catch (error: any) {
      if (auto) {
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
  harshness: Harshness;
  dryRun: boolean;
  batch: boolean;
  auto: boolean;
  fullContext: boolean;
  usageContext: boolean;
  context: boolean;
  ai: AIProvider;
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

async function runReview(options: RunOptions): Promise<void> {
  const { prNumber, repo, harshness, dryRun, batch, auto, fullContext, usageContext, context, ai } = options;

  // In auto mode, suppress decorative output — only JSON goes to stdout.
  // Note: these wrappers suppress our own output but cannot capture stderr from
  // subprocesses (e.g. gh CLI). Consumers should use 2>/dev/null if needed.
  const log = auto ? (..._args: any[]) => {} : console.log;
  const logErr = auto ? (..._args: any[]) => {} : console.error;

  // Fetch PR details
  log(chalk.blue(`\n🔍 Fetching PR #${prNumber}...`));
  const pr = getPRDetails(prNumber, repo);
  log(chalk.white(`   "${pr.title}" by ${pr.author}`));
  log(chalk.gray(`   ${pr.changedFiles} files, +${pr.additions}/-${pr.deletions}`));

  // Fetch diff
  log(chalk.blue(`\n📄 Fetching diff...`));
  const diff = getPRDiff(prNumber, repo);

  // Truncate very large diffs
  const maxDiffLength = 50000;
  const truncatedDiff = diff.length > maxDiffLength
    ? diff.slice(0, maxDiffLength) + '\n... (diff truncated)'
    : diff;

  // Fetch full file contents if requested
  let fileContents: Record<string, string> | undefined;
  if (fullContext) {
    log(chalk.blue(`\n📁 Fetching full file contents...`));
    const changedFiles = getChangedFiles(prNumber, repo);
    fileContents = {};
    for (const file of changedFiles) {
      // Skip very large files and non-code files
      if (file.endsWith('.lock') || file.endsWith('.json') && file.includes('package-lock')) {
        continue;
      }
      const content = getFileContent(prNumber, file, repo);
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
  if (context) {
    log(chalk.blue(`\n📚 Expanding context (static analysis)...`));
    const changedFiles = getChangedFiles(prNumber, repo);
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

  // Review with AI
  const aiLabel = ai === 'codex' ? 'Codex' : 'Claude';
  const contextModes = [harshness + ' mode'];
  if (fullContext) contextModes.push('full context');
  if (usageContext && usageContextStr) contextModes.push('usage context');
  if (context && expandedContextStr) contextModes.push('expanded context');
  const modeLabel = contextModes.join(' + ');
  log(chalk.blue(`\n🤖 Reviewing with ${aiLabel} (${modeLabel})...`));
  const result = await reviewPR(truncatedDiff, pr.title, pr.body, harshness, ai, fileContents, usageContextStr, expandedContextStr);

  log(chalk.gray(`\n${result.summary}\n`));

  if (result.comments.length === 0) {
    if (auto) {
      console.log(formatAutoResult({ success: true, dryRun, summary: result.summary, commentsPosted: 0, comments: [] }));
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

  try {
    if (batch) {
      postBatchReview(prNumber, formattedComments, repo);
    } else {
      for (const comment of formattedComments) {
        postReviewComment(prNumber, comment.path, comment.line, comment.body, repo);
      }
    }
    // Upload succeeded — clean up the cache
    deletePendingReview(prNumber, repoForCache);
    if (auto) {
      console.log(formatAutoResult({
        success: true,
        dryRun,
        summary: result.summary,
        commentsPosted: selectedComments.length,
        duplicatesSkipped: duplicateCount,
        comments: selectedComments,
      }));
    } else {
      log(chalk.green(`\n✓ Posted ${selectedComments.length} comment(s)`));
    }
  } catch (uploadError: any) {
    if (auto) {
      console.log(formatAutoResult({ success: false, error: uploadError?.message ?? String(uploadError), summary: result.summary, commentsPosted: 0, duplicatesSkipped: duplicateCount, comments: [] }));
    } else {
      logErr(chalk.red(`\n✗ Upload failed: ${uploadError?.message ?? String(uploadError)}`));
      log(chalk.yellow(`\n💾 Comments saved locally. Retry with:`));
      log(chalk.white(`   lgtm retry ${prNumber}${repo ? ` -r ${repo}` : ''}`));
    }
    process.exit(1);
  }

  // Log review metadata for metrics
  const repoName = repo || getRepoRoot();
  const changedFiles = getChangedFiles(prNumber, repo);
  const contextFilesAdded = expanded?.length || 0;
  const contextReasons = expanded ? JSON.stringify(expanded.map(f => f.reason)) : '[]';

  // Estimate token count (rough estimate: ~4 chars per token)
  let tokenEstimate = Math.ceil(diff.length / 4);
  if (expanded) {
    for (const file of expanded) {
      tokenEstimate += Math.ceil(file.content.length / 4);
    }
  }

  try {
    logReview({
      repo: repoName,
      prNumber,
      reviewedAt: new Date().toISOString(),
      filesReviewed: changedFiles.length,
      contextFilesAdded,
      contextReasons,
      tokenCount: tokenEstimate,
      model: ai,
      usedContextExpansion: context && expanded && expanded.length > 0,
      falseNegative: false
    });
  } catch (e) {
    // Don't let metrics logging break the auto-mode JSON contract
    if (!auto) throw e;
  }
}

program
  .command('recheck <pr-number>')
  .description('Check if existing review comments are still valid')
  .option('-r, --repo <owner/repo>', 'GitHub repository (default: current repo)')
  .option('-a, --ai <provider>', 'AI provider: claude, codex (default: auto-detect)')
  .option('--batch', 'Resolve all outdated/resolved comments without prompting', false)
  .option('--dry-run', 'Show results without resolving any comments', false)
  .option('--author <login>', 'Only recheck comments from a specific author')
  .action(async (prNumberStr: string, options) => {
    const prNumber = parseInt(prNumberStr, 10);
    if (isNaN(prNumber)) {
      console.error(chalk.red('Invalid PR number'));
      process.exit(1);
    }

    // Determine AI provider (same logic as review)
    let ai: AIProvider;
    if (options.ai) {
      if (!['claude', 'codex'].includes(options.ai)) {
        console.error(chalk.red('Invalid AI provider. Use: claude, codex'));
        process.exit(1);
      }
      ai = options.ai as AIProvider;
      if (ai === 'claude' && !checkClaudeCli()) {
        console.error(chalk.red('\n⚠ Claude CLI not found.'));
        console.log(chalk.dim('Install it: npm install -g @anthropic-ai/claude-code'));
        console.log(chalk.dim('Then run: claude login'));
        process.exit(1);
      }
      if (ai === 'codex' && !checkCodexCli()) {
        console.error(chalk.red('\n⚠ Codex CLI not found.'));
        console.log(chalk.dim('Install it: npm install -g @openai/codex'));
        process.exit(1);
      }
    } else {
      const available = getAvailableProviders();
      if (available.length === 0) {
        console.error(chalk.red('\n⚠ No AI CLI found.'));
        console.log(chalk.dim('Install one of:'));
        console.log(chalk.dim('  Claude: npm install -g @anthropic-ai/claude-code && claude login'));
        console.log(chalk.dim('  Codex:  npm install -g @openai/codex'));
        process.exit(1);
      }
      ai = available.includes('claude') ? 'claude' : 'codex';
    }

    try {
      await runRecheck({
        prNumber,
        repo: options.repo,
        ai,
        batch: options.batch,
        dryRun: options.dryRun,
        author: options.author,
      });
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

interface RecheckOptions {
  prNumber: number;
  repo?: string;
  ai: AIProvider;
  batch: boolean;
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

async function runRecheck(options: RecheckOptions): Promise<void> {
  const { prNumber, repo, ai, batch, dryRun, author } = options;

  // Fetch PR details
  console.log(chalk.blue(`\n🔍 Fetching PR #${prNumber}...`));
  const pr = getPRDetails(prNumber, repo);
  console.log(chalk.white(`   "${pr.title}" by ${pr.author}`));

  // Fetch existing comments
  console.log(chalk.blue(`\n💬 Fetching review comments...`));
  let comments = getPRComments(prNumber, repo);

  if (author) {
    comments = comments.filter(c => c.author === author);
    console.log(chalk.gray(`   Filtered to comments by ${author}`));
  }

  if (comments.length === 0) {
    console.log(chalk.green('\n✓ No review comments found on this PR.'));
    return;
  }

  console.log(chalk.white(`   Found ${comments.length} review comment(s)`));

  // Fetch current diff
  console.log(chalk.blue(`\n📄 Fetching current diff...`));
  const diff = getPRDiff(prNumber, repo);
  const maxDiffLength = 50000;
  const truncatedDiff = diff.length > maxDiffLength
    ? diff.slice(0, maxDiffLength) + '\n... (diff truncated)'
    : diff;

  // Run AI recheck
  const aiLabel = ai === 'codex' ? 'Codex' : 'Claude';
  console.log(chalk.blue(`\n🤖 Rechecking comments with ${aiLabel}...`));
  const result = await recheckComments(truncatedDiff, pr.title, comments, ai);

  console.log(chalk.gray(`\n${result.summary}\n`));

  // Build a lookup from comment ID to the original comment
  const commentMap = new Map<number, ExistingComment>();
  for (const c of comments) {
    commentMap.set(c.id, c);
  }

  // Display results and collect comments to resolve
  const toResolve: ExistingComment[] = [];
  const stillValid: number[] = [];

  for (let i = 0; i < result.results.length; i++) {
    const r = result.results[i];
    const comment = commentMap.get(r.commentId);
    if (!comment) continue;

    const statusColor = STATUS_COLORS[r.status] || chalk.white;
    const statusIcon = STATUS_ICONS[r.status] || '•';

    console.log(chalk.white('─'.repeat(60)));
    console.log(
      chalk.white(`[${i + 1}/${result.results.length}] `) +
      statusIcon + ' ' +
      statusColor(r.status.replaceAll('_', ' ').toUpperCase()) +
      chalk.gray(` | ${comment.file}${comment.line ? ':' + comment.line : ''}`)
    );
    console.log(chalk.white('─'.repeat(60)));
    // Show a truncated version of the comment body
    const bodyPreview = comment.body.length > 200
      ? comment.body.slice(0, 200) + '...'
      : comment.body;
    console.log(chalk.dim(bodyPreview));
    console.log(chalk.white(`\nReason: ${r.reason}`));
    console.log();

    if (r.status === 'still_valid') {
      stillValid.push(r.commentId);
      continue;
    }

    // For resolved/outdated comments, offer to resolve them
    if (dryRun) {
      console.log(chalk.gray('(dry-run mode — not resolving)\n'));
      continue;
    }

    if (batch) {
      toResolve.push(comment);
      console.log(chalk.green('✓ Queued for resolution\n'));
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
      console.log(chalk.yellow('\nQuitting recheck.'));
      break;
    }

    if (response.action === 'resolve') {
      toResolve.push(comment);
      console.log(chalk.green('✓ Queued for resolution\n'));
    } else {
      console.log(chalk.gray('⊘ Kept\n'));
    }
  }

  // Summary
  console.log(chalk.white('═'.repeat(60)));
  const kept = comments.length - stillValid.length - toResolve.length;
  console.log(chalk.white(`Summary: ${stillValid.length} still valid, ${toResolve.length} to resolve, ${kept} kept`));
  console.log(chalk.white('═'.repeat(60)));

  if (toResolve.length === 0) {
    console.log(chalk.gray('\nNo comments to resolve.'));
    return;
  }

  if (dryRun) {
    console.log(chalk.yellow('\n(dry-run mode — skipping resolution)'));
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
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  console.log(chalk.blue('\n📤 Resolving comments...'));
  let resolved = 0;
  for (const comment of toResolve) {
    try {
      resolveComment(comment.nodeId);
      resolved++;
    } catch (error: any) {
      console.error(chalk.red(`   Failed to resolve comment ${comment.id}: ${error.message}`));
    }
  }

  console.log(chalk.green(`\n✓ Resolved ${resolved} comment(s)`));
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

program.parse();
