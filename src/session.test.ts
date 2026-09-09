import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSession, modelRoleOf, SYSTEM_PROMPT_KEY, SESSION_CONTEXT_BUDGET } from './session.js';
import type { RoundModelChoice } from './ai.js';
import type { LoopSession } from './db.js';

const full: RoundModelChoice = { model: undefined, source: 'policy', reason: 'round 1 < 4: full model' };
const late: RoundModelChoice = { model: 'claude-sonnet-5', source: 'policy', reason: 'late chill round' };
const explicitSonnet: RoundModelChoice = { model: 'claude-sonnet-5', source: 'explicit', reason: '--model' };
const contents = { 'a.ts': 'A', 'b.ts': 'B' };
const prior = (over: Partial<LoopSession> = {}): LoopSession => ({ id: 'sess-1', model: 'claude-fable-5-1', role: 'full', fileShas: {}, lastPromptTokens: 250_000, ...over });

test('modelRoleOf compares what was asked for, suffix-free', () => {
  assert.equal(modelRoleOf(full), 'full');
  assert.equal(modelRoleOf(late), 'late:claude-sonnet-5');
  assert.equal(modelRoleOf({ model: 'claude-fable-5-1[1m]', source: 'explicit', reason: '--model' }), 'explicit:claude-fable-5-1');
});

test('no session when sessions are off or the provider is codex', () => {
  assert.equal(planSession({ prior: null, contents, ai: 'codex', choice: full }).session, null);
  const saved = process.env.LGTM_SESSIONS;
  process.env.LGTM_SESSIONS = 'off';
  try { assert.equal(planSession({ prior: null, contents, ai: 'claude', choice: full }).session, null); }
  finally { if (saved === undefined) delete process.env.LGTM_SESSIONS; else process.env.LGTM_SESSIONS = saved; }
});

test('first round opens a session with the full prompt', () => {
  const p = planSession({ prior: null, contents, ai: 'claude', choice: full, newId: () => 'new-1' });
  assert.deepEqual(p.session, { id: 'new-1', resume: false, changedSinceLast: {}, unchangedFiles: [] });
  assert.equal(p.choice, full);
  assert.deepEqual(Object.keys(p.fileShas).sort(), ['a.ts', 'b.ts']);
});

test('same role continues the session and sends only what moved', () => {
  const first = planSession({ prior: null, contents, ai: 'claude', choice: full });
  const p = planSession({ prior: prior({ fileShas: { 'a.ts': first.fileShas['a.ts'] } }), contents: { 'a.ts': 'A', 'b.ts': 'B2' }, ai: 'claude', choice: full });
  assert.ok(p.session?.resume);
  assert.deepEqual(p.session?.changedSinceLast, { 'b.ts': 'B2' });
  assert.deepEqual(p.session?.unchangedFiles, ['a.ts']);
  assert.match(p.choice.reason, /continuing the loop's session/);
});

test('a full-model session is continued when the policy would merely go cheaper', () => {
  const p = planSession({ prior: prior(), contents, ai: 'claude', choice: late });
  assert.ok(p.session?.resume);
  assert.equal(p.choice.model, undefined, 'stays on the full model');
  assert.match(p.choice.reason, /prompt cache beats claude-sonnet-5/);
});

test('a cheaper-model session is NOT continued when the policy needs the full model', () => {
  const p = planSession({ prior: prior({ role: 'late:claude-sonnet-5', model: 'claude-sonnet-5' }), contents, ai: 'claude', choice: full, newId: () => 'new-2' });
  assert.equal(p.session?.resume, false);
  assert.equal(p.session?.id, 'new-2');
  assert.match(p.note ?? '', /not continuing sess-1/);
});

test('an explicit --model is honoured exactly: continued only on a session of the same explicit role', () => {
  assert.ok(planSession({ prior: prior({ role: 'explicit:claude-sonnet-5' }), contents, ai: 'claude', choice: explicitSonnet }).session?.resume);
  assert.equal(planSession({ prior: prior({ role: 'full' }), contents, ai: 'claude', choice: explicitSonnet }).session?.resume, false, 'a full session is not continued for an explicit cheaper model');
  const kept = planSession({ prior: prior({ role: 'explicit:claude-sonnet-5' }), contents, ai: 'claude', choice: explicitSonnet }).choice;
  assert.equal(kept.source, 'explicit', 'the explicit source survives the continuation');
});

test('--fresh always opens a new session', () => {
  const p = planSession({ prior: prior(), contents, ai: 'claude', choice: full, fresh: true, newId: () => 'new-3' });
  assert.equal(p.session?.resume, false);
  assert.equal(p.note, undefined);
});

test('an unknown session role is never continued', () => {
  const p = planSession({ prior: prior({ role: null }), contents, ai: 'claude', choice: full, newId: () => 'new-4' });
  assert.equal(p.session?.resume, false);
});

test('a changed reviewer system prompt restarts the session; a changed charter is sent as updated context', () => {
  const withRules = { ...contents, [SYSTEM_PROMPT_KEY]: 'rules v1', '@charter': 'charter v1' };
  const first = planSession({ prior: null, contents: withRules, ai: 'claude', choice: full });
  const seen = prior({ fileShas: first.fileShas });
  const sameRules = planSession({ prior: seen, contents: { ...withRules, '@charter': 'charter v2' }, ai: 'claude', choice: full });
  assert.ok(sameRules.session?.resume);
  assert.deepEqual(Object.keys(sameRules.session!.changedSinceLast), ['@charter']);
  const newRules = planSession({ prior: seen, contents: { ...withRules, [SYSTEM_PROMPT_KEY]: 'rules v2' }, ai: 'claude', choice: full, newId: () => 'new-5' });
  assert.equal(newRules.session?.resume, false);
  assert.match(newRules.note ?? '', /system prompt changed/);
});

test('a session that would pass the context budget is not continued — a fresh one beats a compacted one', () => {
  const big = { 'a.ts': 'x'.repeat(400_000) }; // ~100k tokens of changed content
  const p = planSession({ prior: prior({ lastPromptTokens: SESSION_CONTEXT_BUDGET - 50_000 }), contents: big, ai: 'claude', choice: full, newId: () => 'new-6' });
  assert.equal(p.session?.resume, false);
  assert.match(p.note ?? '', /past the 700k budget/);
  const ok = planSession({ prior: prior({ lastPromptTokens: 200_000 }), contents: big, ai: 'claude', choice: full });
  assert.ok(ok.session?.resume, 'well under budget ⇒ continue');
  const unknown = planSession({ prior: prior({ lastPromptTokens: null }), contents: big, ai: 'claude', choice: full });
  assert.ok(unknown.session?.resume, 'no usage recorded ⇒ budget cannot be judged, continue');
});
