export type Harshness = 'chill' | 'medium' | 'pedantic';
export type Severity = 'BUG' | 'SECURITY' | 'SUGGESTION' | 'NITPICK';

/** What the finding is about: code the diff ADDS, code it REMOVES, or something MISSING from it. */
export type FindingKind = 'added' | 'removed' | 'missing';
export type Confidence = 'high' | 'medium' | 'low';

/**
 * What the verifier pass made of a finding (see src/verify.ts). 'unverified' is not a
 * verdict the verifier gives — it is what a finding carries when the pass did not run,
 * failed, or said nothing about it, and it is deliberately distinct from 'unproven' so
 * that silence can never be the thing that deletes a finding.
 */
export type Verdict = 'confirmed' | 'refuted' | 'unproven' | 'unverified';

export interface ReviewComment {
  file: string;
  line: number;
  severity: Severity;
  title: string;
  body: string;
  suggestion?: string;
  kind?: FindingKind;
  confidence?: Confidence;
  /** Lines quoted from the diff or the provided context that show the problem. */
  evidence?: string[];
  /** The one check that settles whether this is real. */
  how_to_verify?: string;
  /** Stable identity across rounds: the symbol or construct at fault, not the line. */
  fingerprint?: string;
  // --- set by the verifier pass, never by the reviewer (src/verify.ts) ---
  verdict?: Verdict;
  /** Lines the verifier quoted to confirm or refute the finding. */
  verifier_evidence?: string[];
  /** One sentence saying what settled it. */
  verifier_note?: string;
  /** The severity the REVIEWER gave, when the verifier lowered it. */
  original_severity?: Severity;
  /** True when the verifier refuted it, or could not prove an opinion — logged, not shown. */
  verifier_dropped?: boolean;
}

export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
  /**
   * True when the model's JSON was malformed and had to be recovered via jsonrepair — the
   * result may be partial (e.g. a truncated final finding). Surfaced in agent-mode output so
   * a driving agent knows the review was salvaged, not clean.
   */
  recovered?: boolean;
}

/**
 * A finding raised in an earlier review round and deliberately dismissed. Fed back into a later
 * round (via `--decided`) so the reviewer doesn't re-raise settled points across a fix-review loop.
 */
export interface DecidedFinding {
  file?: string;
  line?: number;
  title: string;
  reason: string;
}

export interface PRDetails {
  number: number;
  title: string;
  body: string;
  author: string;
  baseRef: string;
  headRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface ReviewOptions {
  prNumber: number;
  repo?: string;
  harshness: Harshness;
  dryRun: boolean;
  batch: boolean;
}

export interface ExistingComment {
  id: number;
  nodeId: string;
  file: string;
  line: number | null;
  body: string;
  author: string;
  createdAt: string;
  url: string;
}

export interface ExistingReviewComment {
  path: string;
  line: number | null;
  body: string;
}

export type CommentStatus = 'still_valid' | 'resolved' | 'outdated';

export interface RecheckResult {
  commentId: number;
  status: CommentStatus;
  reason: string;
}

export interface RecheckResponse {
  summary: string;
  results: RecheckResult[];
}

/**
 * Architecture review (`lgtm arch`) types — a different output unit from code review.
 * The unit is the DECISION RECORD: a fork the change commits the system to, with its
 * evidence, cost and — crucially — which rung of the authority ladder it stands on.
 */
export type ArchAuthority = 'charter' | 'codebase-pattern' | 'diff-evidence' | 'judgement';
export type ArchReversibility = 'cheap' | 'costly' | 'one-way';
export type ArchConfidence = 'high' | 'medium' | 'low';

export interface ArchDecision {
  id: string;
  decision: string;
  evidence: string[];
  rationale_found: string;
  alternatives_not_taken: string[];
  reversibility: ArchReversibility;
  ramifications: string[];
  authority: ArchAuthority;
  confidence: ArchConfidence;
  falsifiable_by: string;
  ask_the_author: string;
}

export interface ArchResult {
  verdict: 'no-decisions' | 'decisions-found';
  summary: string;
  decisions: ArchDecision[];
  /** Checks that could not run (no charter, no system doc, …) — reported, not papered over. */
  skipped_checks: string[];
  /** True when the model's JSON had to be salvaged via jsonrepair — result may be partial. */
  recovered?: boolean;
}

export interface QuizQuestion {
  question: string;
  options: [string, string, string, string];
  correctIndex: number;
  explanation: string;
}

export interface QuizResult {
  questions: QuizQuestion[];
}
