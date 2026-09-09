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
  const attempts: Array<{ enforceSchema?: boolean; model?: string; fresh?: boolean }> = [];
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
  assert.deepEqual(h.attempts[2], { enforceSchema: true, model: undefined });
  assert.deepEqual(h.failed.map((f) => f.model), ['claude-sonnet-5', 'claude-sonnet-5'], 'both failed attempts name the model that failed');
});

test('a non-parse failure of the cheaper model skips the schema rung and goes straight to the full model', async () => {
  const h = harness([new Error('model not available in this region'), ok]);
  const { choice } = await h.run(cheaper);
  assert.equal(choice.model, undefined);
  assert.deepEqual(h.attempts, [{ model: 'claude-sonnet-5' }, { enforceSchema: true, model: undefined }]);
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
  assert.deepEqual(h.attempts, [{ model: undefined }, { model: undefined, fresh: true }]);
  assert.equal(h.failed.length, 1);
  assert.match(h.said[0], /starting a fresh one/);

  // A parse failure on a resumed round is a reply problem, not a session problem: schema rung, still resumed.
  const h2 = harness([parseError(), ok], true);
  const r2 = await h2.run(full);
  assert.equal(r2.freshened, false);
  assert.deepEqual(h2.attempts, [{ model: undefined }, { enforceSchema: true, model: undefined }]);
});
