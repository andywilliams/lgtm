import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CACHE_DIR = path.join(os.homedir(), '.lgtm', 'pending');

export interface PendingReview {
  prNumber: number;
  repo: string;
  createdAt: string;
  comments: Array<{
    file: string;
    line: number;
    body: string;
  }>;
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cacheKey(prNumber: number, repo: string): string {
  const repoSlug = repo.replace(/\//g, '-');
  return path.join(CACHE_DIR, `${repoSlug}-${prNumber}.json`);
}

export function savePendingReview(review: PendingReview): void {
  ensureCacheDir();
  const file = cacheKey(review.prNumber, review.repo);
  fs.writeFileSync(file, JSON.stringify(review, null, 2), 'utf8');
}

export function loadPendingReview(prNumber: number, repo: string): PendingReview | null {
  const file = cacheKey(prNumber, repo);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PendingReview;
  } catch {
    return null;
  }
}

export function deletePendingReview(prNumber: number, repo: string): void {
  const file = cacheKey(prNumber, repo);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

export function listPendingReviews(): PendingReview[] {
  ensureCacheDir();
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  const reviews: PendingReview[] = [];
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(CACHE_DIR, f), 'utf8');
      reviews.push(JSON.parse(content) as PendingReview);
    } catch {
      // skip corrupt files
    }
  }
  return reviews;
}
