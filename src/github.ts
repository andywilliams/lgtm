import { execSync } from 'child_process';
import type { PRDetails } from './types.js';

/**
 * Execute a gh CLI command and return the output
 */
function gh(args: string, repo?: string): string {
  const repoFlag = repo ? `-R ${repo}` : '';
  const cmd = `gh ${args} ${repoFlag}`.trim();
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error: any) {
    throw new Error(`GitHub CLI error: ${error.message}\nCommand: ${cmd}`);
  }
}

/**
 * Fetch PR details
 */
export function getPRDetails(prNumber: number, repo?: string): PRDetails {
  const json = gh(
    `pr view ${prNumber} --json number,title,body,author,baseRefName,headRefName,additions,deletions,changedFiles`,
    repo
  );
  const data = JSON.parse(json);
  return {
    number: data.number,
    title: data.title,
    body: data.body || '',
    author: data.author?.login || 'unknown',
    baseRef: data.baseRefName,
    headRef: data.headRefName,
    additions: data.additions,
    deletions: data.deletions,
    changedFiles: data.changedFiles,
  };
}

/**
 * Fetch PR diff
 */
export function getPRDiff(prNumber: number, repo?: string): string {
  return gh(`pr diff ${prNumber}`, repo);
}

/**
 * Fetch list of changed files
 */
export function getChangedFiles(prNumber: number, repo?: string): string[] {
  const json = gh(`pr view ${prNumber} --json files`, repo);
  const data = JSON.parse(json);
  return (data.files || []).map((f: { path: string }) => f.path);
}

/**
 * Post a review comment on a PR
 */
export function postReviewComment(
  prNumber: number,
  file: string,
  line: number,
  body: string,
  repo?: string
): void {
  // Use gh api to post a review comment
  const repoPath = repo || getRepoFromGit();
  const [owner, repoName] = repoPath.split('/');
  
  // First we need the commit SHA of the PR head
  const prJson = gh(`pr view ${prNumber} --json headRefOid`, repo);
  const { headRefOid } = JSON.parse(prJson);
  
  const payload = JSON.stringify({
    body,
    commit_id: headRefOid,
    path: file,
    line,
    side: 'RIGHT',
  });
  
  const cmd = `api repos/${owner}/${repoName}/pulls/${prNumber}/comments -X POST --input -`;
  execSync(`gh ${cmd}`, {
    input: payload,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Post multiple comments as a single review
 */
export function submitReview(
  prNumber: number,
  comments: Array<{ file: string; line: number; body: string }>,
  repo?: string
): void {
  const repoPath = repo || getRepoFromGit();
  const [owner, repoName] = repoPath.split('/');
  
  // Get commit SHA
  const prJson = gh(`pr view ${prNumber} --json headRefOid`, repo);
  const { headRefOid } = JSON.parse(prJson);
  
  const payload = JSON.stringify({
    commit_id: headRefOid,
    event: 'COMMENT',
    comments: comments.map(c => ({
      path: c.file,
      line: c.line,
      body: c.body,
      side: 'RIGHT',
    })),
  });
  
  const cmd = `api repos/${owner}/${repoName}/pulls/${prNumber}/reviews -X POST --input -`;
  execSync(`gh ${cmd}`, {
    input: payload,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Get repo from current git directory
 */
function getRepoFromGit(): string {
  try {
    const remote = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
    // Parse github.com:owner/repo.git or https://github.com/owner/repo.git
    const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) {
      return `${match[1]}/${match[2]}`;
    }
  } catch {
    // ignore
  }
  throw new Error('Could not determine repo. Use --repo owner/repo');
}
