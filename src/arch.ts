import { runAIPrompt, type AIProvider } from './ai.js';
import { extractJsonObject } from './review.js';
import type { ArchAuthority, ArchConfidence, ArchDecision, ArchResult, ArchReversibility } from './types.js';

/**
 * Architecture review engine — a second review altitude. `lgtm review` asks "is this
 * code correct?"; `lgtm arch` asks "was this the right thing to build, built in the
 * right place, and what does it cost us later?"
 *
 * Design (see docs/ARCHITECTURE-REVIEW.md for the full rationale):
 *  - Output unit is the DECISION RECORD, not a line comment — the load-bearing facts
 *    about a change's architecture frequently have no line to anchor to (including
 *    absence: the place a change should have touched and didn't).
 *  - Every decision declares its AUTHORITY rung; ungrounded opinion must be phrased
 *    as a question. This is the guard against the confident-invented-convention
 *    failure mode that kills this class of tool.
 *  - Max 5 decisions, ranked; `no-decisions` is a common, cheap outcome.
 *  - Never posts inline — one summary comment, or JSON in agent mode.
 */

const MAX_DECISIONS = 5;

export const ARCH_SYSTEM_PROMPT = `You are a principal engineer reviewing a change for its ARCHITECTURAL CONSEQUENCES, not its correctness. A separate tool already reviews correctness — do not report bugs, style, naming, or missing null checks. If you find one, ignore it.

Your job is to surface the DECISIONS this change commits the system to, and what they cost later. A decision is a fork the author took where a different path was available: introducing a new concept, choosing where code lives, adding a dependency edge, fixing a data shape, or NOT changing something that arguably should have changed.

Absence counts. The most important finding is often what the diff does not touch: a new capability not wired into its consumers, a new write path with no backfill, a new failure mode with no alarm.

What to look for, ranked by value:
1. One-way doors — schema, persisted formats, published API shape, anything carrying a migration cost. This deserves disproportionate scrutiny.
2. New concepts — every new table / event / flag / abstraction is a permanent lifetime cost. Was an existing one available?
3. Missing follow-through — a capability shipped but not wired into what would consume it.
4. Placement — logic that belongs at a different layer or in a different repo, per the charter and system context if provided.
5. Coupling delta — did this change add an edge to the dependency graph?
6. Operational shape — how does this fail, is it observable, what is the backfill story?
7. Hidden second PR — one change doing two unrelated things.
8. Framework for one caller — the simpler thing that would have done.

AUTHORITY — the rule that matters most. Every decision must declare its "authority" rung:
- "charter" — you can cite a specific line of the Architecture Charter or System Architecture Context provided below. Quote it in the evidence. Be assertive.
- "codebase-pattern" — you can cite an observed, COUNTED fact from the provided context ("6 of 7 handlers do X; this doesn't"). State the count. If you cannot count it, this is not your rung.
- "diff-evidence" — the evidence is in the change itself, but the CONSEQUENCE is deduced. State the evidence assertively; phrase the consequence as a question.
- "judgement" — generic engineering opinion with no authority in this repo. Phrase the whole finding as a question ("what made X right here?"). Never say "violates", "should", "convention", or "standard".

Do NOT invent principles, conventions, or organisational standards. If it is not in the charter, the system context, or visibly and countably in the provided code, it does not exist. A confidently-wrong architectural claim is far more damaging than a missed one, because it is expensive to argue down.

Silence is a correct answer. Most changes contain no architectural decisions. If this one doesn't, return "verdict": "no-decisions" with an empty decisions array. Do not manufacture significance.

Rank by consequence and return AT MOST ${MAX_DECISIONS} decisions. Prefer one-way doors over reversible choices, and consequences over preferences. "ask_the_author" is your highest-value field — ask the question that is awkward not to have an answer to.

Record honestly in "skipped_checks" any check you could not ground: if no Architecture Charter section was provided, include "charter-grounded checks — repo has no ARCHITECTURE.md"; if no System Architecture Context section was provided, include "system-fit checks — no system doc resolvable".`;

const ARCH_OUTPUT_FORMAT = `OUTPUT FORMAT: You must respond with ONLY a valid JSON object, no other text before or after.
{
  "verdict": "no-decisions" | "decisions-found",
  "summary": "One paragraph: what this change commits the system to.",
  "decisions": [
    {
      "id": "kebab-case-slug",
      "decision": "The fork that was taken, stated plainly",
      "evidence": ["file:line-range or a quoted charter line", "..."],
      "rationale_found": "what the PR description / code comments say about why — or 'none'",
      "alternatives_not_taken": ["..."],
      "reversibility": "cheap" | "costly" | "one-way",
      "ramifications": ["what this costs later", "..."],
      "authority": "charter" | "codebase-pattern" | "diff-evidence" | "judgement",
      "confidence": "high" | "medium" | "low",
      "falsifiable_by": "what would make this finding wrong",
      "ask_the_author": "the question that is awkward not to have an answer to"
    }
  ],
  "skipped_checks": ["..."]
}

If there are no architectural decisions in this change:
{"verdict": "no-decisions", "summary": "…", "decisions": [], "skipped_checks": ["…"]}`;

export interface ArchReviewContext {
  /** Prompt-ready charter block from charter.ts (may be ''). */
  charterBlock?: string;
  /** Prompt-ready system block from charter.ts (may be ''). */
  systemBlock?: string;
  /** Optional descriptive handbook context from the second brain (may be ''). */
  handbookBlock?: string;
  /** Full contents of changed files, for pattern-counting and placement checks. */
  fileContents?: Record<string, string>;
}

/**
 * Run an architecture review over a diff. The charter/system blocks come from
 * charter.ts; their absence is survivable (the model reports skipped checks).
 */
export async function archReview(
  diff: string,
  title: string,
  body: string,
  ai: AIProvider,
  context: ArchReviewContext = {}
): Promise<ArchResult> {
  let fileContextSection = '';
  const files = context.fileContents ?? {};
  if (Object.keys(files).length > 0) {
    fileContextSection =
      `\n## Full contents of changed files\n` +
      `Use these to ground "codebase-pattern" claims (count the pattern before claiming it) and to judge placement.\n\n` +
      Object.entries(files)
        .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
        .join('\n\n') +
      '\n';
  }

  const prompt = `${ARCH_SYSTEM_PROMPT}
${context.charterBlock || ''}${context.systemBlock || ''}${context.handbookBlock || ''}
## Change title
${title}

## Change description
${body || '(no description)'}

## Diff
\`\`\`diff
${diff}
\`\`\`
${fileContextSection}
${ARCH_OUTPUT_FORMAT}`;

  const output = runAIPrompt(prompt, ai, 'arch');
  const result = parseArchResponse(output);
  return enforceSkippedChecks(result, Boolean(context.charterBlock), Boolean(context.systemBlock));
}

const CHARTER_SKIP = 'charter-grounded checks — repo has no ARCHITECTURE.md';
const SYSTEM_SKIP = 'system-fit checks — no system doc resolvable';

/**
 * The skipped_checks honesty contract is enforced from ground truth, not model
 * self-report: archReview KNOWS whether charter/system context was provided, so the
 * canonical entries are set here (and the model's own phrasings of them dropped).
 * Exported for tests.
 */
export function enforceSkippedChecks(result: ArchResult, hasCharter: boolean, hasSystem: boolean): ArchResult {
  const rest = result.skipped_checks.filter((s) => !/charter-grounded|system-fit/i.test(s));
  const canonical = [
    ...(hasCharter ? [] : [CHARTER_SKIP]),
    ...(hasSystem ? [] : [SYSTEM_SKIP]),
  ];
  result.skipped_checks = [...canonical, ...rest];
  return result;
}

/** Parse + normalize the model's arch response. Exported for tests. */
export function parseArchResponse(output: string): ArchResult {
  const { value: parsed, recovered } = extractJsonObject(output);
  if (!parsed) {
    console.error('Failed to parse arch review response as JSON (even after repair)');
    console.error('Raw response:', output.slice(0, 500));
    throw new Error('Failed to parse architecture review response from AI');
  }

  const decisions = (Array.isArray(parsed.decisions) ? parsed.decisions : [])
    .map(normalizeDecision)
    .filter((d: ArchDecision) => d.decision.trim().length > 0)
    .slice(0, MAX_DECISIONS);

  const result: ArchResult = {
    // Derive the verdict from what actually survived normalization, so a claimed
    // "decisions-found" with an empty array (or vice versa) can't mislead.
    verdict: decisions.length > 0 ? 'decisions-found' : 'no-decisions',
    summary: String(parsed.summary || (decisions.length ? '' : 'No architectural decisions in this change.')),
    decisions,
    skipped_checks: (Array.isArray(parsed.skipped_checks) ? parsed.skipped_checks : []).map(String),
  };
  if (recovered) result.recovered = true;
  return result;
}

function toStringArray(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).map(String).filter((s) => s.trim().length > 0);
}

/**
 * Reversibility is a RISK marker, so collapse-to-weakest would invert its meaning —
 * a near-miss like "one-way door" or "cheap now, costly later" must not silently
 * become lowest-risk. Fuzzy-match the vocabulary (highest risk wins on a mix);
 * genuinely unrecognized values land on the midpoint, not the floor.
 */
function normalizeReversibility(v: unknown): ArchReversibility {
  const s = String(v ?? '').toLowerCase();
  if (s === 'cheap' || s === 'costly' || s === 'one-way') return s;
  if (/one[\s-]?way|irrevers/.test(s)) return 'one-way';
  if (/costly/.test(s)) return 'costly';
  if (/cheap/.test(s)) return 'cheap';
  return 'costly';
}

function normalizeDecision(d: any): ArchDecision {
  const authorities: ArchAuthority[] = ['charter', 'codebase-pattern', 'diff-evidence', 'judgement'];
  const confidences: ArchConfidence[] = ['high', 'medium', 'low'];
  return {
    id: String(d?.id || 'decision'),
    decision: String(d?.decision || ''),
    evidence: toStringArray(d?.evidence),
    rationale_found: String(d?.rationale_found || 'none'),
    alternatives_not_taken: toStringArray(d?.alternatives_not_taken),
    reversibility: normalizeReversibility(d?.reversibility),
    ramifications: toStringArray(d?.ramifications),
    // Unknown CLAIM-strength values collapse to the weakest claim, never a stronger one:
    authority: authorities.includes(d?.authority) ? d.authority : 'judgement',
    confidence: confidences.includes(d?.confidence) ? d.confidence : 'low',
    falsifiable_by: String(d?.falsifiable_by || ''),
    ask_the_author: String(d?.ask_the_author || ''),
  };
}

const AUTHORITY_BADGES: Record<ArchAuthority, string> = {
  charter: '📜 charter',
  'codebase-pattern': '🔢 codebase-pattern',
  'diff-evidence': '🔍 diff-evidence',
  judgement: '❓ judgement',
};

const REVERSIBILITY_BADGES: Record<ArchReversibility, string> = {
  cheap: 'cheap to reverse',
  costly: 'costly to reverse',
  'one-way': '⛔ one-way door',
};

/**
 * Render the result as ONE summary comment (markdown). Architecture feedback is never
 * posted inline — stapled to line 47 it reads as a nitpick and gets resolved as one.
 */
export function formatArchComment(result: ArchResult, opts: { header?: string } = {}): string {
  const lines: string[] = [];
  lines.push(`## 🏛 lgtm arch — architecture review`);
  if (opts.header) lines.push(`_${opts.header}_`);
  lines.push('');
  lines.push(result.summary);
  lines.push('');

  if (result.verdict === 'no-decisions') {
    lines.push('**No architectural decisions found in this change.**');
  }

  result.decisions.forEach((d, i) => {
    lines.push(`### ${i + 1}. ${d.decision}`);
    lines.push(`\`${AUTHORITY_BADGES[d.authority]}\` · \`${REVERSIBILITY_BADGES[d.reversibility]}\` · \`confidence: ${d.confidence}\``);
    if (d.evidence.length) lines.push(`**Evidence:** ${d.evidence.join(' · ')}`);
    lines.push(`**Rationale found:** ${d.rationale_found}`);
    if (d.alternatives_not_taken.length) lines.push(`**Alternatives not taken:** ${d.alternatives_not_taken.join('; ')}`);
    if (d.ramifications.length) {
      lines.push('**Ramifications:**');
      for (const r of d.ramifications) lines.push(`- ${r}`);
    }
    if (d.falsifiable_by) lines.push(`**This is wrong if:** ${d.falsifiable_by}`);
    if (d.ask_the_author) lines.push(`**➡️ Ask the author:** ${d.ask_the_author}`);
    lines.push('');
  });

  if (result.skipped_checks.length) {
    lines.push(`_Skipped checks: ${result.skipped_checks.join('; ')}_`);
  }
  if (result.recovered) {
    lines.push(`_⚠ The model's JSON was salvaged — this review may be partial._`);
  }
  return lines.join('\n');
}
