import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// The module reads LGTM_DB_PATH at import time, so point it at a scratch file BEFORE importing.
const dir = mkdtempSync(join(tmpdir(), 'lgtm-db-test-'));
const dbPath = join(dir, 'reviews.db');
process.env.LGTM_DB_PATH = dbPath;

// Seed a LEGACY-shaped table (the schema as it shipped before measured usage) with one
// row, so the migration has something to upgrade and the old row must survive intact.
before(() => {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE reviews (
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
  db.prepare(`INSERT INTO reviews (repo, pr_number, reviewed_at, files_reviewed, token_count, model)
              VALUES ('legacy/repo', 1, '2026-09-01T10:00:00.000Z', 3, 12000, 'claude')`).run();
  db.close();
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('initDb migrates a legacy table in place and keeps its rows', async () => {
  const { initDb, primaryModel } = await import('./db.js');
  const db = initDb();
  const cols = (db.prepare('PRAGMA table_info(reviews)').all() as { name: string }[]).map((c) => c.name);
  for (const c of ['prompt_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'output_tokens', 'cost_usd', 'duration_ms', 'model_id', 'usage_source']) {
    assert.ok(cols.includes(c), `column ${c} added`);
  }
  const legacy = db.prepare('SELECT token_count, usage_source, cost_usd FROM reviews WHERE repo = ?').get('legacy/repo') as any;
  assert.equal(legacy.token_count, 12000, 'old estimate untouched');
  assert.equal(legacy.usage_source, null, 'old rows carry no usage_source — they are neither measured nor re-labelled');
  assert.equal(legacy.cost_usd, null);
  db.close();

  // Running the migration twice is a no-op, not an error.
  initDb().close();

  assert.equal(primaryModel(['claude-haiku-4-5-20251001', 'claude-fable-5-1']), 'claude-fable-5-1');
  assert.equal(primaryModel(['claude-haiku-4-5-20251001']), 'claude-haiku-4-5-20251001', 'helper-only falls back to what was reported');
});

test('logReview stores measured usage separately from the historical estimate, and getMonthlyStats sums it', async () => {
  const { logReview, getMonthlyStats } = await import('./db.js');
  const base = {
    repo: 'x/y',
    prNumber: 7,
    reviewedAt: '2026-09-09T12:00:00.000Z',
    filesReviewed: 2,
    contextFilesAdded: 1,
    contextReasons: '["imports"]',
    tokenCount: 5000,
    model: 'claude',
    usedContextExpansion: true,
    falseNegative: false,
  };
  logReview({
    ...base,
    usage: {
      inputTokens: 10, cacheCreationTokens: 90_000, cacheReadTokens: 10_000, outputTokens: 1_200,
      costUsd: 1.25, durationMs: 42_000, models: ['claude-haiku-4-5-20251001', 'claude-fable-5-1'], calls: 1, measured: true,
    },
  });
  // A codex round (no envelope) — recorded as an estimate, never as a suspiciously cheap measurement.
  logReview({ ...base, prNumber: 8, model: 'codex', usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, models: [], calls: 1, measured: false } });

  const db = new Database(dbPath, { readonly: true });
  const measured = db.prepare('SELECT * FROM reviews WHERE pr_number = 7').get() as any;
  assert.equal(measured.token_count, 5000, 'estimate column keeps its own unit');
  assert.equal(measured.prompt_tokens, 100_010);
  assert.equal(measured.cache_read_tokens, 10_000);
  assert.equal(measured.output_tokens, 1_200);
  assert.equal(measured.cost_usd, 1.25);
  assert.equal(measured.model_id, 'claude-fable-5-1');
  assert.equal(measured.usage_source, 'measured');

  const estimate = db.prepare('SELECT * FROM reviews WHERE pr_number = 8').get() as any;
  assert.equal(estimate.usage_source, 'estimate');
  assert.equal(estimate.prompt_tokens, null);
  assert.equal(estimate.cost_usd, null);
  db.close();

  const stats = getMonthlyStats(2026, 9);
  assert.equal(stats.total, 3, 'legacy + measured + estimate rows');
  assert.equal(stats.measured, 1);
  assert.equal(stats.promptTokens, 100_010);
  assert.equal(stats.outputTokens, 1_200);
  assert.equal(stats.costUsd, 1.25);
});
