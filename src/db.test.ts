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
      costUsd: 1.25, durationMs: 42_000, models: ['claude-haiku-4-5-20251001', 'claude-fable-5-1'], calls: 1, lastPromptTokens: 100_010, sentTokens: 90_000, measured: true,
    },
  });
  // A codex round (no envelope) — recorded as an estimate, never as a suspiciously cheap measurement.
  logReview({ ...base, prNumber: 8, model: 'codex', usage: { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, models: [], calls: 1, lastPromptTokens: 0, sentTokens: 0, measured: false } });

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
    usage: { inputTokens: 0, cacheCreationTokens: 1000, cacheReadTokens: 0, outputTokens: 10, costUsd: 2, durationMs: 1, models: ['claude-fable-5-1'], calls: 1, lastPromptTokens: 1000, sentTokens: 900, measured: true } });
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
  assert.equal(getLoopSummary(repo, key).openBugs, 1, 'the round-5 copy of the bug is still open');

  // Round 6 with a changed diff and nothing raised: the still-open suggestion is now genuinely fixed.
  const r6 = logReview({ ...base, reviewedAt: '2026-09-09T12:30:00.000Z', harshness: 'medium', diffSha: 'bbb' });
  assert.equal(r6.round, 6);
  assert.deepEqual(disposePreviousRound(repo, key, 6, [], { harshness: 'medium', diffSha: 'bbb' }), { fixed: 2, dismissed: 0, carried: 0, suppressed: 0 },
    'round 4 leftover + round 5 carried copy both settle');
  const after6 = getLoopSummary(repo, key);
  assert.equal(after6.lastBugRound, 5);
  assert.equal(after6.openBugs, 0, 'round 6 settled the carried bug');
  assert.equal(after6.cleanRounds, 1, 'round 6 is one clean judging round after the round-5 bug');

  // Round 7 on round 6's identical diff: not a judging round — cleanRounds must not advance.
  logReview({ ...base, reviewedAt: '2026-09-09T13:00:00.000Z', harshness: 'medium', diffSha: 'bbb' });
  assert.equal(getLoopSummary(repo, key).cleanRounds, 1, 'a re-run on the same diff is not a clean round');
  // Round 8 salvaged: neither.
  logReview({ ...base, reviewedAt: '2026-09-09T13:10:00.000Z', harshness: 'medium', diffSha: 'ccc', recovered: true });
  assert.equal(getLoopSummary(repo, key).cleanRounds, 1);
  // A failed round (no review came back) is logged for its cost but is not a judging round.
  logReview({ ...base, reviewedAt: '2026-09-09T13:15:00.000Z', harshness: 'chill', diffSha: 'ccc2', failed: true, modelReason: 'late chill round: cheaper model' });
  const withFailed = getLoopSummary(repo, key);
  assert.equal(withFailed.cleanRounds, 1, 'a failed round neither counts nor resets');
  assert.equal(withFailed.rounds[withFailed.rounds.length - 1].failed, true);

  // The retry after a failed round carries the SAME sha as the failed row; it must still
  // count as a judging round (compared with the last round that reviewed, 'bbb').
  const retry = logReview({ ...base, reviewedAt: '2026-09-09T13:16:00.000Z', harshness: 'chill', diffSha: 'ccc2' });
  assert.equal(retry.round, 10);
  assert.equal(getLoopSummary(repo, key).cleanRounds, 2, 'the retry is a real clean round, not a re-run of the failed row');
  assert.deepEqual(disposePreviousRound(repo, key, 10, [], { harshness: 'chill', diffSha: 'ccc2' }), { fixed: 0, dismissed: 0, carried: 0, suppressed: 0 },
    'nothing open to dispose, but the call must not be short-circuited as an unchanged diff');

  // Round 11, new diff, nothing found: three clean — and empty, so there is nothing left to verify.
  logReview({ ...base, reviewedAt: '2026-09-09T13:20:00.000Z', harshness: 'medium', diffSha: 'ddd' });
  assert.equal(getLoopSummary(repo, key).cleanRounds, 3);
  assert.equal(getLoopSummary(repo, key).budgetUsed, 11, 'the failed round still spent a slot of the budget');
  assert.equal(getLoopSummary(repo, key).lastRoundEmpty, true);
  assert.equal(after6.lastRoundEmpty, true, 'round 6 raised nothing on a new diff');

  // Eight days later the same PR is reviewed again: a new loop for budget and clean count.
  logReview({ ...base, reviewedAt: '2026-09-17T13:20:00.000Z', harshness: 'medium', diffSha: 'eee' });
  const later = getLoopSummary(repo, key);
  assert.equal(later.budgetUsed, 1, 'a 7-day gap starts the loop over');
  assert.equal(later.cleanRounds, 1);
  assert.equal(later.rounds.length, 12, 'history is still all there');

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
  const { logReview, logFindings, loopContext, dismissFindings, stopAdvice, getLoopSummary, disposePreviousRound } = await import('./db.js');
  const repo = 'memory/repo';
  const key = 'pr:5';
  const base = { repo, prNumber: 5, filesReviewed: 1, contextFilesAdded: 0, contextReasons: '[]', tokenCount: 1, model: 'claude',
    usedContextExpansion: false, falseNegative: false, mode: 'pr' as const, roundKey: key, harshness: 'medium' };
  assert.deepEqual(loopContext(repo, key), { nextRound: 1, lastScope: null, scopeFrom: null, dismissed: [], session: null });

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

  // The PR's first round settles the local loop's open findings (the local NITPICK above is
  // already dismissed; add an open BUG and watch the PR round dispose it).
  logFindings(logReview({ ...base, repo: lrepo, prNumber: 0, mode: 'local', roundKey: 'local:feat/w', reviewedAt: '2026-09-09T14:15:00.000Z', diffSha: 'L1' }).id,
    lrepo, 'local:feat/w', 3, [{ severity: 'BUG', title: 'Leaks the handle', file: 'w.ts', line: 7, body: '' }]);
  assert.equal(getLoopSummary(lrepo, 'pr:77', 'feat/w').openBugs, 1);
  assert.deepEqual(disposePreviousRound(lrepo, 'pr:77', 1, [], { harshness: 'medium', diffSha: 'P1', branch: 'feat/w' }),
    { fixed: 1, dismissed: 0, carried: 0, suppressed: 0 }, 'PR round 1 judges the local rounds');
  assert.equal(disposePreviousRound(lrepo, 'pr:77', 1, [], { harshness: 'medium', diffSha: 'P1' }), null, 'without the branch a first round has nothing to judge');

  // The budget spans the boundary: two local rounds + the PR's first = 3 used.
  logReview({ ...base, repo: lrepo, prNumber: 77, roundKey: 'pr:77', branch: 'feat/w', reviewedAt: '2026-09-09T14:20:00.000Z' });
  assert.equal(getLoopSummary(lrepo, 'pr:77').budgetUsed, 4);
  assert.equal(getLoopSummary(lrepo, 'pr:77').openBugs, 0, 'the local BUG was settled by the PR round');

  // The loop's session: latest round with one, file shas accumulated across its rounds; a PR round finds the local loop's.
  logReview({ ...base, repo: lrepo, prNumber: 0, mode: 'local', roundKey: 'local:feat/w', reviewedAt: '2026-09-09T14:25:00.000Z', sessionId: 'sess-1', fileShas: { 'a.ts': 'a1', 'b.ts': 'b1' },
    usage: { inputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 1, costUsd: 0.1, durationMs: 1, models: ['claude-fable-5-1'], calls: 1, lastPromptTokens: 1000, sentTokens: 900, measured: true } });
  logReview({ ...base, repo: lrepo, prNumber: 0, mode: 'local', roundKey: 'local:feat/w', reviewedAt: '2026-09-09T14:26:00.000Z', sessionId: 'sess-1', fileShas: { 'a.ts': 'a2' } });
  const sess = loopContext(lrepo, 'pr:77', 'feat/w').session;
  assert.ok(sess);
  assert.equal(sess.id, 'sess-1');
  assert.equal(sess.model, 'claude-fable-5-1');
  assert.equal(sess.role, null, 'no model_role recorded ⇒ null, never inferred');
  assert.equal(sess.lastPromptTokens, 901, 'what we SENT plus the reply, not the envelope\'s per-turn sum');
  assert.deepEqual(sess.fileShas, { 'a.ts': 'a2', 'b.ts': 'b1' }, 'latest sha per file across the session');
  logReview({ ...base, repo: lrepo, prNumber: 0, mode: 'local', roundKey: 'local:feat/w', reviewedAt: '2026-09-09T14:27:00.000Z', sessionId: 'sess-1', modelRole: 'full' });
  assert.equal(loopContext(lrepo, 'pr:77', 'feat/w').session?.role, 'full', 'the column wins when present');
  assert.equal(loopContext(lrepo, 'pr:77').session, null, 'without the branch the PR key has no session yet');

  // Scope ages out with the loop; dismissals do not.
  logReview({ ...base, repo: lrepo, prNumber: 77, roundKey: 'pr:77', branch: 'feat/w', reviewedAt: '2026-10-01T14:20:00.000Z' });
  const aged = loopContext(lrepo, 'pr:77', 'feat/w');
  assert.equal(aged.lastScope, null, 'scope from before the gap is not inherited');
  assert.deepEqual(aged.dismissed.map((d) => d.title), ['Trailing comma'], 'dismissals persist');
});

test('prompt v2: a finding logged under the old title key is still matched by a fingerprinted round', async () => {
  const { logReview, logFindings, disposePreviousRound, getLoopSummary, keysFor } = await import('./db.js');
  const repo = 'v2/repo';
  const key = 'pr:1';
  const base = { repo, prNumber: 1, filesReviewed: 1, contextFilesAdded: 0, contextReasons: '[]', tokenCount: 1, model: 'claude',
    usedContextExpansion: false, falseNegative: false, mode: 'pr' as const, roundKey: key };

  // Round 1, pre-v2: no fingerprint, so the row's key is file#title.
  const r1 = logReview({ ...base, reviewedAt: '2026-09-10T09:00:00.000Z', harshness: 'medium', diffSha: 'a' });
  logFindings(r1.id, repo, key, 1, [
    { severity: 'BUG', title: 'Null deref in parseRow', file: 'a.ts', line: 1, body: '' },
    { severity: 'SUGGESTION', title: 'Name the constant', file: 'a.ts', line: 5, body: '', confidence: 'medium' },
  ]);

  // Round 2, v2: the same complaint arrives with a fingerprint and a different title.
  const same = { severity: 'BUG' as const, title: 'parseRow dereferences a null row', file: 'a.ts', line: 2, body: '', fingerprint: 'Null deref in parseRow', confidence: 'high' as const };
  assert.ok(keysFor(same).length === 2, 'both spellings are offered');
  const r2 = logReview({ ...base, reviewedAt: '2026-09-10T09:10:00.000Z', harshness: 'medium', diffSha: 'b' });
  logFindings(r2.id, repo, key, 2, [same]);
  assert.deepEqual(disposePreviousRound(repo, key, 2, [same], { harshness: 'medium', diffSha: 'b' }),
    { fixed: 1, dismissed: 0, carried: 1, suppressed: 0 }, 'carried, not silently fixed');

  // Round 3 at chill: the round-2 BUG is high confidence so its absence is a fix; a
  // medium-confidence finding would only be below chill's bar.
  const r3 = logReview({ ...base, reviewedAt: '2026-09-10T09:20:00.000Z', harshness: 'chill', diffSha: 'c' });
  logFindings(r3.id, repo, key, 3, []);
  assert.deepEqual(disposePreviousRound(repo, key, 3, [], { harshness: 'chill', diffSha: 'c' }),
    { fixed: 1, dismissed: 0, carried: 0, suppressed: 0 });

  const s = getLoopSummary(repo, key);
  assert.equal(s.rounds[1].absences, 0);
  assert.equal(s.rounds[1].highConfidence, 1, 'kind and confidence are recorded per finding');
});

test('prompt v2: a medium-confidence finding absent from a chill round is suppressed, not fixed', async () => {
  const { logReview, logFindings, disposePreviousRound } = await import('./db.js');
  const repo = 'v2b/repo';
  const key = 'pr:2';
  const base = { repo, prNumber: 2, filesReviewed: 1, contextFilesAdded: 0, contextReasons: '[]', tokenCount: 1, model: 'claude',
    usedContextExpansion: false, falseNegative: false, mode: 'pr' as const, roundKey: key };
  const r1 = logReview({ ...base, reviewedAt: '2026-09-10T10:00:00.000Z', harshness: 'medium', diffSha: 'a' });
  logFindings(r1.id, repo, key, 1, [
    { severity: 'BUG', title: 'Maybe a race', file: 'a.ts', line: 1, body: '', confidence: 'medium', kind: 'missing' },
    { severity: 'BUG', title: 'Demonstrated crash', file: 'a.ts', line: 2, body: '', confidence: 'high' },
  ]);
  logFindings(r1.id, repo, key, 1, [
    { severity: 'SUGGESTION', title: 'Could be clearer', file: 'a.ts', line: 3, body: '', confidence: 'medium' },
  ]);
  logReview({ ...base, reviewedAt: '2026-09-10T10:10:00.000Z', harshness: 'chill', diffSha: 'b' });
  assert.deepEqual(disposePreviousRound(repo, key, 2, [], { harshness: 'chill', diffSha: 'b' }),
    { fixed: 1, dismissed: 0, carried: 0, suppressed: 1 },
    'the high-confidence BUG is fixed; the medium SUGGESTION is suppressed; the medium BUG is neither');

  // The medium-confidence BUG is still OPEN: a chill round asks only for high-confidence
  // findings, so its silence cannot close an unverified bug — and openBugs keeps the
  // model policy on the full model until it is settled.
  const { getLoopSummary } = await import('./db.js');
  assert.equal(getLoopSummary(repo, key).openBugs, 1, 'the unverified BUG stays open rather than reading as fixed');
});

test('a verifier-dropped finding is logged, but is not part of what the round found', async () => {
  const { logReview, logFindings, getLoopSummary, stopAdvice } = await import('./db.js');
  const repo = 'verify/repo';
  const key = 'pr:9';
  const base = { repo, prNumber: 9, filesReviewed: 1, contextFilesAdded: 0, contextReasons: '[]', tokenCount: 1, model: 'claude',
    usedContextExpansion: false, falseNegative: false, mode: 'pr' as const, roundKey: key };

  // One round: a BUG the verifier refuted, and a SUGGESTION it confirmed.
  const r1 = logReview({ ...base, reviewedAt: '2026-09-10T11:00:00.000Z', harshness: 'medium', diffSha: 'a',
    verify: { model: 'claude-sonnet-5', measured: true, costUsd: 0.04, tokens: 9000 } });
  logFindings(r1.id, repo, key, 1, [
    { severity: 'BUG', title: 'Refuted crash', file: 'a.ts', line: 1, body: '', confidence: 'high', verdict: 'refuted', verifier_note: 'the guard is on line 8', verifier_dropped: true },
    { severity: 'SUGGESTION', title: 'Real nit', file: 'a.ts', line: 2, body: '', confidence: 'medium', verdict: 'confirmed' },
  ]);

  const s = getLoopSummary(repo, key);
  // Without `verified` the drop rate has no denominator: a round that never ran the pass
  // and a round that ran it and dropped nothing would look identical, and the metric this
  // feature is justified by would silently stop printing rather than print a wrong number.
  assert.equal(s.rounds[0].verified, true);
  assert.equal(s.rounds[0].verifyFailed, null);
  assert.equal(s.rounds[0].dropped, 1, 'the drop is on the row — that is what makes the false-positive rate measurable');
  assert.equal(s.rounds[0].confirmed, 1);
  assert.equal(s.rounds[0].findings, 1, 'a dropped finding is not something the round found');
  assert.equal(s.rounds[0].bySeverity.BUG, 0, 'a refuted BUG must not drive the stopping rule');
  assert.equal(s.rounds[0].verifyCostUsd, 0.04);
  assert.equal(s.rounds[0].verifyModel, 'claude-sonnet-5');
  assert.equal(s.lastBugRound, null);
  assert.equal(s.openBugs, 0, 'a refuted BUG is settled at insert, not left open for a later round');
  assert.equal(stopAdvice(1, s.lastBugRound, s.cleanRounds, s.lastRoundEmpty).stop, false, 'one clean round is not two');
});

test('a finding re-raised and then dropped reads as carried, never as fixed', async () => {
  const { logReview, logFindings, disposePreviousRound, getLoopSummary } = await import('./db.js');
  const repo = 'verify2/repo';
  const key = 'pr:10';
  const base = { repo, prNumber: 10, filesReviewed: 1, contextFilesAdded: 0, contextReasons: '[]', tokenCount: 1, model: 'claude',
    usedContextExpansion: false, falseNegative: false, mode: 'pr' as const, roundKey: key };
  const claim = { severity: 'BUG' as const, title: 'Contested crash', file: 'a.ts', line: 1, body: '', confidence: 'high' as const };

  const r1 = logReview({ ...base, reviewedAt: '2026-09-10T12:00:00.000Z', harshness: 'medium', diffSha: 'a' });
  logFindings(r1.id, repo, key, 1, [claim]);

  // Round 2 raises the same complaint; the verifier refutes it. Nothing was FIXED — the
  // code moved but the claim was answered, so round 1's row must not read as a fix.
  const r2 = logReview({ ...base, reviewedAt: '2026-09-10T12:10:00.000Z', harshness: 'medium', diffSha: 'b' });
  const again = { ...claim, verdict: 'refuted' as const, verifier_dropped: true, verifier_note: 'the guard is on line 8' };
  logFindings(r2.id, repo, key, 2, [again]);
  assert.deepEqual(disposePreviousRound(repo, key, 2, [again], { harshness: 'medium', diffSha: 'b' }),
    { fixed: 0, dismissed: 0, carried: 1, suppressed: 0 });

  const s = getLoopSummary(repo, key);
  assert.equal(s.openBugs, 0, 'the claim is settled: carried on round 1, refuted on round 2');
  assert.equal(s.rounds[1].bySeverity.BUG, 0);
});

test('the verifier severity stored is the final one; the reviewer claim survives beside it', async () => {
  const { logReview, logFindings, initDb } = await import('./db.js');
  const repo = 'verify3/repo';
  const key = 'pr:11';
  const r = logReview({ repo, prNumber: 11, reviewedAt: '2026-09-10T13:00:00.000Z', filesReviewed: 1, contextFilesAdded: 0,
    contextReasons: '[]', tokenCount: 1, model: 'claude', usedContextExpansion: false, falseNegative: false,
    mode: 'pr', roundKey: key, harshness: 'medium', diffSha: 'a', verify: { measured: true, costUsd: null, tokens: null, failed: 'the verifier returned no verdicts' } });
  logFindings(r.id, repo, key, 1, [
    { severity: 'SUGGESTION', title: 'Downgraded', file: 'a.ts', line: 1, body: '', verdict: 'confirmed', original_severity: 'BUG', verifier_evidence: ['x'] },
  ]);
  const db = initDb();
  const row = db.prepare('SELECT severity, original_severity, verdict, verifier_evidence, disposition FROM findings WHERE repo = ?').get(repo) as any;
  const review = db.prepare('SELECT verify_failed, verify_cost_usd FROM reviews WHERE id = ?').get(r.id) as any;
  db.close();
  assert.equal(row.severity, 'SUGGESTION', 'the stopping rule reads the final severity');
  assert.equal(row.original_severity, 'BUG', 'and the reviewer claim is still auditable');
  assert.equal(row.disposition, null, 'a confirmed finding is open, like any other');
  assert.deepEqual(JSON.parse(row.verifier_evidence), ['x']);
  assert.equal(review.verify_failed, 'the verifier returned no verdicts', 'a pass that ran and could not answer is not the same round as one that did not run');
  assert.equal(review.verify_cost_usd, null);
});

test('a round that ran no verifier, one whose verifier failed, and one that verified are three different rounds', async () => {
  const { logReview, logFindings, getLoopSummary } = await import('./db.js');
  const repo = 'verify4/repo';
  const key = 'pr:12';
  const base = { repo, prNumber: 12, filesReviewed: 1, contextFilesAdded: 0, contextReasons: '[]', tokenCount: 1, model: 'claude',
    usedContextExpansion: false, falseNegative: false, mode: 'pr' as const, roundKey: key, harshness: 'medium' };
  const one = { severity: 'SUGGESTION' as const, title: 'a', file: 'a.ts', line: 1, body: '' };

  const r1 = logReview({ ...base, reviewedAt: '2026-09-10T14:00:00.000Z', diffSha: 'a' }); // no pass at all
  logFindings(r1.id, repo, key, 1, [one]);
  const r2 = logReview({ ...base, reviewedAt: '2026-09-10T14:10:00.000Z', diffSha: 'b',
    verify: { model: 'claude-sonnet-5', measured: true, costUsd: null, tokens: null, failed: 'the verifier returned no verdicts' } });
  logFindings(r2.id, repo, key, 2, [{ ...one, title: 'b' }]);
  const r3 = logReview({ ...base, reviewedAt: '2026-09-10T14:20:00.000Z', diffSha: 'c',
    verify: { model: 'claude-sonnet-5', measured: true, costUsd: 0.02, tokens: 5000 } });
  logFindings(r3.id, repo, key, 3, [{ ...one, title: 'c', verdict: 'refuted', verifier_dropped: true }]);

  const rounds = getLoopSummary(repo, key).rounds;
  assert.deepEqual(rounds.map((r) => [r.verified, r.verifyFailed !== null]), [[false, false], [true, true], [true, false]]);
  // The rate is 1 of 1 on the one round that was adjudicated — not 1 of 3 across a loop
  // where two rounds were never checked.
  const adjudicated = rounds.filter((r) => r.verified && !r.verifyFailed);
  assert.equal(adjudicated.reduce((n, r) => n + r.findings + r.dropped, 0), 1);
  assert.equal(adjudicated.reduce((n, r) => n + r.dropped, 0), 1);
});

test('a codex verifier does not cost the round its measured review numbers', async () => {
  const { logReview, initDb } = await import('./db.js');
  const { mergeRoundUsage, emptyUsage } = await import('./ai.js');
  const repo = 'verify5/repo';
  const measuredReview = { ...emptyUsage(), calls: 1, inputTokens: 1000, outputTokens: 100, costUsd: 1.25, durationMs: 900, models: ['claude-opus-5'], sentTokens: 400, lastPromptTokens: 1000 };
  const unmeasuredVerify = { ...emptyUsage(), calls: 1, measured: false, sentTokens: 40 };
  const r = logReview({
    repo, prNumber: 12, reviewedAt: '2026-09-10T15:00:00.000Z', filesReviewed: 1, contextFilesAdded: 0, contextReasons: '[]',
    tokenCount: 1, model: 'claude', usedContextExpansion: false, falseNegative: false, mode: 'pr', roundKey: 'pr:13', harshness: 'medium',
    usage: mergeRoundUsage(measuredReview, unmeasuredVerify),
    verify: { model: undefined, measured: false, costUsd: null, tokens: null },
  });
  const db = initDb();
  const row = db.prepare('SELECT usage_source, cost_usd, model_id, sent_tokens FROM reviews WHERE id = ?').get(r.id) as any;
  db.close();
  // codex reports no usage. Before this, one unmeasured half threw away the claude half
  // too — so the flag the feature recommends for decorrelation made the round cost-blind.
  assert.equal(row.cost_usd, 1.25);
  assert.equal(row.model_id, 'claude-opus-5');
  assert.equal(row.usage_source, 'partial', 'and the row says which half was not measured');
  assert.equal(row.sent_tokens, 400, 'the session still holds only what the review sent');
});
