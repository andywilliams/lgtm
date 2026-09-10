import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A map of the repository, for the architecture altitude. `lgtm arch` is asked to judge
 * PLACEMENT ("does this belong here?") and to make COUNTED pattern claims ("6 of 7
 * handlers do X") — but it is shown only the files the diff touches, so every such claim
 * outside the diff is a guess it is explicitly told not to make. A directory census, the
 * package's entry points and the workflow names are a few hundred tokens and turn that
 * silence into something checkable.
 */

export interface RepoMap {
  block: string;
  truncated: boolean;
}

const DEFAULT_MAX_BYTES = 8_000;

/** Tracked files, or null when this is not a git checkout. */
function trackedFiles(repoRoot: string): string[] | null {
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'ls-files'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
    });
    const files = out.split('\n').filter(Boolean);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

/**
 * Which directory a file is counted under: two levels, because `src/services` tells you
 * where handlers live and `src` alone does not. One definition — the census and the
 * "how many were left out" count must never disagree about what a directory is.
 */
function directoryKey(file: string): string {
  const parts = file.split('/');
  return parts.length === 1 ? '(root)' : parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

/** Directory census, two levels deep, biggest first — the shape a placement claim needs. */
export function directoryCensus(files: string[], maxDirs = 40): { dir: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const dir = directoryKey(f);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
    .slice(0, maxDirs);
}

/** How many distinct directories the repo has, so the caveat can be exact. */
export function directoryCount(files: string[]): number {
  return new Set(files.map(directoryKey)).size;
}

/** What this package exposes — the interface a placement decision is judged against. */
function entryPoints(repoRoot: string): string[] {
  const p = join(repoRoot, 'package.json');
  if (!existsSync(p)) return [];
  try {
    const pkg = JSON.parse(readFileSync(p, 'utf-8'));
    const out: string[] = [];
    if (pkg.main) out.push(`main: ${pkg.main}`);
    if (pkg.bin) out.push(`bin: ${typeof pkg.bin === 'string' ? pkg.bin : Object.keys(pkg.bin).join(', ')}`);
    if (pkg.exports) {
      // `exports` is legally a string or an array as well as a map of subpaths;
      // Object.keys on a string yields character indices.
      const e = pkg.exports;
      const shown = typeof e === 'string' ? e : Array.isArray(e) ? e.join(', ') : Object.keys(e).join(', ');
      out.push(`exports: ${shown}`);
    }
    if (pkg.files) out.push(`files: ${(pkg.files as string[]).join(', ')}`);
    return out;
  } catch {
    return [];
  }
}

/** Workflow names — what this repo does on its own, without anyone asking. */
function workflows(files: string[]): string[] {
  return files
    .filter((f) => f.startsWith('.github/workflows/'))
    .map((f) => f.replace('.github/workflows/', ''))
    .sort();
}

/**
 * The prompt block. Empty when the repo cannot be mapped (not a checkout, no files) —
 * an empty map is reported as a skipped check rather than passed off as a small repo.
 */
export function buildRepoMap(repoRoot: string, maxBytes = DEFAULT_MAX_BYTES): RepoMap {
  const files = trackedFiles(repoRoot);
  if (!files) return { block: '', truncated: false };

  const census = directoryCensus(files);
  const total = directoryCount(files);
  const omitted = total - census.length;
  const entries = entryPoints(repoRoot);
  const flows = workflows(files);

  let block = `\n## Repository map (${files.length} tracked files, ${total} directories`;
  block += omitted > 0 ? `, ${census.length} largest shown)\n` : ')\n';
  block += `Use it for PLACEMENT and for COUNTED pattern claims: "11 files live under src/handlers/, this one is under src/services/" is a \`codebase-pattern\` claim you can make from this map. A count you cannot make from the map or the file contents provided stays \`judgement\`. The map lists directories and counts, NOT every file, and ${omitted > 0 ? `${omitted} smaller directories are not listed` : 'every directory is listed'} — the absence of a file, or of a directory, is not evidence it does not exist.\n\n`;
  block += census.map(({ dir, count }) => `- ${dir}/ — ${count}`).join('\n') + '\n';
  if (entries.length > 0) block += `\nPackage entry points: ${entries.join(' · ')}\n`;
  if (flows.length > 0) block += `Workflows: ${flows.join(', ')}\n`;

  if (block.length > maxBytes) {
    return { block: block.slice(0, maxBytes) + '\n… (map truncated)\n', truncated: true };
  }
  return { block, truncated: false };
}
