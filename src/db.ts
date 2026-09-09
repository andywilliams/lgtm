import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { promptTokens, type AIUsage } from './ai.js';

// Store in ~/.lgtm/reviews.db (LGTM_DB_PATH overrides — used by tests, and by anyone
// who wants the log somewhere else).
const DB_PATH = process.env.LGTM_DB_PATH || path.join(os.homedir(), '.lgtm', 'reviews.db');

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
  /**
   * Measured usage from the provider's envelope. `tokenCount` above is the historical
   * diff-length estimate and stays in its own unit; these columns hold what was billed.
   */
  usage?: AIUsage;
}

// Columns added after the table was first created. Each is applied once, by name,
// so an existing ~/.lgtm/reviews.db upgrades in place and old rows read as NULL.
const MEASURED_COLUMNS: [string, string][] = [
  ['prompt_tokens', 'INTEGER'],
  ['cache_read_tokens', 'INTEGER'],
  ['cache_creation_tokens', 'INTEGER'],
  ['output_tokens', 'INTEGER'],
  ['cost_usd', 'REAL'],
  ['duration_ms', 'INTEGER'],
  ['model_id', 'TEXT'],
  // 'measured' when every model call reported usage; 'estimate' otherwise (codex, or a
  // provider reply with no envelope) — so a query never mixes the two silently.
  ['usage_source', 'TEXT'],
];

function migrate(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(reviews)').all() as { name: string }[]).map((c) => c.name)
  );
  for (const [name, type] of MEASURED_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE reviews ADD COLUMN ${name} ${type}`);
  }
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
  migrate(db);
  return db;
}

export function logReview(data: ReviewLog): void {
  const db = initDb();
  const u = data.usage;
  // Only a fully-measured window is stored as numbers; a partial one would read as a low bill.
  const m = u && u.measured && u.calls > 0 ? u : null;
  db.prepare(`
    INSERT INTO reviews (
      repo, pr_number, reviewed_at, files_reviewed, context_files_added, context_reasons,
      token_count, model, used_context_expansion, false_negative,
      prompt_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, cost_usd, duration_ms, model_id, usage_source
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    data.falseNegative ? 1 : 0,
    m ? promptTokens(m) : null,
    m?.cacheReadTokens ?? null,
    m?.cacheCreationTokens ?? null,
    m?.outputTokens ?? null,
    m?.costUsd ?? null,
    m?.durationMs ?? null,
    // The primary model, not the helper: the CLI lists a small model alongside it.
    m && m.models.length > 0 ? primaryModel(m.models) : null,
    m ? 'measured' : 'estimate'
  );
  db.close();
}

/** The model that did the work — the CLI also lists its small helper model. */
export function primaryModel(models: string[]): string {
  const main = models.filter((m) => !/haiku/i.test(m));
  return (main.length > 0 ? main : models).sort().join('+');
}

export function tagFalseNegative(repo: string, prNumber: number): boolean {
  const db = initDb();
  const result = db.prepare(`
    UPDATE reviews SET false_negative = 1 WHERE repo = ? AND pr_number = ?
  `).run(repo, prNumber);
  db.close();
  return result.changes > 0;
}

export function getMonthlyStats(year: number, month: number): {
  total: number;
  falseNegatives: number;
  withContextExpansion: number;
  measured: number;
  promptTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  const db = initDb();
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(false_negative) as false_negatives,
      SUM(used_context_expansion) as with_context,
      SUM(CASE WHEN usage_source = 'measured' THEN 1 ELSE 0 END) as measured,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cost_usd) as cost_usd
    FROM reviews 
    WHERE reviewed_at >= ? AND reviewed_at < ?
  `).get(startDate, endDate) as {
    total: number; false_negatives: number; with_context: number;
    measured: number; prompt_tokens: number; output_tokens: number; cost_usd: number;
  };
  db.close();
  return {
    total: stats.total || 0,
    falseNegatives: stats.false_negatives || 0,
    withContextExpansion: stats.with_context || 0,
    measured: stats.measured || 0,
    promptTokens: stats.prompt_tokens || 0,
    outputTokens: stats.output_tokens || 0,
    costUsd: stats.cost_usd || 0,
  };
}