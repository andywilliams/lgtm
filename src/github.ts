import { execSync } from 'child_process';
import type { PRDetails, ExistingComment } from './types.js';

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

  validateRepoComponents(owner, repoName);

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

  validateRepoComponents(owner, repoName);

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
 * Fetch the content of a file from a PR branch
 */
export function getFileContent(prNumber: number, filePath: string, repo?: string): string | null {
  try {
    const repoPath = repo || getRepoFromGit();
    const [owner, repoName] = repoPath.split('/');

    validateRepoComponents(owner, repoName);

    // Get the head ref of the PR
    const prJson = gh(`pr view ${prNumber} --json headRefName`, repo);
    const { headRefName } = JSON.parse(prJson);
    
    // Fetch file content from that branch
    const content = execSync(
      `gh api repos/${owner}/${repoName}/contents/${encodeURIComponent(filePath)}?ref=${headRefName} --jq '.content'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    
    // Content is base64 encoded
    return Buffer.from(content, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Fetch existing review comments on a PR
 */
export function getPRComments(prNumber: number, repo?: string): ExistingComment[] {
  const repoPath = repo || getRepoFromGit();
  const [owner, repoName] = repoPath.split('/');

  validateRepoComponents(owner, repoName);

  // Fetch all review comments (paginated)
  // --paginate with --jq outputs one JSON array per page; merge them
  const json = execSync(
    `gh api repos/${owner}/${repoName}/pulls/${prNumber}/comments --paginate --jq '[.[] | {id, node_id, path, line, original_line, body, user: .user, created_at, html_url}]'`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 }
  );

  if (!json.trim()) {
    return [];
  }

  const comments = json.trim().split('\n').reduce((acc: any[], line) => {
    const parsed = JSON.parse(line);
    return acc.concat(parsed);
  }, []);
  return comments.map((c: any) => ({
    id: c.id,
    nodeId: c.node_id,
    file: c.path,
    line: c.line ?? c.original_line ?? null,
    body: c.body,
    author: c.user?.login || 'unknown',
    createdAt: c.created_at,
    url: c.html_url,
  }));
}

/**
 * Resolve (minimize/hide) a review comment on a PR
 * Uses the GraphQL API to minimize the comment as "RESOLVED"
 */
export function resolveComment(nodeId: string): void {
  const query = JSON.stringify({
    query: `mutation($id: ID!) {
      minimizeComment(input: {subjectId: $id, classifier: RESOLVED}) {
        minimizedComment { isMinimized }
      }
    }`,
    variables: { id: nodeId }
  });

  const result = execSync(`gh api graphql --input -`, {
    input: query,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const response = JSON.parse(result);
  if (response.errors?.length) {
    throw new Error(`GraphQL error: ${response.errors[0].message}`);
  }
}

/**
 * Validate owner and repo name components to prevent shell injection
 */
function validateRepoComponents(owner: string, repoName: string): void {
  const valid = /^[a-zA-Z0-9._-]+$/;
  if (!valid.test(owner) || !valid.test(repoName)) {
    throw new Error(`Invalid repository format: ${owner}/${repoName}`);
  }
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
