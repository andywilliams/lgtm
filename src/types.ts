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
  model: string;
  harshness: Harshness;
  dryRun: boolean;
  batch: boolean;
}

export interface Config {
  defaults: {
    model: string;
    harshness: Harshness;
  };
  anthropicApiKey?: string;
}
