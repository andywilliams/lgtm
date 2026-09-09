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

test('findings are logged per round and the previous round is disposed: fixed / dismissed / carried', async () => {
  const { logReview, logFindings, disposePreviousRound, getLoopSummary, fingerprintOf } = await import('./db.js');
  const repo = 'loop/repo';
  const key = 'pr:42';
  const base = {
    repo, prNumber: 42, filesReviewed: 3, contextFilesAdded: 0, contextReasons: '[]', tokenCount: 1000,
    model: 'claude', usedContextExpansion: false, falseNegative: false, mode: 'pr' as const, roundKey: key,
  };
  const c = (severity: any, title: string, file = 'src/a.ts', line = 10) => ({ severity, title, file, line, body: '' });

  const r1 = logReview({ ...base, reviewedAt: '2026-09-09T10:00:00.000Z', harshness: 'medium',
    usage: { inputTokens: 0, cacheCreationTokens: 1000, cacheReadTokens: 0, outputTokens: 10, costUsd: 2, durationMs: 1, models: ['claude-fable-5-1'], calls: 1, measured: true } });
  assert.equal(r1.round, 1, 'round allocated inside the insert when not supplied');
  logFindings(r1.id, repo, key, 1, [
    c('BUG', 'Null deref on empty list'),
    c('SUGGESTION', 'Rename foo'),
    c('NITPICK', '(standard G9) unused import', 'src/b.ts', 3),
  ]);
  assert.equal(disposePreviousRound(repo, key, 1, []), null, 'round 1 has nothing to judge');

  const round2 = [
    c('SUGGESTION', 'Rename foo', 'src/a.ts', 14), // same complaint, moved line ⇒ carried
    c('SUGGESTION', 'Missing test for the guard'),   // new
  ];
  const r2 = logReview({ ...base, reviewedAt: '2026-09-09T10:30:00.000Z', harshness: 'medium' });
  assert.equal(r2.round, 2);
  logFindings(r2.id, repo, key, 2, round2);
  const d = disposePreviousRound(repo, key, 2, round2, { decided: [
    { title: 'unused import', reason: 'generated file', file: 'src/b.ts' },            // tag-insensitive match
    { title: 'Null deref on empty list', reason: 'wrong file', file: 'src/other.ts' }, // file mismatch ⇒ does not apply
  ], harshness: 'medium' });
  assert.deepEqual(d, { fixed: 1, dismissed: 1, carried: 1, suppressed: 0 });

  // Running the disposition again for the same pair changes nothing — rows are already disposed.
  assert.deepEqual(disposePreviousRound(repo, key, 2, round2), { fixed: 0, dismissed: 0, carried: 0, suppressed: 0 });

  const s = getLoopSummary(repo, key);
  assert.equal(s.rounds.length, 2);
  assert.deepEqual(s.rounds[0].bySeverity, { BUG: 1, SECURITY: 0, SUGGESTION: 1, NITPICK: 1 });
  assert.equal(s.rounds[0].fixed, 1);
  assert.equal(s.rounds[0].dismissed, 1);
  assert.equal(s.rounds[0].carried, 1);
  assert.equal(s.rounds[1].findings, 2);
  assert.equal(s.lastBugRound, 1);
  assert.equal(s.totalCostUsd, 2);

  // Round 3 at chill: round 2's SUGGESTIONs vanish because chill does not raise them — suppressed, not fixed.
  const r3 = logReview({ ...base, reviewedAt: '2026-09-09T11:00:00.000Z', harshness: 'chill' });
  assert.equal(r3.round, 3);
  assert.deepEqual(disposePreviousRound(repo, key, 3, [], { harshness: 'chill' }), { fixed: 0, dismissed: 0, carried: 0, suppressed: 2 });

  // Round 4 is salvaged JSON ⇒ disposes nothing; round 5 (complete) must settle BOTH 3 and 4.
  const r4 = logReview({ ...base, reviewedAt: '2026-09-09T11:30:00.000Z', harshness: 'medium', diffSha: 'aaa' });
  logFindings(r4.id, repo, key, 4, [c('BUG', 'Off by one in pager'), c('SUGGESTION', 'Name the constant')]);
  assert.equal(disposePreviousRound(repo, key, 4, [], { recovered: true }), null, 'salvaged round judges nothing');

  // Round 5 on the IDENTICAL diff: a re-run, not a fix — absent findings stay open, re-raised ones are carried.
  const r5 = logReview({ ...base, reviewedAt: '2026-09-09T12:00:00.000Z', harshness: 'medium', diffSha: 'aaa' });
  assert.equal(r5.round, 5);
  logFindings(r5.id, repo, key, 5, [c('BUG', 'Off by one in pager')]);
  assert.deepEqual(disposePreviousRound(repo, key, 5, [c('BUG', 'Off by one in pager')], { harshness: 'medium', diffSha: 'aaa' }),
    { fixed: 0, dismissed: 0, carried: 1, suppressed: 0 }, 'unchanged code: only carried is written');

  // Round 6 with a changed diff and nothing raised: the still-open suggestion is now genuinely fixed.
  const r6 = logReview({ ...base, reviewedAt: '2026-09-09T12:30:00.000Z', harshness: 'medium', diffSha: 'bbb' });
  assert.equal(r6.round, 6);
  assert.deepEqual(disposePreviousRound(repo, key, 6, [], { harshness: 'medium', diffSha: 'bbb' }), { fixed: 2, dismissed: 0, carried: 0, suppressed: 0 },
    'round 4 leftover + round 5 carried copy both settle');
  const after6 = getLoopSummary(repo, key);
  assert.equal(after6.lastBugRound, 5);
  assert.equal(after6.cleanRounds, 1, 'round 6 is one clean judging round after the round-5 bug');

  // Round 7 on round 6's identical diff: not a judging round — cleanRounds must not advance.
  logReview({ ...base, reviewedAt: '2026-09-09T13:00:00.000Z', harshness: 'medium', diffSha: 'bbb' });
  assert.equal(getLoopSummary(repo, key).cleanRounds, 1, 'a re-run on the same diff is not a clean round');
  // Round 8 salvaged: neither.
  logReview({ ...base, reviewedAt: '2026-09-09T13:10:00.000Z', harshness: 'medium', diffSha: 'ccc', recovered: true });
  assert.equal(getLoopSummary(repo, key).cleanRounds, 1);
  // Round 9, new diff, nothing found: now two — and empty, so there is nothing left to verify.
  logReview({ ...base, reviewedAt: '2026-09-09T13:20:00.000Z', harshness: 'medium', diffSha: 'ddd' });
  assert.equal(getLoopSummary(repo, key).cleanRounds, 2);
  assert.equal(getLoopSummary(repo, key).budgetUsed, 9);
  assert.equal(getLoopSummary(repo, key).lastRoundEmpty, true);
  assert.equal(after6.lastRoundEmpty, true, 'round 6 raised nothing on a new diff');

  // Eight days later the same PR is reviewed again: a new loop for budget and clean count.
  logReview({ ...base, reviewedAt: '2026-09-17T13:20:00.000Z', harshness: 'medium', diffSha: 'eee' });
  const later = getLoopSummary(repo, key);
  assert.equal(later.budgetUsed, 1, 'a 7-day gap starts the loop over');
  assert.equal(later.cleanRounds, 1);
  assert.equal(later.rounds.length, 10, 'history is still all there');

  const db = new Database(dbPath, { readonly: true });
  const dismissed = db.prepare("SELECT dismissed_reason, disposed_at_round FROM findings WHERE title LIKE '%unused import%'").get() as any;
  assert.equal(dismissed.dismissed_reason, 'generated file');
  assert.equal(dismissed.disposed_at_round, 2);
  db.close();

  // Fingerprints ignore the line and the (prefix) tags, so a moved or re-tagged finding still matches.
  assert.equal(fingerprintOf({ file: 'x.ts', title: '(out of scope) Thing is wrong!' }), fingerprintOf({ file: 'x.ts', title: 'thing is wrong' }));
  assert.notEqual(fingerprintOf({ file: 'x.ts', title: 'thing' }), fingerprintOf({ file: 'y.ts', title: 'thing' }));
});

test('local rounds are keyed on the branch and counted separately from PR rounds', async () => {
  const { logReview, getLoopSummary } = await import('./db.js');
  const repo = 'local/repo'; // this test's own repo — nothing above touches it
  const row = (roundKey: string, harshness: string) => ({
    repo, prNumber: 0, reviewedAt: '2026-09-09T09:00:00.000Z', filesReviewed: 1, contextFilesAdded: 0, contextReasons: '[]',
    tokenCount: 10, model: 'claude', usedContextExpansion: false, falseNegative: false, mode: 'local' as const, roundKey, harshness,
  });
  assert.equal(logReview(row('local:feat/x', 'chill')).round, 1);
  assert.equal(logReview(row('local:feat/x', 'chill')).round, 2);
  assert.equal(logReview(row('pr:7', 'medium')).round, 1, 'a different key has its own counter');
  assert.equal(logReview(row('local:feat/y', 'medium')).round, 1, 'so does a different branch');
  const s = getLoopSummary(repo, 'local:feat/x');
  assert.equal(s.rounds.length, 2);

  // A PR row that names its head branch pulls that branch's local rounds into its summary, ahead of its own.
  logReview({ ...row('pr:9', 'medium'), branch: 'feat/x' });
  const pr = getLoopSummary(repo, 'pr:9');
  assert.deepEqual(pr.rounds.map((r) => `${r.key}#${r.round}`), ['local:feat/x#1', 'local:feat/x#2', 'pr:9#1']);
  assert.equal(pr.lastBugRound, null);
  assert.equal(s.rounds[0].harshness, 'chill');
  assert.equal(s.lastBugRound, null);
});

test('loopContext hands the next round its scope and every dismissal; dismissFindings settles by id', async () => {
  const { logReview, logFindings, loopContext, dismissFindings, stopAdvice, getLoopSummary } = await import('./db.js');
  const repo = 'memory/repo';
  const key = 'pr:5';
  const base = { repo, prNumber: 5, filesReviewed: 1, contextFilesAdded: 0, contextReasons: '[]', tokenCount: 1, model: 'claude',
    usedContextExpansion: false, falseNegative: false, mode: 'pr' as const, roundKey: key, harshness: 'medium' };
  assert.deepEqual(loopContext(repo, key), { nextRound: 1, lastScope: null, scopeFrom: null, dismissed: [] });

  const r1 = logReview({ ...base, reviewedAt: '2026-09-09T13:00:00.000Z', scope: 'add the widget' });
  const ids = logFindings(r1.id, repo, key, 1, [
    { severity: 'SUGGESTION', title: 'Rename widget', file: 'w.ts', line: 3, body: '' },
    { severity: 'BUG', title: 'Widget leaks', file: 'w.ts', line: 9, body: '' },
  ]);
  assert.equal(ids.length, 2);

  const d = dismissFindings([ids[0], 999999], 'name is the domain term');
  assert.deepEqual(d, { dismissed: [ids[0]], skipped: [999999] });
  assert.deepEqual(dismissFindings([ids[0]], 'again'), { dismissed: [], skipped: [ids[0]] }, 'already settled ⇒ skipped');

  const ctx = loopContext(repo, key);
  assert.equal(ctx.nextRound, 2);
  assert.equal(ctx.lastScope, 'add the widget', 'scope inherited from the last round that stated one');
  assert.deepEqual(ctx.dismissed, [{ file: 'w.ts', line: 3, title: 'Rename widget', reason: 'name is the domain term' }]);

  // A later round without a scope leaves the inherited one in place.
  logReview({ ...base, reviewedAt: '2026-09-09T13:30:00.000Z' });
  assert.equal(loopContext(repo, key).lastScope, 'add the widget');

  // The stopping rule from data: it is the count of clean JUDGING rounds that decides.
  assert.equal(stopAdvice(1, null, 1).stop, false);
  assert.equal(stopAdvice(2, null, 2).stop, true, 'two clean rounds from the start');
  assert.equal(stopAdvice(5, 4, 1).stop, false);
  assert.equal(stopAdvice(6, 4, 2).stop, true);
  assert.equal(stopAdvice(6, 4, 1).stop, false, 'two rounds since the bug, but only one could judge');
  assert.match(stopAdvice(6, 4, 2).reason, /last BUG\/SECURITY round 4/);
  assert.match(stopAdvice(3, 3, 0).reason, /2 more clean rounds/, 'clean=0 still needs the full count');
  assert.match(stopAdvice(4, 3, 1).reason, /one more clean round/);
  assert.equal(stopAdvice(4, 3, 1, true).stop, true, 'a judging round that found nothing ends the loop');
  assert.match(stopAdvice(4, 3, 1, true).reason, /found nothing/);
  assert.equal(stopAdvice(3, 3, 0, true).stop, false, 'the round that found the bug is not empty by definition; guard anyway');

  // A PR loop inherits the branch's local scope and dismissals when told its branch.
  const lrepo = 'memory/repo';
  logReview({ ...base, repo: lrepo, prNumber: 0, mode: 'local', roundKey: 'local:feat/w', reviewedAt: '2026-09-09T14:00:00.000Z', scope: 'local scope' });
  const lid = logFindings(logReview({ ...base, repo: lrepo, prNumber: 0, mode: 'local', roundKey: 'local:feat/w', reviewedAt: '2026-09-09T14:10:00.000Z' }).id,
    lrepo, 'local:feat/w', 2, [{ severity: 'NITPICK', title: 'Trailing comma', file: 'w.ts', line: 1, body: '' }]);
  dismissFindings(lid, 'style, not ours');
  const prCtx = loopContext(lrepo, 'pr:77', 'feat/w');
  assert.equal(prCtx.nextRound, 1);
  assert.equal(prCtx.lastScope, 'local scope');
  assert.deepEqual(prCtx.dismissed.map((d) => d.title), ['Trailing comma']);
  assert.equal(loopContext(lrepo, 'pr:77').lastScope, null, 'without the branch, the PR key stands alone');

  // Before the PR's first round is logged, only the branch tells the budget about the local rounds.
  assert.equal(getLoopSummary(lrepo, 'pr:77').budgetUsed, 0, 'no PR row yet and no branch given ⇒ blind');
  assert.equal(getLoopSummary(lrepo, 'pr:77', 'feat/w').budgetUsed, 2, 'branch given ⇒ the local rounds count');
  assert.match(prCtx.scopeFrom ?? '', /^local:feat\/w round 1$/);

  // The budget spans the boundary: two local rounds + the PR's first = 3 used.
  logReview({ ...base, repo: lrepo, prNumber: 77, roundKey: 'pr:77', branch: 'feat/w', reviewedAt: '2026-09-09T14:20:00.000Z' });
  assert.equal(getLoopSummary(lrepo, 'pr:77').budgetUsed, 3);

  // Scope ages out with the loop; dismissals do not.
  logReview({ ...base, repo: lrepo, prNumber: 77, roundKey: 'pr:77', branch: 'feat/w', reviewedAt: '2026-10-01T14:20:00.000Z' });
  const aged = loopContext(lrepo, 'pr:77', 'feat/w');
  assert.equal(aged.lastScope, null, 'scope from before the gap is not inherited');
  assert.deepEqual(aged.dismissed.map((d) => d.title), ['Trailing comma'], 'dismissals persist');
});
