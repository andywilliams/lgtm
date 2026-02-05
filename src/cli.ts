#!/usr/bin/env node

import { program } from 'commander';
import prompts from 'prompts';
import chalk from 'chalk';
import { getPRDetails, getPRDiff, getChangedFiles, getFileContent, submitReview } from './github.js';
import { reviewPR, checkClaudeCli, checkCodexCli, getAvailableProviders, type AIProvider } from './review.js';
import type { Harshness, ReviewComment } from './types.js';

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
  ai: AIProvider;
}

async function runReview(options: RunOptions): Promise<void> {
  const { prNumber, repo, harshness, dryRun, batch, fullContext, ai } = options;

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

  // Review with AI
  const aiLabel = ai === 'codex' ? 'Codex' : 'Claude';
  const modeLabel = fullContext ? `${harshness} mode + full context` : `${harshness} mode`;
  console.log(chalk.blue(`\n🤖 Reviewing with ${aiLabel} (${modeLabel})...`));
  const result = await reviewPR(truncatedDiff, pr.title, pr.body, harshness, ai, fileContents);

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

program.parse();
