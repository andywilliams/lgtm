import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fetchBrainNote } from './brain.js';

/**
 * The architecture charter chain — lgtm's built-in, repo-resident review context.
 * Works standalone: no second brain required.
 *
 * Two documents, two altitudes:
 *   1. The repo's charter (`ARCHITECTURE.md`) — NORMATIVE. What this repo is for, what
 *      must not live here, its interfaces, invariants and standing decisions. This is
 *      what lets an arch finding claim `charter` authority instead of `judgement`.
 *   2. The system doc (`SYSTEM.md`) — the level above the repo. The repos of the wider
 *      system, their one-line responsibilities, and the CONTRACTS between them (who
 *      talks to whom, via what, who owns the schema). Resolved via the charter's
 *      `system:` frontmatter pointer (a local path, typically a sibling checkout of a
 *      dedicated system repo) or the LGTM_SYSTEM_DIR env var.
 *
 * If the repo has no charter file, an optional second-brain `<repo>-charter` note is
 * tried as a fallback — brain configured or not, everything here is best-effort and
 * a missing document is reported (so the reviewer can say which checks were skipped),
 * never an error.
 */

const CHARTER_CANDIDATES = ['ARCHITECTURE.md', join('docs', 'ARCHITECTURE.md'), join('.lgtm', 'ARCHITECTURE.md')];
const CHARTER_MAX = 14000; // chars fed to the model
const SYSTEM_MAX = 14000;

export interface Charter {
  path: string; // absolute path of the file found
  raw: string;
  body: string; // frontmatter stripped
  title?: string;
  systemRef?: string; // `system:` frontmatter field, if declared
}

export interface SystemDoc {
  path: string;
  content: string;
}

export interface ArchitectureContext {
  /** Prompt-ready charter block, or '' when no charter was found anywhere. */
  charterBlock: string;
  /** Prompt-ready system block, or '' when no system doc resolves. */
  systemBlock: string;
  charterPath?: string;
  systemPath?: string;
  charterSource?: 'repo' | 'brain';
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '').trimStart();
}

/** Read a scalar frontmatter field (only from an actual leading frontmatter block). */
function frontmatterField(raw: string, name: string): string | undefined {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return undefined;
  const m = fm[1].match(new RegExp(`^${name}:\\s*["']?(.+?)["']?\\s*(?:#.*)?$`, 'm'));
  return m?.[1]?.trim() || undefined;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '\n… (truncated)' : s;
}

/** Locate and parse the repo's charter file, if it has one. */
export function findCharter(repoRoot: string): Charter | null {
  for (const cand of CHARTER_CANDIDATES) {
    const p = join(repoRoot, cand);
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf-8');
      if (!raw.trim()) continue;
      return {
        path: p,
        raw,
        body: stripFrontmatter(raw),
        title: frontmatterField(raw, 'title'),
        systemRef: frontmatterField(raw, 'system'),
      };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolve the system-level doc. Tries the charter's `system:` pointer first, then
 * LGTM_SYSTEM_DIR. Each may name the doc itself or a directory containing SYSTEM.md.
 * Remote refs (http/git URLs) are not fetched in this version — declare a local path
 * to a checkout instead (documented in the template).
 */
export function resolveSystemDoc(repoRoot: string, systemRef?: string): SystemDoc | null {
  const refs = [systemRef, process.env.LGTM_SYSTEM_DIR?.trim()].filter((r): r is string => Boolean(r));
  for (const ref of refs) {
    if (/^(https?:\/\/|git@)/.test(ref)) continue; // local-path resolution only (for now)
    const base = isAbsolute(ref) ? ref : resolve(repoRoot, ref);
    if (!existsSync(base)) continue;
    try {
      // A directory ref must contain a SYSTEM.md — accepting e.g. an ARCHITECTURE.md
      // there would silently promote an ordinary sibling repo's CHARTER to system
      // authority on a typo'd pointer. Naming a file directly is explicit intent.
      const candidates = statSync(base).isDirectory() ? [join(base, 'SYSTEM.md')] : [base];
      for (const p of candidates) {
        if (!existsSync(p)) continue;
        const content = readFileSync(p, 'utf-8');
        if (content.trim()) return { path: p, content: stripFrontmatter(content) };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Assemble the prompt-ready architecture context for a repo: charter block (in-repo
 * file first, brain `<repo>-charter` note as fallback) + system block. Never throws;
 * missing documents yield '' blocks so the caller can report skipped checks honestly.
 */
export async function buildArchitectureContext(repoRoot: string | null, repoName?: string): Promise<ArchitectureContext> {
  const ctx: ArchitectureContext = { charterBlock: '', systemBlock: '' };

  let charterBody = '';
  let charterLabel = '';
  const charter = repoRoot ? findCharter(repoRoot) : null;
  if (charter) {
    charterBody = charter.body;
    charterLabel = charter.title ?? charter.path;
    ctx.charterPath = charter.path;
    ctx.charterSource = 'repo';
  } else if (repoName) {
    const note = await fetchBrainNote(`${repoName}-charter`);
    if (note) {
      charterBody = note.body;
      charterLabel = note.title;
      ctx.charterSource = 'brain';
    }
  }

  if (charterBody.trim()) {
    ctx.charterBlock =
      `\n## Architecture Charter (normative)\n` +
      `The repo's own declaration of what it is for, what must NOT live here, its interfaces, ` +
      `invariants and standing decisions. This document is NORMATIVE: a finding that contradicts a ` +
      `specific line of it may quote that line and claim \`charter\` authority. Silence in the ` +
      `charter is not a rule — do not invent constraints it doesn't state.\n\n` +
      `### ${charterLabel}\n${clip(charterBody, CHARTER_MAX)}\n`;
  }

  const system = resolveSystemDoc(repoRoot ?? process.cwd(), charter?.systemRef);
  if (system) {
    ctx.systemPath = system.path;
    ctx.systemBlock =
      `\n## System Architecture Context (the level above this repo)\n` +
      `The wider system this repo belongs to: each repo's declared responsibility and the contracts ` +
      `between them. Use it to judge PLACEMENT (does this work belong in this repo, per the declared ` +
      `responsibilities?) and CONTRACT COHERENCE (does the change alter an interface another repo is ` +
      `documented to depend on?). Cited lines from this document also carry \`charter\` authority.\n\n` +
      `### ${system.path}\n${clip(system.content, SYSTEM_MAX)}\n`;
  }

  return ctx;
}

/**
 * Charter template — the schema `arch init`/`arch new` produce and reviews consume.
 * Small on purpose: a charter nobody maintains is worse than none.
 */
export const CHARTER_TEMPLATE = `---
title: <repo> — architecture charter
system: ../<system-repo>   # optional: local path to the system this repo belongs to (dir or SYSTEM.md)
---

# <repo> — architecture charter

## Purpose & scope boundary
What this repo is for, in two or three sentences.

**Not for:** what must NOT live here, and where it lives instead.

## Interfaces & dependencies
What this repo exposes (APIs, published packages, events, tables) and who consumes each.
What it depends on, and via what contract.

## Invariants
What must stay true — phrased so a reviewer can test a diff against them.

## Standing decisions
Dated mini-ADRs with rationale. A decision whose reason has expired should be challenged —
that is only possible if the reason is written down.

- YYYY-MM-DD — <decision> — because <rationale>

## Accepted debt
Known compromises we have decided to live with (so reviews stop re-flagging them).

## Org context (optional)
Ownership boundaries, cost/latency posture, roadmap pressure.
`;

/** System-doc template — the above-repo level. Lives in its own repo, next to the others. */
export const SYSTEM_TEMPLATE = `# <system name> — system architecture

## Purpose
What the whole system is for, in a paragraph.

## Repos
One line of responsibility each. If a line needs a second sentence, the responsibility is unclear.

- \`<repo>\` — <one-line responsibility>

## Contracts
Who talks to whom, via what, and who owns the schema. These edges are what cross-repo
reviews check coherence against.

- \`<repo-a>\` → \`<repo-b>\`: <mechanism — npm package / HTTP API / queue / table> — <schema owner, versioning/deploy rule>

## Cross-cutting invariants
Rules that hold across repos (data formats, deploy order, auth posture).

## Diagram
\`\`\`mermaid
graph LR
  a[repo-a] -->|npm package| b[repo-b]
\`\`\`
`;
