import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG, GROUPS, REJECTED, askEntries, type CatalogEntry, type RepoProfile } from './standardsCatalog.js';

/**
 * The engineering-standards chain — the third review altitude's document.
 *
 *   `lgtm review`    — is this code correct?           (findings, inline)
 *   `lgtm arch`      — was this the right thing to build, in the right place?
 *   `STANDARDS.md`   — will this code be cheap to change in a year?
 *
 * STANDARDS.md is the repo's NORMATIVE selection from the standards catalog
 * (src/standardsCatalog.ts; rationale in docs/clean-code-catalog.md): adopted
 * rules, the answers to the contested toggles, thresholds, rejected entries
 * (so reviews never re-litigate them) and repo-specific house rules. It is
 * produced by `lgtm standards init` and consumed by `lgtm review`, which may
 * raise a small number of `(standard <id>)` findings citing it.
 *
 * Like the charter: standalone, in-repo, best-effort — a missing document is
 * never an error, it just means the standards check is skipped.
 */

const STANDARDS_CANDIDATES = ['STANDARDS.md', join('docs', 'STANDARDS.md'), join('.lgtm', 'STANDARDS.md')];
// A full generated doc runs ~22k chars, and the tail sections (Not enforced /
// Rejected) carry the never-re-raise contract — clipping them off would make the
// review re-litigate settled decisions, so the budget must fit the whole doc.
const STANDARDS_MAX = 26000; // chars fed to the model

export interface StandardsDoc {
  path: string;
  content: string; // frontmatter stripped
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '').trimStart();
}

/**
 * Clip an oversize standards doc from the MIDDLE, never the end: the tail
 * sections (Not enforced / Rejected / Choices) carry the never-re-raise
 * contract, and end-truncation would silently re-open exactly the settled
 * decisions this feature promises not to re-litigate.
 */
function clipKeepingTail(s: string, max: number): string {
  if (s.length <= max) return s;
  console.error(`lgtm: STANDARDS.md exceeds the ${max}-char review budget — clipping the middle (Not enforced / Rejected tail preserved).`);
  const marker = '\n… (middle truncated — full document in the repo)\n';
  const headLen = Math.floor((max - marker.length) * 0.6);
  const tailLen = max - marker.length - headLen;
  return s.slice(0, headLen) + marker + s.slice(-tailLen);
}

/** Locate the repo's standards doc, if it has one. */
export function findStandardsDoc(repoRoot: string): StandardsDoc | null {
  for (const cand of STANDARDS_CANDIDATES) {
    const p = join(repoRoot, cand);
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf-8');
      if (!raw.trim()) continue;
      return { path: p, content: stripFrontmatter(raw) };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Prompt-ready standards block for `lgtm review`, or '' when the repo has no
 * standards doc. The instruction budget mirrors the charter's: a small capped
 * check, not a gate — the doc is normative, so findings cite the line and the id.
 */
export function buildStandardsBlock(repoRoot: string | null): { block: string; path?: string } {
  const doc = repoRoot ? findStandardsDoc(repoRoot) : null;
  if (!doc) return { block: '' };
  const block =
    `\n## Engineering Standards (normative — the repo's adopted review standards)\n` +
    `The repo's own selection of maintainability standards, each with a stable id. This document is ` +
    `NORMATIVE: a finding that a specific ADDED line violates a listed standard may cite that standard's ` +
    `line and id. Rules:\n` +
    `- At most THREE standards findings per review, ranked by how much the violation will cost the next reader; skip freely.\n` +
    `- Title prefixed "(standard <id>)", severity "SUGGESTION" ("NITPICK" for trivial polish), body quoting the standard's line from the document.\n` +
    `- Only ADDED lines (the diff is the gate — standards apply to new code unless the document marks a standard "everywhere").\n` +
    `- NEVER raise anything the document lists under "Rejected" or "Not enforced" — those are settled decisions.\n` +
    `- House rules in the document carry the same authority as catalog standards.\n` +
    `- Do not restate findings you are already raising for correctness reasons; a standards finding must add something.\n\n` +
    `### ${doc.path}\n${clipKeepingTail(doc.content, STANDARDS_MAX)}\n`;
  return { block, path: doc.path };
}

// --- STANDARDS.md generation (used by `lgtm standards init`) -----------------

export interface StandardsThresholds {
  fnWarn: number;
  fnMax: number;
  fileWarn: number;
  fileMax: number;
}

export const DEFAULT_THRESHOLDS: StandardsThresholds = { fnWarn: 50, fnMax: 80, fileWarn: 400, fileMax: 800 };

/**
 * Enforce warn < finding on user-supplied thresholds. Interview answers (and
 * scripted --answers files) collect the two numbers independently, so a custom
 * warn above an accepted default finding would otherwise generate a
 * self-contradictory document.
 */
export function clampThresholds(t: StandardsThresholds): StandardsThresholds {
  const out = { ...t };
  if (out.fnMax <= out.fnWarn) out.fnMax = out.fnWarn + 30;
  if (out.fileMax <= out.fileWarn) out.fileMax = out.fileWarn + 400;
  return out;
}

export interface StandardsSelections {
  /** Chosen ask-option value per ask-entry id (e.g. { 'FUN-1': 'balanced' }). */
  askChoices: Record<string, string>;
  thresholds: StandardsThresholds;
  houseRules: string[];
}

export interface GenerateOptions {
  repoName: string;
  profile: RepoProfile;
  selections: StandardsSelections;
  /** One-line human summary of the repo scan, recorded for provenance. */
  scanSummary?: string;
  /** Injectable for tests; defaults to today. */
  date?: string;
}

function substituteThresholds(rule: string, t: StandardsThresholds): string {
  return rule
    .replaceAll('{fnWarn}', String(t.fnWarn))
    .replaceAll('{fnMax}', String(t.fnMax))
    .replaceAll('{fileWarn}', String(t.fileWarn))
    .replaceAll('{fileMax}', String(t.fileMax));
}

const FN_PLACEHOLDER = /\{fn(?:Warn|Max)\}/;
const FILE_PLACEHOLDER = /\{file(?:Warn|Max)\}/;

/**
 * Which threshold families the RESOLVED rule set actually consumes, given the
 * profile and stance choices. The interview asks a threshold question only when
 * some chosen rule will render the number — a stance whose rule text carries no
 * placeholder (e.g. FUN-1 "strict") must not collect numbers it then discards,
 * and the generated Choices line must not record thresholds nothing uses.
 */
export function thresholdsConsumed(profile: RepoProfile, askChoices: Record<string, string>): { fn: boolean; file: boolean } {
  let fn = false;
  let file = false;
  const probe: StandardsSelections = { askChoices, thresholds: DEFAULT_THRESHOLDS, houseRules: [] };
  for (const e of CATALOG) {
    const resolved = resolveEntry(e, profile, probe);
    if (resolved.kind !== 'rule') continue;
    if (FN_PLACEHOLDER.test(resolved.rawRule)) fn = true;
    if (FILE_PLACEHOLDER.test(resolved.rawRule)) file = true;
  }
  return { fn, file };
}

/**
 * Resolve what a catalog entry contributes to the generated doc for a given
 * profile + selections: its (possibly stance-chosen) rule line, or a
 * not-enforced record, or nothing.
 */
function resolveEntry(
  e: CatalogEntry,
  profile: RepoProfile,
  selections: StandardsSelections
): { kind: 'rule'; line: string; rawRule: string } | { kind: 'not-enforced'; reason: string } | { kind: 'skip' } {
  const profileOverride = e.profiles?.[profile];
  if (profileOverride === 'off') {
    return { kind: 'not-enforced', reason: `Off for the ${profile} profile.` };
  }
  if (e.default === 'off') {
    return e.offReason ? { kind: 'not-enforced', reason: e.offReason } : { kind: 'skip' };
  }
  let rule = e.rule;
  if (e.default === 'ask' && e.ask) {
    const chosen = selections.askChoices[e.id] ?? e.ask.options[0].value;
    const option = e.ask.options.find((o) => o.value === chosen) ?? e.ask.options[0];
    if (!option.rule) {
      return { kind: 'not-enforced', reason: `Chosen in the standards interview: ${option.label}.` };
    }
    rule = option.rule;
  }
  return { kind: 'rule', line: substituteThresholds(rule, selections.thresholds), rawRule: rule };
}

/**
 * Generate the STANDARDS.md content deterministically from the catalog and the
 * interview's selections. No AI involved — the catalog is the distillation; the
 * interview supplies only the contested choices, thresholds and house rules.
 */
export function generateStandardsDoc(opts: GenerateOptions): string {
  const { repoName, profile, selections } = opts;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);

  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: ${repoName} — engineering standards`);
  lines.push(`profile: ${profile}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${repoName} — engineering standards`);
  lines.push('');
  lines.push(
    `The repo's adopted maintainability standards, selected from lgtm's clean-code catalog ` +
      `(rationale, sources and page refs: lgtm's docs/clean-code-catalog.md). Reviews may cite a listed ` +
      `standard as a \`(standard <id>)\` finding. Standards apply to NEW/CHANGED code (the diff is the ` +
      `gate) unless marked **[everywhere]**. Edit this file freely — it is yours, not the catalog's.`
  );
  lines.push('');

  const notEnforced: { id: string; title: string; reason: string }[] = [];

  for (const group of GROUPS) {
    const entries = CATALOG.filter((e) => e.group === group.key);
    const rendered: string[] = [];
    for (const e of entries) {
      const resolved = resolveEntry(e, profile, selections);
      if (resolved.kind === 'rule') {
        const everywhere = e.scope === 'everywhere' ? ' **[everywhere]**' : '';
        rendered.push(`- **${e.id} · ${e.title}**${everywhere} — ${resolved.line}`);
      } else if (resolved.kind === 'not-enforced') {
        notEnforced.push({ id: e.id, title: e.title, reason: resolved.reason });
      }
    }
    if (rendered.length === 0) continue;
    lines.push(`## ${group.title}`);
    if (group.note) lines.push(`*${group.note}*`);
    lines.push(...rendered);
    lines.push('');
  }

  lines.push('## House rules');
  lines.push('*Repo-specific standards no book wrote — same authority as the catalog entries above. Add freely; date them.*');
  if (selections.houseRules.length === 0) {
    lines.push('- (none yet)');
  } else {
    selections.houseRules.forEach((hr, i) => lines.push(`- **HR-${i + 1}** (${date}) — ${hr}`));
  }
  lines.push('');

  lines.push('## Not enforced');
  lines.push('*Deliberate choices — reviews must NOT raise these. Re-open by editing this file, not by re-arguing in review.*');
  for (const ne of notEnforced) lines.push(`- **${ne.id} · ${ne.title}** — ${ne.reason}`);
  lines.push('');

  lines.push('## Rejected');
  lines.push('*Catalog entries that do not translate to this stack — recorded so reviews never cite them.*');
  for (const r of REJECTED) lines.push(`- **${r.id} · ${r.title}** — ${r.reason}`);
  lines.push('');

  lines.push('## Choices');
  lines.push(`*The contested-toggle answers from \`lgtm standards init\` (${date}).*`);
  for (const e of askEntries()) {
    const chosen = selections.askChoices[e.id] ?? e.ask!.options[0].value;
    const option = e.ask!.options.find((o) => o.value === chosen) ?? e.ask!.options[0];
    lines.push(`- ${date} — **${e.id}** → ${option.label}`);
  }
  // Record only the threshold families some rendered rule actually consumes —
  // a stance without placeholders must not have numbers attributed to it.
  const consumed = thresholdsConsumed(profile, selections.askChoices);
  const t = selections.thresholds;
  const thresholdParts = [
    ...(consumed.fn ? [`function warn >${t.fnWarn} / finding >${t.fnMax} lines`] : []),
    ...(consumed.file ? [`file warn >${t.fileWarn} / finding >${t.fileMax} lines`] : []),
  ];
  if (thresholdParts.length > 0) lines.push(`- ${date} — thresholds: ${thresholdParts.join(' · ')}`);
  if (opts.scanSummary) lines.push(`- ${date} — repo scan at selection time: ${opts.scanSummary}`);
  lines.push('');

  return lines.join('\n');
}
