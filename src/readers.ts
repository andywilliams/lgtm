import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * "Who else READS what this WRITES?" — the question a diff review structurally cannot
 * answer, because the reader never appears in the diff. This module answers it the cheap
 * deterministic way: pull the identifiers the change WRITES out of the diff (event type
 * strings, table names, persisted field names, exported symbols), grep for them outside
 * the changed files — including sibling repos when configured — and hand the reviewer the
 * places that consume them.
 *
 * The motivating case (DWLF-127 / indicators e4ea81e): a new `cycle.low.break` event was
 * emitted in one repo; another repo keyed its DynamoDB rows on that event's
 * `payload.pivotTime`. Nothing in the diff hinted at the second repo, and 28 review
 * rounds never found it.
 */

export interface WriteIdentifier {
  id: string;
  /** Why this string counts as something the change writes — shown to the reviewer. */
  why: string;
}

const MAX_IDENTIFIERS = 8;
const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[jt]sx?$|\.vitest\./;

/**
 * The diff's added lines, with test files left out: a fixture writes nothing production
 * reads, and its helpers would otherwise crowd out the real payload builder.
 */
export function addedProductionLines(diff: string): string[] {
  const out: string[] = [];
  let inTest = false;
  for (const line of diff.split('\n')) {
    const header = line.match(/^\+\+\+ b\/(.+)$/);
    if (header) { inTest = TEST_FILE.test(header[1]); continue; }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (!inTest && line.startsWith('+')) out.push(line.slice(1));
  }
  return out;
}

/** Identifiers the diff's ADDED lines write, most specific first. */
export function extractWriteIdentifiers(diff: string): WriteIdentifier[] {
  const added = addedProductionLines(diff);
  const found = new Map<string, string>();
  const add = (id: string, why: string) => {
    const key = id.trim();
    if (key.length < 3 || found.has(key)) return;
    found.set(key, why);
  };

  for (const line of added) {
    // Event / topic / message type literals: 'cycle.low.break', "order.filled".
    for (const m of line.matchAll(/['"`]([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)['"`]/g)) {
      add(m[1], 'event type emitted here');
    }
    // Table / collection names, however they are spelled in this stack.
    for (const m of line.matchAll(/\b([A-Z]\w*Table)\b/g)) add(m[1], 'table written here');
    for (const m of line.matchAll(/TableName\s*[:=]\s*['"`]?([\w.-]+)/g)) add(m[1], 'table written here');
    for (const m of line.matchAll(/process\.env\.(\w*TABLE\w*)/g)) add(m[1], 'table written here');
    // Fields written onto a persisted object: payload.pivotTime = …, item.status = …
    for (const m of line.matchAll(/\b(?:payload|item|record|row|event|doc|entity)\.(\w{3,})\s*=/g)) {
      add(m[1], 'field written onto a persisted object');
    }
    // Symbols this repo exports — someone else's import target.
    for (const m of line.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) add(m[1], 'exported symbol changed here');
    for (const m of line.matchAll(/export\s+(?:const|class|interface|type)\s+(\w+)/g)) add(m[1], 'exported symbol changed here');
  }
  return [...found.entries()].slice(0, MAX_IDENTIFIERS).map(([id, why]) => ({ id, why }));
}

/**
 * One hop out from the diff: the payload a change emits is usually built by a helper the
 * added lines CALL rather than spelled out in them, so the field names a consumer keys on
 * are invisible to a diff. (indicators e4ea81e spread `createPayload(next)`; a job in
 * another repo keyed its rows on the `pivotTime` that helper carries, and no review round
 * ever saw the connection.) This finds the helpers the added lines call, reads the fields
 * they assign, and treats those as things the change writes too.
 */
export function fieldsFromHelpers(diff: string, repoRoot: string, maxHelpers = 3): WriteIdentifier[] {
  const added = addedProductionLines(diff);
  const helpers = new Set<string>();
  // Spread first: `...createPayload(x)` IS the emitted object, where a `makeThing()`
  // elsewhere in the diff may be anything. Order decides which survive the cap.
  const spread = new Set<string>();
  const named = new Set<string>();
  for (const line of added) {
    for (const m of line.matchAll(/\.\.\.(\w{4,})\s*\(/g)) spread.add(m[1]);
    for (const m of line.matchAll(/\b((?:create|build|make|to)[A-Z]\w+)\s*\(/g)) named.add(m[1]);
  }
  for (const h of [...spread, ...named]) helpers.add(h);
  const out: WriteIdentifier[] = [];
  for (const helper of [...helpers].slice(0, maxHelpers)) {
    for (const file of definitionFiles(helper, repoRoot)) {
      for (const field of fieldsAssignedIn(file, helper)) {
        out.push({ id: field, why: `field carried by \`${helper}()\`, which this change emits` });
      }
    }
  }
  return out;
}

/** Files in the repo that DEFINE this helper (not the ones that call it). */
function definitionFiles(name: string, repoRoot: string): string[] {
  const pattern = `(function ${name}|const ${name} =|${name}: \\(|${name} = \\()`;
  const files: string[] = [];
  for (const [cmd, args] of [
    ['rg', ['--line-number', '--no-heading', '--color=never', '--glob=!node_modules', '--glob=!dist', '-e', pattern, repoRoot]],
    ['grep', ['-rnE', '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=.git', pattern, repoRoot]],
  ] as [string, string[]][]) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 });
      for (const row of out.split('\n')) {
        const m = row.match(/^(.+?):\d+:/);
        if (m && !files.includes(m[1])) files.push(m[1]);
        if (files.length >= 2) break;
      }
      return files;
    } catch (e: any) {
      if (e?.status === 1) return [];
    }
  }
  return files;
}

/** The object keys a helper assigns — its payload's shape, as far as a regex can see it. */
function fieldsAssignedIn(file: string, helper: string, maxFields = 8): string[] {
  let text: string;
  try { text = readFileSync(file, 'utf-8'); } catch { return []; }
  const start = text.search(new RegExp(`(function\\s+${helper}\\b|const\\s+${helper}\\s*=|\\b${helper}\\s*[:=]\\s*\\()`));
  if (start === -1) return [];
  // A window, not a parse: enough to cover a payload builder, cheap and predictable.
  const body = text.slice(start, start + 4000);
  const fields = new Set<string>();
  for (const m of body.matchAll(/^\s*(\w{3,})\s*:/gm)) fields.add(m[1]);
  for (const m of body.matchAll(/\b(?:payload|result|out|obj)\.(\w{3,})\s*=/g)) fields.add(m[1]);
  const noise = new Set(['type', 'name', 'value', 'data', 'return', 'const', 'this', 'true', 'false', 'null', 'string', 'number', 'boolean', 'default', 'case']);
  return [...fields].filter((f) => !noise.has(f)).slice(0, maxFields);
}

export interface ReaderHit {
  identifier: string;
  why: string;
  /** Absolute path of the reading file. */
  file: string;
  /** The repo root it was found under, so the excerpt can name a foreign repo plainly. */
  root: string;
  lines: { line: number; text: string }[];
}

/** Search roots: the repo, plus any sibling repos configured for cross-repo reads. */
export function searchRoots(repoRoot: string, addDirs: string[] = []): string[] {
  const fromEnv = (process.env.LGTM_SIBLING_DIRS ?? '')
    .split(':')
    .map((d) => d.trim())
    .filter(Boolean);
  const roots = [repoRoot, ...addDirs, ...fromEnv].map((d) => resolve(d));
  return [...new Set(roots)].filter((d) => existsSync(d));
}

function grepFor(id: string, root: string, maxFiles: number, maxPerFile = 6): { file: string; line: number; text: string }[] {
  // ripgrep when present (fast, respects .gitignore); grep -rn is the fallback so a
  // machine without rg still gets the context rather than silently getting none.
  const rg = ['--fixed-strings', '--line-number', '--no-heading', '--color=never', `--max-count=${maxPerFile}`,
    '--glob=!node_modules', '--glob=!dist', '--glob=!*.map', '--glob=!*.lock', '--glob=!package-lock.json', id, root];
  const grep = ['-rn', '--fixed-strings', '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=.git', id, root];
  for (const [cmd, args] of [['rg', rg], ['grep', grep]] as [string, string[]][]) {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
      const hits: { file: string; line: number; text: string }[] = [];
      for (const row of out.split('\n')) {
        const m = row.match(/^(.+?):(\d+):(.*)$/);
        if (!m) continue;
        hits.push({ file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 300) });
        if (hits.length >= maxFiles * maxPerFile * 2) break;
      }
      return hits;
    } catch (e: any) {
      // grep/rg exit 1 means "no matches" — that is an answer, not a failure.
      if (e?.status === 1) return [];
      // A missing binary falls through to the next candidate.
    }
  }
  return [];
}

export interface FindReadersOptions {
  /** Files the diff changes — a reader inside the change is not a reader elsewhere. */
  changedFiles: string[];
  /** Per REPOSITORY, not per identifier: a foreign reader always gets a slot. */
  maxFilesPerRoot?: number;
  maxTotalLines?: number;
}

/** Where each written identifier is read, outside the files the diff changes. */
export function findReaders(identifiers: WriteIdentifier[], roots: string[], options: FindReadersOptions): ReaderHit[] {
  const { changedFiles, maxFilesPerRoot = 3, maxTotalLines = 160 } = options;
  const changed = new Set(changedFiles.map((f) => resolve(f)));
  const hits: ReaderHit[] = [];
  let lineBudget = maxTotalLines;

  for (const { id, why } of identifiers) {
    if (lineBudget <= 0) break;
    for (const root of roots) {
      // Budgeted per repository: a reader in a sibling repo is the finding this exists
      // for, and it must never be crowded out by this repo's own uses of the name.
      const byFile = new Map<string, { line: number; text: string }[]>();
      const raw = grepFor(id, root, maxFilesPerRoot);
      // Production files before tests: a fixture that mentions the name is not a consumer.
      raw.sort((a, b) => Number(TEST_FILE.test(a.file)) - Number(TEST_FILE.test(b.file)));
      for (const h of raw) {
        const abs = resolve(h.file);
        if (changed.has(abs)) continue;
        if (!byFile.has(abs)) {
          if (byFile.size >= maxFilesPerRoot) continue;
          byFile.set(abs, []);
        }
        const lines = byFile.get(abs)!;
        // Spread the excerpt across the file rather than taking the first few lines: in a
        // 2,000-line consumer the definition sits near the top and the code that PERSISTS
        // what it read sits far below, and only the second one shows a keying bug.
        if (lines.length < 4 && (lines.length < 2 || h.line - lines[lines.length - 1].line > 30)) {
          lines.push({ line: h.line, text: h.text });
        }
      }
      for (const [file, lines] of byFile) {
        if (lineBudget <= 0) break;
        const kept = lines.slice(0, Math.max(1, Math.min(lines.length, lineBudget)));
        lineBudget -= kept.length;
        hits.push({ identifier: id, why, file, root, lines: kept });
      }
    }
  }
  return hits;
}

/** The prompt section. Empty string when nothing reads anything the diff writes. */
export function formatReadersContext(hits: ReaderHit[], repoRoot: string): string {
  if (hits.length === 0) return '';
  const byId = new Map<string, ReaderHit[]>();
  for (const h of hits) {
    if (!byId.has(h.identifier)) byId.set(h.identifier, []);
    byId.get(h.identifier)!.push(h);
  }
  let out = `\n## Readers of what this diff writes\n`;
  out += `Each identifier below is something this change WRITES, followed by the places that READ it — found by searching outside the changed files. A reader in another repository is marked as such; it cannot see this diff.\n\n`;
  for (const [id, group] of byId) {
    out += `### \`${id}\` — ${group[0].why}\n`;
    for (const h of group) {
      const foreign = !h.file.startsWith(repoRoot);
      const label = foreign ? `${h.file} (ANOTHER REPOSITORY)` : relative(repoRoot, h.file);
      out += `- ${label}\n`;
      for (const l of h.lines) out += `  ${l.line}: ${l.text}\n`;
    }
    out += '\n';
  }
  out += `For each reader above, say whether this change alters what it will observe — the shape it reads, the order it sees, the key it stores under, the value it branches on. If a reader is in another repository it CANNOT have been updated by this diff, so an incompatible change there is a defect in this one. If you cannot tell from the lines shown, ask the question rather than assuming it is fine.\n`;
  return out;
}
