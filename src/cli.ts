#!/usr/bin/env node

import { program } from 'commander';
import prompts from 'prompts';
import chalk from 'chalk';
import { getPRDetails, getPRDiff, getChangedFiles, getFileContent, submitReview, getPRComments, resolveComment } from './github.js';
import { reviewPR, recheckComments, checkClaudeCli, checkCodexCli, getAvailableProviders, type AIProvider } from './review.js';
import { extractChangedSymbols, findUsages, formatUsageContext, getRepoRoot } from './usage.js';
import type { Harshness, ReviewComment, ExistingComment } from './types.js';

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
  .option('--full-context', 'Include full file contents for pattern analysis', false)
  .option('--usage-context', 'Include files that use changed symbols', false)
  .action(async (prNumberStr: string, options) => {
    const prNumber = parseInt(prNumberStr, 10);
    if (isNaN(prNumber)) {
      console.error(chalk.red('Invalid PR number'));
      process.exit(1);
    }

    const harshness = options.harshness as Harshness;
    if (!['chill', 'medium', 'pedantic'].includes(harshness)) {
      console.error(chalk.red('Invalid harshness level. Use: chill, medium, pedantic'));
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
      
      // Check if specified provider is available
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
      // Auto-detect available provider
      const available = getAvailableProviders();
      if (available.length === 0) {
        console.error(chalk.red('\n⚠ No AI CLI found.'));
        console.log(chalk.dim('Install one of:'));
        console.log(chalk.dim('  Claude: npm install -g @anthropic-ai/claude-code && claude login'));
        console.log(chalk.dim('  Codex:  npm install -g @openai/codex'));
        process.exit(1);
      }
      // Prefer claude, fall back to codex
      ai = available.includes('claude') ? 'claude' : 'codex';
    }

    try {
      await runReview({
        prNumber,
        repo: options.repo,
        harshness,
        dryRun: options.dryRun,
        batch: options.batch,
        fullContext: options.fullContext,
        usageContext: options.usageContext,
        ai,
      });
    } catch (error: any) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

interface RunOptions {
  prNumber: number;
  repo?: string;
  harshness: Harshness;
  dryRun: boolean;
  batch: boolean;
  fullContext: boolean;
  usageContext: boolean;
  ai: AIProvider;
}

async function runReview(options: RunOptions): Promise<void> {
  const { prNumber, repo, harshness, dryRun, batch, fullContext, usageContext, ai } = options;

  // Fetch PR details
  console.log(chalk.blue(`\n🔍 Fetching PR #${prNumber}...`));
  const pr = getPRDetails(prNumber, repo);
  console.log(chalk.white(`   "${pr.title}" by ${pr.author}`));
  console.log(chalk.gray(`   ${pr.changedFiles} files, +${pr.additions}/-${pr.deletions}`));

  // Fetch diff
  console.log(chalk.blue(`\n📄 Fetching diff...`));
  const diff = getPRDiff(prNumber, repo);
  
  // Truncate very large diffs
  const maxDiffLength = 50000;
  const truncatedDiff = diff.length > maxDiffLength 
    ? diff.slice(0, maxDiffLength) + '\n... (diff truncated)'
    : diff;

  // Fetch full file contents if requested
  let fileContents: Record<string, string> | undefined;
  if (fullContext) {
    console.log(chalk.blue(`\n📁 Fetching full file contents...`));
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
          console.log(chalk.yellow(`   ⊘ ${file} (too large: ${Math.round(content.length / 1024)}KB)`));
        } else {
          fileContents[file] = content;
          console.log(chalk.gray(`   ✓ ${file} (${Math.round(content.length / 1024)}KB)`));
        }
      }
    }
  }

  // Extract usage context if requested
  let usageContextStr = '';
  if (usageContext) {
    console.log(chalk.blue(`\n🔗 Finding symbol usages...`));
    const symbols = extractChangedSymbols(diff);
    console.log(chalk.gray(`   Found ${symbols.length} changed symbol(s): ${symbols.map(s => s.name).join(', ') || '(none)'}`));
    
    if (symbols.length > 0) {
      const repoRoot = getRepoRoot();
      const usages = findUsages(symbols, repoRoot, {
        maxUsagesPerSymbol: 5,
        contextLines: 3
      });
      
      if (usages.length > 0) {
        console.log(chalk.gray(`   Found ${usages.length} usage(s) across ${new Set(usages.map(u => u.file)).size} file(s)`));
        usageContextStr = formatUsageContext(usages);
      } else {
        console.log(chalk.gray(`   No external usages found`));
      }
    }
  }

  // Review with AI
  const aiLabel = ai === 'codex' ? 'Codex' : 'Claude';
  const contextModes = [harshness + ' mode'];
  if (fullContext) contextModes.push('full context');
  if (usageContext && usageContextStr) contextModes.push('usage context');
  const modeLabel = contextModes.join(' + ');
  console.log(chalk.blue(`\n🤖 Reviewing with ${aiLabel} (${modeLabel})...`));
  const result = await reviewPR(truncatedDiff, pr.title, pr.body, harshness, ai, fileContents, usageContextStr);

  console.log(chalk.gray(`\n${result.summary}\n`));

  if (result.comments.length === 0) {
    console.log(chalk.green('✓ LGTM — no issues found'));
    return;
  }

  console.log(chalk.white(`Found ${result.comments.length} potential comment(s):\n`));

  // Interactive selection
  const selectedComments: ReviewComment[] = [];

  for (let i = 0; i < result.comments.length; i++) {
    const comment = result.comments[i];
    const severityColor = SEVERITY_COLORS[comment.severity] || chalk.white;
    const severityIcon = SEVERITY_ICONS[comment.severity] || '•';

    console.log(chalk.white('─'.repeat(60)));
    console.log(
      chalk.white(`[${i + 1}/${result.comments.length}] `) +
      severityIcon + ' ' +
      severityColor(comment.severity) +
      chalk.gray(` | ${comment.file}:${comment.line}`)
    );
    console.log(chalk.white('─'.repeat(60)));
    console.log(chalk.bold(comment.title));
    console.log(chalk.white(comment.body));
    if (comment.suggestion) {
      console.log(chalk.green('\nSuggested fix:'));
      console.log(chalk.gray(comment.suggestion));
    }
    console.log();

    if (dryRun) {
      console.log(chalk.gray('(dry-run mode — not posting)\n'));
      continue;
    }

    if (batch) {
      selectedComments.push(comment);
      console.log(chalk.green('✓ Queued\n'));
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
      console.log(chalk.yellow('\nQuitting review.'));
      break;
    }

    if (response.action === 'add') {
      selectedComments.push(comment);
      console.log(chalk.green('✓ Queued\n'));
    } else {
      console.log(chalk.gray('⊘ Skipped\n'));
    }
  }

  // Summary
  console.log(chalk.white('═'.repeat(60)));
  console.log(chalk.white(`Summary: ${selectedComments.length} to post, ${result.comments.length - selectedComments.length} skipped`));
  console.log(chalk.white('═'.repeat(60)));

  if (selectedComments.length === 0) {
    console.log(chalk.gray('\nNo comments to post.'));
    return;
  }

  if (dryRun) {
    console.log(chalk.yellow('\n(dry-run mode — skipping post)'));
    return;
  }

  // Confirm and post
  const confirm = await prompts({
    type: 'confirm',
    name: 'value',
    message: `Post ${selectedComments.length} comment(s) to PR #${prNumber}?`,
    initial: true,
  });

  if (!confirm.value) {
    console.log(chalk.yellow('Cancelled.'));
    return;
  }

  // Post as a review
  console.log(chalk.blue('\n📤 Posting review...'));
  
  const formattedComments = selectedComments.map(c => {
    let body = `**${c.title}**\n\n${c.body}`;
    if (c.suggestion) {
      body += `\n\n**Suggested fix:**\n\`\`\`suggestion\n${c.suggestion}\n\`\`\``;
    }
    return {
      file: c.file,
      line: c.line,
      body,
    };
  });

  submitReview(prNumber, formattedComments, repo);
  
  console.log(chalk.green(`\n✓ Posted ${selectedComments.length} comment(s)`));
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
        process.exit(1);
      }
      if (ai === 'codex' && !checkCodexCli()) {
        console.error(chalk.red('\n⚠ Codex CLI not found.'));
        process.exit(1);
      }
    } else {
      const available = getAvailableProviders();
      if (available.length === 0) {
        console.error(chalk.red('\n⚠ No AI CLI found.'));
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
      statusColor(r.status.replace('_', ' ').toUpperCase()) +
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
  console.log(chalk.white(`Summary: ${stillValid.length} still valid, ${toResolve.length} to resolve, ${result.results.length - stillValid.length - toResolve.length} kept`));
  console.log(chalk.white('═'.repeat(60)));

  if (toResolve.length === 0) {
    console.log(chalk.gray('\nNo comments to resolve.'));
    return;
  }

  if (dryRun) {
    console.log(chalk.yellow('\n(dry-run mode — skipping resolution)'));
    return;
  }

  // Confirm and resolve
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

program.parse();
