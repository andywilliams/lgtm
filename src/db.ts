import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Store in ~/.lgtm/reviews.db
const DB_PATH = path.join(os.homedir(), '.lgtm', 'reviews.db');

export interface ReviewLog {
  id?: number;
  repo: string;
  prNumber: number;
  reviewedAt: string;
  filesReviewed: number;
  contextFilesAdded: number;
  contextReasons: string; // JSON array
  tokenCount: number;
  model: string;
  usedContextExpansion: boolean;
  falseNegative: boolean;
}

export function initDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      reviewed_at TEXT NOT NULL,
      files_reviewed INTEGER NOT NULL,
      context_files_added INTEGER DEFAULT 0,
      context_reasons TEXT DEFAULT '[]',
      token_count INTEGER DEFAULT 0,
      model TEXT NOT NULL,
      used_context_expansion INTEGER DEFAULT 0,
      false_negative INTEGER DEFAULT 0
    )
  `);
  return db;
}

export function logReview(data: ReviewLog): void {
  const db = initDb();
  db.prepare(`
    INSERT INTO reviews (repo, pr_number, reviewed_at, files_reviewed, context_files_added, context_reasons, token_count, model, used_context_expansion, false_negative)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.repo,
    data.prNumber,
    data.reviewedAt,
    data.filesReviewed,
    data.contextFilesAdded,
    data.contextReasons,
    data.tokenCount,
    data.model,
    data.usedContextExpansion ? 1 : 0,
    data.falseNegative ? 1 : 0
  );
  db.close();
}

export function tagFalseNegative(repo: string, prNumber: number): boolean {
  const db = initDb();
  const result = db.prepare(`
    UPDATE reviews SET false_negative = 1 WHERE repo = ? AND pr_number = ?
  `).run(repo, prNumber);
  db.close();
  return result.changes > 0;
}

export function getMonthlyStats(year: number, month: number): { total: number; falseNegatives: number; withContextExpansion: number } {
  const db = initDb();
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(false_negative) as false_negatives,
      SUM(used_context_expansion) as with_context
    FROM reviews 
    WHERE reviewed_at >= ? AND reviewed_at < ?
  `).get(startDate, endDate) as { total: number; false_negatives: number; with_context: number };
  db.close();
  return {
    total: stats.total || 0,
    falseNegatives: stats.false_negatives || 0,
    withContextExpansion: stats.with_context || 0
  };
}