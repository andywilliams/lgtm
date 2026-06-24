import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Optional knowledge-base ("second brain") integration — OFF by default and
 * invisible to anyone who hasn't configured a brain.
 *
 * lgtm asks a brain one question: *given a repo name, return markdown context*
 * (the repo's engineering handbook, plus related systems it touches). That context
 * is fed to the model so the review is grounded in how the service is built and
 * what it connects to — not just the diff.
 *
 * Three pluggable providers, tried in priority order; the first that yields
 * anything wins:
 *   1. LGTM_BRAIN_CMD  — run an arbitrary command (gets the repo as $LGTM_BRAIN_REPO
 *                        and as the final argument) and use its stdout. The escape
 *                        hatch: point this at ANY brain on ANY machine.
 *   2. LGTM_BRAIN_URL  — a second-brain HTTP API; pulls the handbook + one-hop
 *                        graph neighbours (relations + backlinks).
 *   3. LGTM_BRAIN_DIR  — a second-brain vault on disk (works with the server off);
 *                        handbook + neighbours resolved from frontmatter/wikilinks.
 *
 * Best-effort and fully defensive: no env, no match, server down, timeout, bad
 * output — all resolve to '' so a review is NEVER blocked by this.
 */

const TIMEOUT_MS = 2500;
const HANDBOOK_MAX = 9000; // chars of the primary handbook
const RELATED_MAX = 1400; // chars per related note
const MAX_RELATED = 5; // how many neighbours to pull
const VAULT_SUBDIRS = ['memories', 'projects', 'people', 'areas', 'events'];
const SKIP_TYPES = new Set(['area', 'person', 'event']); // hubs/people aren't useful as code context

interface NoteLite {
  title: string;
  body: string;
  type?: string;
}

// --- helpers ---------------------------------------------------------------

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

function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '').trimStart();
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n… (truncated)' : s;
}

/** Mark a resolved id — plus its handbook/stub twin — as seen, to avoid duplicates. */
function markSeen(seen: Set<string>, rid: string): void {
  const base = rid.endsWith('-handbook') ? rid.slice(0, -'-handbook'.length) : rid;
  seen.add(rid);
  seen.add(base);
  seen.add(`${base}-handbook`);
}

/** Assemble the standard "Codebase Handbook Context" section (handbook + related). */
function assemble(mainTitle: string, mainBody: string, related: NoteLite[]): string {
  let s =
    `\n## Codebase Handbook Context\n` +
    `Background from the team's engineering knowledge base — design constraints, known ` +
    `gotchas, how the service is built, and the related systems it touches. Use it to ground ` +
    `the review; it is context, not something the PR must restate. Do NOT flag an issue merely ` +
    `because the diff doesn't mention something here.\n\n` +
    `### ${mainTitle}\n${clip(mainBody, HANDBOOK_MAX)}\n`;
  if (related.length) {
    s +=
      `\n### Related systems (linked in the brain's knowledge graph)\n` +
      `Connected to this repo in the graph; may matter for changes that touch shared concerns. Condensed.\n`;
    for (const r of related) s += `\n#### ${r.title}\n${clip(r.body, RELATED_MAX)}\n`;
  }
  return s;
}

/** Order candidate neighbour ids so dedicated `-handbook` notes come first. */
function handbookFirst(ids: string[], repo: string): string[] {
  const cand = [...new Set(ids)].filter((id) => id && id !== repo && id !== `${repo}-handbook`);
  return [...cand.filter((x) => x.endsWith('-handbook')), ...cand.filter((x) => !x.endsWith('-handbook'))];
}

// --- provider 1: arbitrary command ----------------------------------------

function fromCmd(cmd: string, repo: string): string {
  try {
    const out = execSync(`${cmd} ${repo}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LGTM_BRAIN_REPO: repo },
    }).trim();
    if (!out) return '';
    return (
      `\n## Codebase Handbook Context\n` +
      `Provided by the configured brain command for \`${repo}\`. Use it to ground the review.\n\n` +
      clip(out, HANDBOOK_MAX + MAX_RELATED * RELATED_MAX) +
      `\n`
    );
  } catch {
    return '';
  }
}

// --- provider 2: second-brain HTTP API ------------------------------------

async function fetchNote(root: string, id: string): Promise<any | null> {
  try {
    const res = await fetch(`${root}/api/notes/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fromUrl(base: string, repo: string): Promise<string> {
  const root = base.replace(/\/$/, '');
  const main = await fetchNote(root, `${repo}-handbook`);
  if (!main || typeof main.body !== 'string' || !main.body.trim()) return '';

  // Gather one-hop neighbours from resolved relations + backlinks (present only).
  const ids: string[] = [];
  for (const r of main.relations ?? []) if (r?.id && r.present !== 0) ids.push(r.id);
  for (const b of main.backlinks ?? []) if (b?.id) ids.push(b.id);

  const related: NoteLite[] = [];
  const seen = new Set<string>([`${repo}-handbook`, repo]);
  for (const cand of handbookFirst(ids, repo)) {
    if (related.length >= MAX_RELATED) break;
    const rid = cand.endsWith('-handbook') ? cand : `${cand}-handbook`;
    let note = seen.has(rid) ? null : await fetchNote(root, rid);
    if (!note && !cand.endsWith('-handbook') && !seen.has(cand)) note = await fetchNote(root, cand);
    if (!note || typeof note.body !== 'string' || !note.body.trim()) continue;
    markSeen(seen, rid);
    if (SKIP_TYPES.has(note.type)) continue;
    related.push({ title: note.title || rid, body: note.body });
  }
  return assemble(main.title || `${repo}-handbook`, main.body, related);
}

// --- provider 3: second-brain vault on disk -------------------------------

function readNoteFile(dir: string, id: string): NoteLite | null {
  for (const sub of VAULT_SUBDIRS) {
    const p = join(dir, sub, `${id}.md`);
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf-8');
      const t = raw.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      const ty = raw.match(/^type:\s*([a-z]+)\s*$/m);
      return { title: t ? t[1] : id, body: stripFrontmatter(raw), type: ty ? ty[1] : undefined };
    }
  }
  return null;
}

function fromDir(dir: string, repo: string): string {
  try {
    const mem = join(dir, 'memories');
    if (!existsSync(mem)) return '';
    let hbPath = join(mem, `${repo}-handbook.md`);
    if (!existsSync(hbPath)) {
      const hit = readdirSync(mem).find((f) => f.endsWith('-handbook.md') && f.startsWith(repo));
      if (!hit) return '';
      hbPath = join(mem, hit);
    }
    const raw = readFileSync(hbPath, 'utf-8');
    const mainTitle = raw.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? `${repo}-handbook`;
    const mainBody = stripFrontmatter(raw);

    // Neighbours from frontmatter relations (`to: <id>`) and body wiki-links.
    const relIds = [...raw.matchAll(/to:\s*([a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]);
    const wikiIds = [...mainBody.matchAll(/\[\[([a-z0-9][a-z0-9-]*)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1]);

    const related: NoteLite[] = [];
    const seen = new Set<string>([`${repo}-handbook`, repo]);
    for (const cand of handbookFirst([...relIds, ...wikiIds], repo)) {
      if (related.length >= MAX_RELATED) break;
      const rid = cand.endsWith('-handbook') ? cand : `${cand}-handbook`;
      let note = seen.has(rid) ? null : readNoteFile(dir, rid);
      if (!note && !cand.endsWith('-handbook') && !seen.has(cand)) note = readNoteFile(dir, cand);
      if (!note || !note.body.trim()) continue;
      markSeen(seen, rid);
      if (note.type && SKIP_TYPES.has(note.type)) continue;
      related.push(note);
    }
    return assemble(mainTitle, mainBody, related);
  } catch {
    return '';
  }
}

// --- public API ------------------------------------------------------------

/**
 * Returns a handbook-context block for the repo under review, or '' if no brain is
 * configured / nothing matches. Never throws.
 */
export async function fetchBrainContext(repo?: string): Promise<string> {
  const cmd = process.env.LGTM_BRAIN_CMD?.trim();
  const url = process.env.LGTM_BRAIN_URL?.trim();
  const dir = process.env.LGTM_BRAIN_DIR?.trim();
  if (!cmd && !url && !dir) return ''; // feature off — the default for everyone without a brain

  const repoName = resolveRepoName(repo);
  if (!repoName) return '';

  if (cmd) {
    const ctx = fromCmd(cmd, repoName);
    if (ctx) return ctx;
  }
  if (url) {
    const ctx = await fromUrl(url, repoName);
    if (ctx) return ctx;
  }
  if (dir) {
    const ctx = fromDir(dir, repoName);
    if (ctx) return ctx;
  }
  return '';
}
