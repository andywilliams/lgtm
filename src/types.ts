export type Harshness = 'chill' | 'medium' | 'pedantic';
export type Severity = 'BUG' | 'SECURITY' | 'SUGGESTION' | 'NITPICK';

export interface ReviewComment {
  file: string;
  line: number;
  severity: Severity;
  title: string;
  body: string;
  suggestion?: string;
}

export interface ReviewResult {
  summary: string;
  comments: ReviewComment[];
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

export interface QuizQuestion {
  question: string;
  options: [string, string, string, string];
  correctIndex: number;
  explanation: string;
}

export interface QuizResult {
  questions: QuizQuestion[];
}
