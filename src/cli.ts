#!/usr/bin/env node

import { program } from 'commander';
import prompts from 'prompts';
import chalk from 'chalk';
import { getPRDetails, getPRDiff, submitReview } from './github.js';
import { reviewPR } from './review.js';
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
  .description('AI-powered PR review CLI')
  .version('0.1.0');

program
  .command('review <pr-number>')
  .description('Review a pull request')
  .option('-r, --repo <owner/repo>', 'GitHub repository (default: current repo)')
  .option('-m, --model <model>', 'AI model to use', 'claude-sonnet')
  .option('-H, --harshness <level>', 'Review harshness: chill, medium, pedantic', 'medium')
  .option('--dry-run', 'Show comments without posting', false)
  .option('--batch', 'Post all comments without prompting', false)
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

    try {
      await runReview({
        prNumber,
        repo: options.repo,
        harshness,
        dryRun: options.dryRun,
        batch: options.batch,
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
}

async function runReview(options: RunOptions): Promise<void> {
  const { prNumber, repo, harshness, dryRun, batch } = options;

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

  // Review with AI
  console.log(chalk.blue(`\n🤖 Reviewing with Claude (${harshness} mode)...`));
  const result = await reviewPR(truncatedDiff, pr.title, pr.body, harshness);

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
