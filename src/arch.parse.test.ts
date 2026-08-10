import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseArchResponse, formatArchComment } from './arch.js';

// Guards the normalization that keeps the authority ladder honest: unknown enum
// values must collapse to the WEAKEST claim (judgement / cheap / low), never a
// stronger one, and the verdict must reflect what actually survived — a model
// claiming "decisions-found" with an empty array must not mislead a caller.

const decision = (over: Record<string, unknown> = {}) => ({
  id: 'a-decision',
  decision: 'A new table was created instead of extending an existing one',
  evidence: ['serverless.yml:583-593'],
  rationale_found: 'none',
  alternatives_not_taken: ['a new event type'],
  reversibility: 'costly',
  ramifications: ['a second write path'],
  authority: 'diff-evidence',
  confidence: 'medium',
  falsifiable_by: 'if rows need in-place updates',
  ask_the_author: 'What made a separate table right here?',
  ...over,
});

describe('parseArchResponse', () => {
  it('parses a clean response', () => {
    const r = parseArchResponse(JSON.stringify({
      verdict: 'decisions-found',
      summary: 'One structural decision.',
      decisions: [decision()],
      skipped_checks: ['charter-grounded checks — repo has no ARCHITECTURE.md'],
    }));
    assert.strictEqual(r.verdict, 'decisions-found');
    assert.strictEqual(r.decisions.length, 1);
    assert.strictEqual(r.decisions[0].authority, 'diff-evidence');
    assert.strictEqual(r.skipped_checks.length, 1);
    assert.strictEqual(r.recovered, undefined);
  });

  it('collapses unknown enum values to the weakest claim, never a stronger one', () => {
    const r = parseArchResponse(JSON.stringify({
      verdict: 'decisions-found',
      summary: 's',
      decisions: [decision({ authority: 'organisational-standard', reversibility: 'irreversible!!', confidence: 'certain' })],
      skipped_checks: [],
    }));
    assert.strictEqual(r.decisions[0].authority, 'judgement');
    assert.strictEqual(r.decisions[0].reversibility, 'cheap');
    assert.strictEqual(r.decisions[0].confidence, 'low');
  });

  it('caps decisions at 5, keeping the first (highest-ranked)', () => {
    const decisions = Array.from({ length: 8 }, (_, i) => decision({ id: `d${i}`, decision: `Decision ${i}` }));
    const r = parseArchResponse(JSON.stringify({ verdict: 'decisions-found', summary: 's', decisions, skipped_checks: [] }));
    assert.strictEqual(r.decisions.length, 5);
    assert.strictEqual(r.decisions[0].id, 'd0');
  });

  it('derives the verdict from surviving decisions — empty array can\'t claim decisions-found', () => {
    const r = parseArchResponse(JSON.stringify({ verdict: 'decisions-found', summary: 's', decisions: [], skipped_checks: [] }));
    assert.strictEqual(r.verdict, 'no-decisions');
  });

  it('derives decisions-found even when the model mislabels the verdict', () => {
    const r = parseArchResponse(JSON.stringify({ verdict: 'no-decisions', summary: 's', decisions: [decision()], skipped_checks: [] }));
    assert.strictEqual(r.verdict, 'decisions-found');
  });

  it('filters decisions with no decision text', () => {
    const r = parseArchResponse(JSON.stringify({
      verdict: 'decisions-found',
      summary: 's',
      decisions: [decision({ decision: '   ' }), decision()],
      skipped_checks: [],
    }));
    assert.strictEqual(r.decisions.length, 1);
  });

  it('flags recovered=true when the JSON had to be salvaged', () => {
    const truncated = JSON.stringify({ verdict: 'decisions-found', summary: 's', decisions: [decision()] }).slice(0, -20);
    const r = parseArchResponse(truncated);
    assert.strictEqual(r.recovered, true);
  });

  it('throws on genuine garbage', () => {
    assert.throws(() => parseArchResponse('no json here at all'));
  });
});

describe('formatArchComment', () => {
  it('renders one summary comment with authority + reversibility badges', () => {
    const r = parseArchResponse(JSON.stringify({
      verdict: 'decisions-found',
      summary: 'One decision.',
      decisions: [decision({ reversibility: 'one-way' })],
      skipped_checks: ['system-fit checks — no system doc resolvable'],
    }));
    const md = formatArchComment(r);
    assert.ok(md.includes('lgtm arch'));
    assert.ok(md.includes('diff-evidence'));
    assert.ok(md.includes('one-way door'));
    assert.ok(md.includes('Ask the author'));
    assert.ok(md.includes('Skipped checks'));
  });
});
