import { execSync } from 'child_process';
import type { PRDetails, ExistingComment, ExistingReviewComment } from './types.js';

/**
 * Translate a raw `gh` failure into an actionable message.
 *
 * Without --repo, `gh` resolves the repository from the current directory's git remote. Run it
 * outside a git checkout (or in one with no GitHub remote) and it fails with git's raw
 * "not a git repository" / "no git remotes" text — which reads like a git or auth problem when
 * it actually just means "I don't know which repo you mean". Detect that specific case (only
 * when no --repo was supplied) and explain the real fix. Every other error falls through to the
 * original "GitHub CLI error: …" wrapping, with the command kept for debugging.
 */
export function friendlyGhError(rawMessage: string, repo: string | undefined, cmd: string): string {
  const noRepoResolved = /not a git repository|no git remotes|none of the git remotes/i.test(rawMessage);
  if (!repo && noRepoResolved) {
    return (
      'Could not determine which repository to use: no --repo was given and the current ' +
      'directory is not a git checkout (or it has no GitHub remote).\n' +
      'Fix: run lgtm from inside the repository, or pass --repo owner/repo ' +
      '(e.g. --repo EqualsGroup/em-transactions-api).'
    );
  }
  return `GitHub CLI error: ${rawMessage}\nCommand: ${cmd}`;
}

/**
 * Execute a gh CLI command and return the output
 */
function gh(args: string, repo?: string): string {
  const repoFlag = repo ? `-R ${repo}` : '';
  const cmd = `gh ${args} ${repoFlag}`.trim();
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error: any) {
    throw new Error(friendlyGhError(error?.message ?? String(error), repo, cmd));
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
 * Post multiple comments as a single review (batch)
 */
export function postBatchReview(
  prNumber: number,
  comments: Array<{ path: string; line: number; body: string }>,
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
      path: c.path,
      line: c.line,
      body: c.body,
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
 * Backward-compatible alias for old submit API
 */
export function submitReview(
  prNumber: number,
  comments: Array<{ file: string; line: number; body: string }>,
  repo?: string
): void {
  postBatchReview(
    prNumber,
    comments.map((c) => ({ path: c.file, line: c.line, body: c.body })),
    repo
  );
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

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }

  // Fetch all review comments (paginated)
  // --paginate with --jq outputs one JSON array per page; merge them
  const json = execSync(
    `gh api repos/${owner}/${repoName}/pulls/${prNumber}/comments --paginate --jq '[.[] | {id, node_id, path, line, original_line, body, user: .user.login, created_at, html_url}]'`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 }
  );

  if (!json.trim()) {
    return [];
  }

  const comments = json.trim().split('\n').reduce((acc: any[], line) => {
    if (!line.trim()) return acc;
    try {
      return acc.concat(JSON.parse(line));
    } catch {
      throw new Error(`Failed to parse PR comments response. Raw line: ${line.slice(0, 200)}`);
    }
  }, []);
  return comments.map((c: any) => ({
    id: c.id,
    nodeId: c.node_id,
    file: c.path,
    line: c.line ?? c.original_line ?? null,
    body: c.body,
    author: c.user || 'unknown',
    createdAt: c.created_at,
    url: c.html_url,
  }));
}

/**
 * Fetch existing PR review comments for deduplication
 */
export function getExistingReviewComments(prNumber: number, repo?: string): ExistingReviewComment[] {
  return getPRComments(prNumber, repo).map((comment) => ({
    path: comment.file,
    line: comment.line,
    body: comment.body,
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
  const envOwner = process.env.GITHUB_OWNER?.trim();
  const envRepo = process.env.GITHUB_REPO?.trim();
  if (envOwner && envRepo) {
    validateRepoComponents(envOwner, envRepo);
    return `${envOwner}/${envRepo}`;
  }

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
