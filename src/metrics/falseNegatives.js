import { readReviews, writeReviews } from './reviewLogger.js';

export interface FalseNegativeData {
  prUrl: string;
  bugDescription: string;
  taggedAt: string;
}

/**
 * Tag a PR as a false negative (bug that slipped through review)
 * @param prUrl - The PR URL (e.g., "https://github.com/owner/repo/pull/123")
 * @param bugDescription - Description of the bug that was missed
 * @returns true if successfully tagged, false if PR not found
 */
export function tagFalseNegative(prUrl: string, bugDescription: string): boolean {
  const reviews = readReviews();
  const index = reviews.findIndex(r => r.prUrl === prUrl);
  
  if (index === -1) {
    console.log(`PR not found: ${prUrl}`);
    return false;
  }
  
  reviews[index] = {
    ...reviews[index],
    falseNegative: true,
    bugDescription,
    taggedAt: new Date().toISOString(),
  };
  
  writeReviews(reviews);
  console.log(`Tagged false negative for ${prUrl}`);
  return true;
}

/**
 * List all PRs tagged as false negatives
 * @returns Array of PRs with false negative data
 */
export function listFalseNegatives(): FalseNegativeData[] {
  const reviews = readReviews();
  return reviews
    .filter(r => r.falseNegative === true)
    .map(r => ({
      prUrl: r.prUrl,
      bugDescription: r.bugDescription || '',
      taggedAt: r.taggedAt || '',
    }));
}
