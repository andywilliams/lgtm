import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewWithRecovery } from './recovery.js';
import type { RoundModelChoice } from './ai.js';

const ok = { summary: 'fine', comments: [] };
const parseError = () => new Error('Failed to parse review response from AI');
const cheaper: RoundModelChoice = { model: 'claude-sonnet-5', source: 'policy', reason: 'late chill round' };
const full: RoundModelChoice = { model: undefined, source: 'policy', reason: 'round 1 < 4: full model' };
const explicit: RoundModelChoice = { model: 'claude-opus-5', source: 'explicit', reason: '--model' };

function harness(script: Array<Error | typeof ok>, resuming = false) {
  const attempts: Array<{ enforceSchema?: boolean; model?: string; fresh?: string }> = [];
  const failed: Array<{ why: string; model: string | undefined }> = [];
  const said: string[] = [];
  const review = async (attempt: { enforceSchema?: boolean; model?: string }) => {
    attempts.push(attempt);
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next ?? ok;
  };
  const run = (choice: RoundModelChoice) =>
    reviewWithRecovery({ review, ai: 'claude', choice, initialChoice: choice, resuming, logFailedRound: (why, c) => failed.push({ why, model: c.model }), say: (l) => said.push(l) });
  return { run, attempts, failed, said };
}

test('a clean first attempt uses the chosen model and logs nothing', async () => {
  const h = harness([ok]);
  const { result, choice } = await h.run(cheaper);
  assert.equal(result, ok);
  assert.equal(choice, cheaper);
  assert.deepEqual(h.attempts, [{ model: 'claude-sonnet-5' }]);
  assert.deepEqual(h.failed, []);
});

test('an unparsable reply is retried on the same model with the schema enforced', async () => {
  const h = harness([parseError(), ok]);
  const { choice } = await h.run(cheaper);
  assert.equal(choice, cheaper, 'the model did not change');
  assert.deepEqual(h.attempts, [{ model: 'claude-sonnet-5' }, { enforceSchema: true, model: 'claude-sonnet-5' }]);
  assert.equal(h.failed.length, 1, 'the first attempt is logged as a failed round');
  assert.equal(h.failed[0].model, 'claude-sonnet-5');
});

test('when the policy chose the cheaper model and the schema retry also fails, the full model runs with the schema', async () => {
  const h = harness([parseError(), parseError(), ok]);
  const { choice } = await h.run(cheaper);
  assert.equal(choice.model, undefined);
  assert.match(choice.reason, /fell back to the full model/);
  assert.deepEqual(h.attempts[2], { enforceSchema: true, model: undefined, fresh: 'model-fallback' });
  assert.deepEqual(h.failed.map((f) => f.model), ['claude-sonnet-5', 'claude-sonnet-5'], 'both failed attempts name the model that failed');
});

test('a non-parse failure of the cheaper model skips the schema rung and goes straight to the full model', async () => {
  const h = harness([new Error('model not available in this region'), ok]);
  const { choice } = await h.run(cheaper);
  assert.equal(choice.model, undefined);
  assert.deepEqual(h.attempts, [{ model: 'claude-sonnet-5' }, { enforceSchema: true, model: undefined, fresh: 'model-fallback' }]);
});

test('a failure on the operator\'s own model is logged and rethrown — nothing cheaper was chosen', async () => {
  for (const choice of [full, explicit]) {
    const h = harness([new Error('529 overloaded')]);
    await assert.rejects(() => h.run(choice), /529/);
    assert.equal(h.failed.length, 1);
    assert.equal(h.attempts.length, 1);
  }
  // An unparsable reply on the full model still gets the schema retry, then rethrows.
  const h = harness([parseError(), parseError()]);
  await assert.rejects(() => h.run(full), /parse/);
  assert.deepEqual(h.attempts.map((a) => a.enforceSchema ?? false), [false, true]);
  assert.equal(h.failed.length, 2, 'every failed attempt is a logged round');
});

test('a resumed session that cannot be continued gets one fresh full round on the same model first', async () => {
  const h = harness([new Error('No conversation found with session ID'), ok], true);
  const { choice, freshened } = await h.run(full);
  assert.equal(freshened, true);
  assert.equal(choice, full);
  assert.deepEqual(h.attempts, [{ model: undefined }, { model: undefined, fresh: 'session-lost' }]);
  assert.equal(h.failed.length, 1);
  assert.match(h.said[0], /starting a fresh one/);

  // A parse failure on a resumed round is a reply problem, not a session problem: schema rung, still resumed.
  const h2 = harness([parseError(), ok], true);
  const r2 = await h2.run(full);
  assert.equal(r2.freshened, false);
  assert.deepEqual(h2.attempts, [{ model: undefined }, { enforceSchema: true, model: undefined }]);
});

test('when the fresh session also fails, the error that surfaces is the latest one', async () => {
  const h = harness([new Error('No conversation found with session ID'), new Error('529 overloaded on the fresh call')], true);
  await assert.rejects(() => h.run(full), /529 overloaded/);
  assert.equal(h.failed.length, 2);
});

test('every fresh rung after the first continues the session the first one created', async () => {
  // Mirrors runReview's `review` closure: one fresh session, created once then resumed.
  const freshSession = { id: 'fresh-1', resume: false };
  const loopSession = { id: 'loop-1', resume: true };
  const started = new Set<string>();
  const seen: Array<{ id: string; resume: boolean }> = [];
  const script: Array<Error | typeof ok> = [new Error('No conversation found with session ID'), parseError(), ok];
  const review = async (attempt: { enforceSchema?: boolean; model?: string; fresh?: string }) => {
    const base = attempt.fresh ? freshSession : loopSession;
    const session = { ...base, resume: base.resume || started.has(base.id) };
    seen.push(session);
    started.add(session.id);
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next ?? ok;
  };
  await reviewWithRecovery({ review, ai: 'claude', choice: full, initialChoice: full, resuming: true, logFailedRound: () => {}, say: () => {} });
  assert.deepEqual(seen, [
    { id: 'loop-1', resume: true },    // the loop's session — not found
    { id: 'fresh-1', resume: false },  // created by the freshen rung
    { id: 'fresh-1', resume: true },   // the schema rung continues it, never re-creates it
  ]);
});

test('a lost session and a model fallback in the same round use different sessions', async () => {
  // The combined path: resumed round, session gone, freshened, reply unparsable, then the
  // policy's cheaper model gives way to the full one — which must not inherit its transcript.
  const ids = new Map<string, string>();
  const started = new Set<string>();
  const seen: Array<{ id: string; resume: boolean }> = [];
  const script: Array<Error | typeof ok> = [new Error('No conversation found'), parseError(), parseError(), ok];
  const review = async (attempt: { enforceSchema?: boolean; model?: string; fresh?: string }) => {
    const key = attempt.fresh ?? 'loop';
    if (!ids.has(key)) ids.set(key, key === 'loop' ? 'loop-1' : `${key}-id`);
    const id = ids.get(key)!;
    const session = { id, resume: key === 'loop' || started.has(id) };
    seen.push(session);
    started.add(id);
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next ?? ok;
  };
  await reviewWithRecovery({ review, ai: 'claude', choice: cheaper, initialChoice: cheaper, resuming: true, logFailedRound: () => {}, say: () => {} });
  assert.deepEqual(seen.map((s) => s.id), ['loop-1', 'session-lost-id', 'session-lost-id', 'model-fallback-id']);
  assert.equal(seen[3].resume, false, 'the full model starts its own session');
});

test('a session opened by round 1 itself is resumed by the retry rungs, never re-created', async () => {
  const roundOneSession = { id: 'loop-1', resume: false }; // planSession opened it this round
  const started = new Set<string>();
  const seen: Array<{ id: string; resume: boolean }> = [];
  const script: Array<Error | typeof ok> = [parseError(), ok];
  const review = async (attempt: { enforceSchema?: boolean; model?: string; fresh?: string }) => {
    const base = attempt.fresh ? { id: 'fresh-1', resume: false } : roundOneSession;
    const session = { ...base, resume: base.resume || started.has(base.id) };
    seen.push(session);
    started.add(session.id);
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next ?? ok;
  };
  await reviewWithRecovery({ review, ai: 'claude', choice: full, initialChoice: full, logFailedRound: () => {}, say: () => {} });
  assert.deepEqual(seen, [{ id: 'loop-1', resume: false }, { id: 'loop-1', resume: true }]);
});

test('freshReason is set only when the session was the problem, not the model', async () => {
  const lost = harness([new Error('No conversation found with session ID'), ok], true);
  const a = await lost.run(full);
  assert.match(a.freshReason ?? '', /could not be continued/);

  const modelFallback = harness([parseError(), parseError(), ok]);
  const b = await modelFallback.run(cheaper);
  assert.equal(b.freshReason, undefined, 'a model fallback says so in choice.reason instead');
  assert.match(b.choice.reason, /fell back to the full model/);
});

test('the full-model fallback always opens its own session — a cheaper session\'s cache is model-scoped', async () => {
  const h = harness([parseError(), parseError(), ok]);
  const { choice } = await h.run(cheaper);
  assert.equal(choice.model, undefined);
  assert.equal(h.attempts[2].fresh, 'model-fallback', 'the fallback rung opens its own session');
});
