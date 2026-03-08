import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');

export interface ReviewData {
  prUrl: string;
  filesReviewed: number;
  contextFilesAdded: number;
  contextReasons: string[];
  tokenCount: number;
  model: string;
  timestamp: string;
  expandedContext: boolean;
  // Added by false negative tagging
  falseNegative?: boolean;
  bugDescription?: string;
  taggedAt?: string;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readReviews(): ReviewData[] {
  ensureDataDir();
  if (!fs.existsSync(REVIEWS_FILE)) {
    return [];
  }
  try {
    const data = fs.readFileSync(REVIEWS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeReviews(reviews: ReviewData[]): void {
  ensureDataDir();
  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2));
}

export function logReview(reviewData: ReviewData): void {
  const reviews = readReviews();
  reviews.push({
    ...reviewData,
    timestamp: reviewData.timestamp || new Date().toISOString(),
  });
  writeReviews(reviews);
  console.log(`Logged review for ${reviewData.prUrl}`);
}

export function getReviews(): ReviewData[] {
  return readReviews();
}
