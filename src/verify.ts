import { runAIPrompt, setModelOverride, getModelOverride, resolveModel, isModelId, DEFAULT_LATE_MODEL, type AIProvider } from './ai.js';
import { extractJsonObject } from './review.js';
import type { ReviewComment, Severity, Verdict } from './types.js';

/**
 * The verifier pass: a SECOND model call that proves or drops each finding the reviewer
 * raised, before the agent ever reads it.
 *
 * Why it exists: on long loops roughly nine in ten round-1 findings were not real defects
 * (DWLF-127 went 109 → 12), and every one of them cost the driving agent a read →
 * verify → dismiss cycle before it could make the next fix. A verifier is the cheapest
 * known cut of that, and — run on a different model — it is also the only cheap way to
 * decorrelate reviewer and author, who today are the same model family reviewing itself.
 *
 * Three rules make it safe rather than merely cheaper:
 *  1. It NEVER adds findings. A second generator is a second source of churn; verdicts
 *     are matched to the ids it was given and anything else is discarded.
 *  2. It may only lower a severity, never raise one, and the DROP decision is taken on
 *     the severity the REVIEWER gave — so "downgrade, then drop as an opinion" is not a
 *     route by which a BUG can disappear.
 *  3. Absence of proof is not refutation. A finding it can neither show nor disprove is
 *     "unproven": an opinion (SUGGESTION/NITPICK) is dropped, but a BUG/SECURITY is KEPT
 *     with its confidence lowered. A false drop of a real bug is the one failure this
 *     pass must not have, and it is far more expensive than a surviving false positive.
 */

/** How many lines either side of a finding the verifier is shown from the current file. */
const WINDOW_LINES = 60;
/** Default cap on the file-window block; the diff is sent whole and is not counted against it. */
const DEFAULT_MAX_CONTEXT_BYTES = 60_000;

export function verifyMaxContextBytes(raw = process.env.LGTM_VERIFY_MAX_BYTES): number {
  const n = Number(raw?.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CONTEXT_BYTES;
}

export interface VerifyModelChoice {
  /** False when the operator turned the pass off with LGTM_VERIFY_MODEL=off. */
  enabled: boolean;
  /** undefined ⇒ run the verifier on the operator's own (full) model. */
  model: string | undefined;
  reason: string;
}

/**
 * Which model the verifier runs on. Mirrors `lateModel` deliberately, including its two
 * failure modes: `off` DISABLES the pass (the same idiom as `LGTM_LATE_MODEL=off`, which
 * turns off the policy it names), and a value that is not a model id warns and falls back
 * rather than being passed through — unvalidated, it reaches `setModelOverride`, throws
 * inside the pass's own guard, and every round then silently verifies nothing.
 */
export function verifyModel(fullModel: string | undefined = resolveModel()): VerifyModelChoice {
  let explicit = process.env.LGTM_VERIFY_MODEL?.trim();
  if (explicit && explicit.toLowerCase() === 'off') return { enabled: false, model: undefined, reason: 'LGTM_VERIFY_MODEL=off' };
  let note = '';
  if (explicit !== undefined && explicit !== '' && !isModelId(explicit)) {
    process.stderr.write(`lgtm: ignoring LGTM_VERIFY_MODEL=${JSON.stringify(explicit)} (not a model id)\n`);
    note = ` (LGTM_VERIFY_MODEL=${JSON.stringify(explicit)} ignored: not a model id)`;
    explicit = undefined;
  }
  if (explicit) return { enabled: true, model: explicit, reason: 'LGTM_VERIFY_MODEL' };
  // Same first-party guard as the late-round policy: a Bedrock ARN or Vertex id operator
  // opts in by naming a verifier model rather than having a claude-* id assumed for them.
  if (fullModel !== undefined && !/^claude-[a-z0-9-]+(\[\w+\])?$/.test(fullModel)) {
    return { enabled: true, model: undefined, reason: `full model is not a first-party id — verifying on it (set LGTM_VERIFY_MODEL to use a cheaper one)${note}` };
  }
  return { enabled: true, model: DEFAULT_LATE_MODEL, reason: `default verifier model${note}` };
}

/** The shape a verify reply must have — used on the schema retry, not on the first call. */
export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unproven'] },
          severity: { type: 'string', enum: ['BUG', 'SECURITY', 'SUGGESTION', 'NITPICK'] },
          verifier_evidence: { type: 'array', items: { type: 'string' } },
          verifier_note: { type: 'string' },
        },
        required: ['id', 'verdict', 'verifier_note'],
      },
    },
  },
  required: ['verdicts'],
} as const;

const VERIFY_RULES = `You are verifying the findings of a code review. You are NOT reviewing the code.

For each finding below, answer ONE question: does the code you were given SHOW that this finding is true?

VERDICTS — exactly one per finding:
- "confirmed": you can quote the lines that show the problem is real. Put them in "verifier_evidence".
- "refuted": you can quote the lines that show the finding is WRONG — the guard it says is missing is
  present, the caller it says does not exist is there, the line it quotes does not appear in the file,
  the behaviour it predicts cannot happen on this code. Quote them. A refutation with nothing quoted is
  not a refutation; it is "unproven".
- "unproven": you can neither show it nor disprove it from what you were given.

ABSENCE OF PROOF IS NOT REFUTATION. If a finding's proof would lie in a file you were not shown, that is
"unproven", not "refuted". Do not reason from what is missing from your context.

WHAT YOU MAY NOT DO:
- You may NOT add findings. If you notice a different problem, ignore it — that is not this job.
- You may NOT change a finding's file, line, title or body.
- You may LOWER a severity when the evidence supports less (a "BUG" whose worst outcome is unclear naming
  is a "SUGGESTION"). You may NEVER raise one; if you think a finding is more serious than reported, say so
  in "verifier_note" and leave "severity" out.
- "refuted" is a claim about the CODE, never about a finding's importance. A finding that is TRUE but
  trivial is "confirmed" with a lowered severity — never "refuted".

"verifier_note" is one sentence saying what settled it, in every case. For "refuted" it must name the
specific thing that contradicts the finding, not a general reassurance.`;

export interface VerifyInput {
  diff: string;
  prTitle: string;
  findings: ReviewComment[];
  /** repo-relative path → current contents, for windowing around each finding. */
  contents?: Record<string, string>;
  /** The readers-of-what-this-writes block: small, and the proof of a whole finding class. */
  readersContext?: string;
  /** Charter / standards text — sent only when a finding cites one of them. */
  docs?: string;
  maxContextBytes?: number;
}

/** Merge overlapping [start,end] line ranges (1-based, inclusive). */
function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([...r] as [number, number]);
  }
  return out;
}

/**
 * The file text around the findings, not the whole files. The verifier's question is
 * per-finding, so its context should scale with the number of findings rather than with
 * the size of the repository — which is what keeps review + verify inside its cost budget
 * on a late round, where the review itself is nearly all prompt-cache reads.
 */
export function buildWindows(findings: ReviewComment[], contents: Record<string, string>, maxBytes: number): string {
  const byFile = new Map<string, [number, number][]>();
  for (const f of findings) {
    // Own properties only: `file` comes from the model, and "toString" or "constructor"
    // would otherwise resolve to an inherited function and blow up on .split below —
    // inside the one statement that used to sit outside this pass's never-throws guard.
    const text = Object.prototype.hasOwnProperty.call(contents, f.file) ? contents[f.file] : undefined;
    if (typeof text !== 'string') continue;
    const total = text.split('\n').length;
    const from = Math.max(1, f.line - WINDOW_LINES);
    const to = Math.min(total, f.line + WINDOW_LINES);
    byFile.set(f.file, [...(byFile.get(f.file) ?? []), [from, to]]);
  }
  if (byFile.size === 0) return '';
  let out = '';
  let truncated = false;
  for (const [file, ranges] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lines = contents[file]!.split('\n');
    for (const [from, to] of mergeRanges(ranges)) {
      const numbered = lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join('\n');
      const block = `### ${file} — lines ${from}-${to} (current contents)\n\`\`\`\n${numbered}\n\`\`\`\n\n`;
      if (out.length + block.length > maxBytes) { truncated = true; continue; }
      out += block;
    }
  }
  // The header is emitted even when NOTHING fit. A block that silently vanishes under the
  // cap reads to the verifier as "this file has no such code", which is the difference
  // between "I was shown nothing" and "I looked and it is not there" — and that
  // difference is the whole basis of the refuted/unproven split.
  const header = `## Current file contents around each finding\nLine numbers are the file's own. Only the neighbourhood of each finding is shown${truncated ? ', and some windows did not fit within the size cap' : ''} — a finding whose proof lies outside these windows is "unproven", never "refuted".\n\n`;
  return header + out;
}

/** Does any finding cite a document (charter / STANDARDS.md) rather than the code? */
export function citesDocs(findings: ReviewComment[]): boolean {
  return findings.some((f) => /^\((charter|standard\b[^)]*)\)/i.test(f.title));
}

export function buildVerifyPrompt(input: VerifyInput): string {
  const { diff, prTitle, findings, contents = {}, readersContext, docs } = input;
  const maxBytes = input.maxContextBytes ?? verifyMaxContextBytes();
  const windows = buildWindows(findings, contents, maxBytes);
  // The charter and standards are the ONLY evidence a "(charter)" / "(standard …)"
  // finding can have, so they travel with such a finding and are otherwise left out —
  // without them the drop rule would delete that whole class as unprovable opinion.
  const docsSection = docs && citesDocs(findings) ? `\n${docs}\n` : '';
  const list = findings.map((f, i) => {
    const parts = [
      `### Finding ${i + 1}`,
      `- severity: ${f.severity}`,
      `- kind: ${f.kind ?? 'added'} (added = a problem in an added line; removed = caused by a deletion; missing = something the diff does NOT do)`,
      `- location: ${f.file}:${f.line}`,
      `- title: ${f.title}`,
      `- claim: ${f.body}`,
    ];
    if (f.evidence && f.evidence.length > 0) parts.push(`- the reviewer quoted:\n${f.evidence.map((e) => `  > ${e}`).join('\n')}`);
    else parts.push('- the reviewer quoted nothing');
    if (f.how_to_verify) parts.push(`- the reviewer says this settles it: ${f.how_to_verify}`);
    return parts.join('\n');
  }).join('\n\n');

  return `${VERIFY_RULES}

## The change under review: ${prTitle}

\`\`\`diff
${diff}
\`\`\`
${docsSection}${readersContext ? `\n${readersContext}\n` : ''}
${windows}
## Findings to verify (${findings.length})

${list}

OUTPUT FORMAT: respond with ONLY a valid JSON object, no other text before or after. Include exactly one
verdict per finding, using the finding's number as "id":
{"verdicts": [{"id": 1, "verdict": "confirmed" | "refuted" | "unproven", "severity": "BUG" | "SECURITY" | "SUGGESTION" | "NITPICK", "verifier_evidence": ["exact quoted lines"], "verifier_note": "one sentence"}]}

"severity" is optional and may only be LOWER than the reviewer's. "verifier_evidence" may be empty only for "unproven".`;
}

const SEVERITY_RANK: Record<Severity, number> = { SECURITY: 3, BUG: 3, SUGGESTION: 1, NITPICK: 0 };
const VERDICTS: Verdict[] = ['confirmed', 'refuted', 'unproven'];
const isSeverity = (v: unknown): v is Severity => typeof v === 'string' && v in SEVERITY_RANK;

/** True when a finding's severity, as the REVIEWER gave it, makes it an opinion rather than a defect. */
export function isOpinion(severity: Severity): boolean {
  return severity === 'SUGGESTION' || severity === 'NITPICK';
}

export interface Verdicts {
  [id: number]: { verdict: Verdict; severity?: Severity; verifier_evidence?: string[]; verifier_note?: string };
}

/** Pull the verdicts out of a verifier reply, keyed by finding number. Unknown ids are dropped. */
export function parseVerdicts(output: string, count: number): Verdicts {
  const { value } = extractJsonObject(output);
  const rows = Array.isArray(value?.verdicts) ? value.verdicts : [];
  const out: Verdicts = {};
  for (const r of rows) {
    const id = Number(r?.id);
    if (!Number.isInteger(id) || id < 1 || id > count) continue; // a verdict for a finding that does not exist
    const verdict = VERDICTS.includes(r?.verdict) ? (r.verdict as Verdict) : 'unproven';
    const evidence = Array.isArray(r?.verifier_evidence) ? r.verifier_evidence.map(String).filter((e: string) => e.trim() !== '') : [];
    out[id] = {
      verdict,
      severity: isSeverity(r?.severity) ? r.severity : undefined,
      verifier_evidence: evidence,
      verifier_note: r?.verifier_note ? String(r.verifier_note) : undefined,
    };
  }
  return out;
}

/**
 * Apply the verdicts to the findings. Returns a NEW list in the same order, every entry
 * annotated; nothing is removed here, because the caller must log the drops (that is how
 * the false-positive rate becomes a number) and only then hide them from its output.
 */
export function applyVerdicts(findings: ReviewComment[], verdicts: Verdicts): ReviewComment[] {
  return findings.map((f, i) => {
    const v = verdicts[i + 1];
    // No verdict at all is NOT "unproven": a verifier that skipped a finding has said
    // nothing about it, and silence must never be the thing that deletes a finding.
    if (!v) return { ...f, verdict: 'unverified' as Verdict };
    const claimed = f.severity;
    const lowered = v.severity !== undefined && SEVERITY_RANK[v.severity] < SEVERITY_RANK[claimed] ? v.severity : undefined;
    const evidence = v.verifier_evidence ?? [];
    // A refutation is a claim about the code and must be quotable; without quoted lines
    // it is exactly the "I could not find it" case, which is unproven.
    const verdict: Verdict = v.verdict === 'refuted' && evidence.length === 0 ? 'unproven' : v.verdict;
    // The DROP decision uses the severity the REVIEWER gave, so that lowering a BUG to a
    // SUGGESTION can never be the step that makes it droppable.
    const dropped = verdict === 'refuted' || (verdict === 'unproven' && isOpinion(claimed));
    const confidence = verdict === 'confirmed'
      ? (evidence.length > 0 ? 'high' as const : f.confidence)
      : verdict === 'unproven' ? 'low' as const : f.confidence;
    return {
      ...f,
      severity: lowered ?? f.severity,
      ...(lowered ? { original_severity: claimed } : {}),
      confidence,
      verdict,
      verifier_evidence: evidence.length > 0 ? evidence : undefined,
      verifier_note: v.verifier_note,
      verifier_dropped: dropped || undefined,
    };
  });
}

export interface VerifyOutcome {
  comments: ReviewComment[];
  /** Set when the pass could not run; the findings come back untouched and nothing is dropped. */
  failed?: string;
  model?: string;
}

/**
 * Run the pass. Never throws: a verifier that fails, times out or answers with nonsense
 * leaves every finding exactly as the reviewer raised it, because the review has already
 * happened and its result must not depend on this. The caller is told, so the round can
 * record that it went unverified rather than reading as "nothing was dropped".
 */
export function verifyFindings(input: VerifyInput & {
  ai: AIProvider;
  /** undefined ⇒ whatever the process default is; see verifyModel. */
  model?: string;
}): VerifyOutcome {
  const { ai, model, findings } = input;
  if (findings.length === 0) return { comments: findings };
  // The override is process-wide, so the verifier's cheaper model is put back exactly as
  // it was found: the review's own choice is still set when this runs.
  const previous = getModelOverride();
  try {
    // Inside the guard, not above it: this is the statement that consumes untrusted model
    // output (a finding's `file` and `line`), and the function's contract is that a review
    // already paid for is never lost to something that happens after it.
    const prompt = buildVerifyPrompt(input);
    if (ai === 'claude') setModelOverride(model);
    let output: string;
    try {
      output = runAIPrompt(prompt, ai, 'verify', { schema: undefined });
    } catch (e: any) {
      // One retry, with the shape enforced, only for a reply that could not be read.
      if (!/parse|json/i.test(e?.message ?? '')) throw e;
      output = runAIPrompt(prompt, ai, 'verify', { schema: VERIFY_SCHEMA });
    }
    let verdicts = parseVerdicts(output, findings.length);
    if (Object.keys(verdicts).length === 0) {
      output = runAIPrompt(prompt, ai, 'verify', { schema: VERIFY_SCHEMA });
      verdicts = parseVerdicts(output, findings.length);
    }
    if (Object.keys(verdicts).length === 0) return { comments: findings, failed: 'the verifier returned no verdicts', model };
    return { comments: applyVerdicts(findings, verdicts), model };
  } catch (e: any) {
    return { comments: findings, failed: e?.message ?? String(e), model };
  } finally {
    if (ai === 'claude') setModelOverride(previous);
  }
}

/** The findings the agent should see: everything the verifier did not drop. */
export function kept(comments: ReviewComment[]): ReviewComment[] {
  return comments.filter((c) => !c.verifier_dropped);
}

/** The findings the verifier refuted or could not prove — logged, never posted. */
export function dropped(comments: ReviewComment[]): ReviewComment[] {
  return comments.filter((c) => Boolean(c.verifier_dropped));
}
