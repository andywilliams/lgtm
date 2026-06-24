import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Optional second-brain integration — OFF by default and invisible to anyone who
 * doesn't run a local knowledge vault.
 *
 * If LGTM_BRAIN_DIR points at a second-brain vault (or LGTM_BRAIN_URL at its API),
 * lgtm pulls the engineering handbook for the repo under review and feeds it to the
 * model as domain context: known design constraints, gotchas, and how the service
 * is built. The handbook follows the vault convention `<repo>-handbook`
 * (e.g. em-transactions-api -> em-transactions-api-handbook).
 *
 * Best-effort and fully defensive: no env var, no vault, no matching handbook, a
 * server that's down, or a timeout ALL resolve to '' so a review is never blocked.
 */

const TIMEOUT_MS = 2500;
const MAX_CHARS = 12000; // keep the injected context bounded

/** Resolve the repo's short name from an explicit owner/repo, else the local git root. */
function resolveRepoName(repo?: string): string | null {
  if (repo) return repo.includes('/') ? repo.split('/').pop()! : repo;
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();
    return root ? root.split('/').pop()! : null;
  } catch {
    return null;
  }
}

/** Drop YAML frontmatter so only the note body is fed to the model. */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '').trimStart();
}

function wrap(title: string, body: string): string {
  const trimmed =
    body.length > MAX_CHARS ? body.slice(0, MAX_CHARS) + '\n... (handbook truncated)' : body;
  return (
    `\n## Codebase Handbook Context\n` +
    `Background knowledge about this repository from the team's engineering handbook — ` +
    `design constraints, known gotchas, and how the service is built. Use it to ground the ` +
    `review; it is context, not something the PR must restate. Do NOT flag an issue merely ` +
    `because the diff doesn't mention something here.\n\n` +
    `### ${title}\n${trimmed}\n`
  );
}

/** Read the handbook straight from the vault on disk (preferred — no server needed). */
function fromDir(dir: string, repoName: string): string {
  try {
    const memories = join(dir, 'memories');
    if (!existsSync(memories)) return '';
    const exact = join(memories, `${repoName}-handbook.md`);
    let file = existsSync(exact) ? exact : '';
    if (!file) {
      // Fall back to a handbook whose filename starts with the repo name.
      const hit = readdirSync(memories).find(
        (f) => f.endsWith('-handbook.md') && f.startsWith(repoName)
      );
      if (hit) file = join(memories, hit);
    }
    if (!file) return '';
    const raw = readFileSync(file, 'utf-8');
    const titleMatch = raw.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    const title = titleMatch ? titleMatch[1] : `${repoName}-handbook`;
    const body = stripFrontmatter(raw);
    return body.trim() ? wrap(title, body) : '';
  } catch {
    return '';
  }
}

/** Fetch the handbook from the second-brain HTTP API (fallback when only a URL is set). */
async function fromUrl(base: string, repoName: string): Promise<string> {
  try {
    const id = encodeURIComponent(`${repoName}-handbook`);
    const url = `${base.replace(/\/$/, '')}/api/notes/${id}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return '';
    const note = (await res.json()) as { body?: unknown; title?: unknown };
    const body = typeof note?.body === 'string' ? note.body : '';
    const title = typeof note?.title === 'string' ? note.title : `${repoName}-handbook`;
    return body.trim() ? wrap(title, body) : '';
  } catch {
    return '';
  }
}

/**
 * Returns a handbook-context block for the repo under review, or '' if no brain is
 * configured / nothing matches. Never throws.
 */
export async function fetchBrainContext(repo?: string): Promise<string> {
  const dir = process.env.LGTM_BRAIN_DIR?.trim();
  const url = process.env.LGTM_BRAIN_URL?.trim();
  if (!dir && !url) return ''; // feature off — the default for everyone without a vault

  const repoName = resolveRepoName(repo);
  if (!repoName) return '';

  if (dir) {
    const ctx = fromDir(dir, repoName);
    if (ctx) return ctx;
  }
  if (url) return fromUrl(url, repoName);
  return '';
}
