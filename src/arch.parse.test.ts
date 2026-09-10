import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseArchResponse, formatArchComment, enforceSkippedChecks } from './arch.js';

// Guards the normalization that keeps the authority ladder honest. Two different
// rules, on purpose: unknown CLAIM-STRENGTH values (authority/confidence) collapse
// to the weakest claim (judgement/low) so the tool never overclaims; RISK values
// (reversibility) fuzzy-match toward their stated risk — midpoint when unrecognized
// — so a near-miss can't silently read as lowest-risk. And the verdict must reflect
// what actually survived — "decisions-found" with an empty array must not mislead.

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

  it('collapses unknown claim-strength values to the weakest claim, never a stronger one', () => {
    const r = parseArchResponse(JSON.stringify({
      verdict: 'decisions-found',
      summary: 's',
      decisions: [decision({ authority: 'organisational-standard', confidence: 'certain' })],
      skipped_checks: [],
    }));
    assert.strictEqual(r.decisions[0].authority, 'judgement');
    assert.strictEqual(r.decisions[0].confidence, 'low');
  });

  it('reversibility near-misses keep their risk instead of collapsing to lowest', () => {
    const cases: [string, string][] = [
      ['one-way door', 'one-way'],
      ['irreversible!!', 'one-way'],
      ['cheap now, costly later', 'costly'],
      ['costly to reverse', 'costly'],
      ['cheap', 'cheap'],
      ['no idea', 'costly'],
    ];
    for (const [input, expected] of cases) {
      const r = parseArchResponse(JSON.stringify({
        verdict: 'decisions-found', summary: 's',
        decisions: [decision({ reversibility: input })], skipped_checks: [],
      }));
      assert.strictEqual(r.decisions[0].reversibility, expected, `"${input}" → ${expected}`);
    }
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

describe('enforceSkippedChecks', () => {
  it('adds canonical entries from ground truth when the model omits them', () => {
    const r = parseArchResponse(JSON.stringify({ verdict: 'no-decisions', summary: 's', decisions: [], skipped_checks: [] }));
    enforceSkippedChecks(r, { charter: false, system: false, map: true });
    assert.strictEqual(r.skipped_checks.length, 2);
    assert.ok(r.skipped_checks[0].includes('charter-grounded'));
    assert.ok(r.skipped_checks[1].includes('system-fit'));
  });

  it('drops model paraphrases of the canonical entries and keeps its other entries', () => {
    const r = parseArchResponse(JSON.stringify({
      verdict: 'no-decisions',
      summary: 's',
      decisions: [],
      skipped_checks: ['Charter-grounded checks were not possible here', 'org-fit — no org context configured'],
    }));
    enforceSkippedChecks(r, { charter: false, system: true, map: true });
    assert.deepStrictEqual(r.skipped_checks.filter((s) => s.includes('org-fit')).length, 1);
    assert.strictEqual(r.skipped_checks.filter((s) => /charter/i.test(s)).length, 1);
    assert.ok(!r.skipped_checks.some((s) => /system-fit/.test(s)));
  });

  it('reports nothing skipped when both contexts were provided', () => {
    const r = parseArchResponse(JSON.stringify({
      verdict: 'no-decisions',
      summary: 's',
      decisions: [],
      skipped_checks: ['system-fit checks — no system doc resolvable'],
    }));
    enforceSkippedChecks(r, { charter: true, system: true, map: true });
    assert.deepStrictEqual(r.skipped_checks, []);
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

describe('skipped checks are ground truth', () => {
  it('reports a missing repository map, and never lets the model claim one it did not get', () => {
    const result = {
      verdict: 'no-decisions' as const, summary: '', decisions: [],
      skipped_checks: ['charter-grounded checks — no charter resolvable', 'something the model noticed'],
    };
    const withMap = enforceSkippedChecks({ ...result, skipped_checks: [...result.skipped_checks] }, { charter: true, system: true, map: true });
    assert.ok(!withMap.skipped_checks.some((s) => /repository map/.test(s)));
    assert.ok(withMap.skipped_checks.includes('something the model noticed'), 'the model keeps its own entries');

    const withoutMap = enforceSkippedChecks({ ...result, skipped_checks: [...result.skipped_checks] }, { charter: true, system: true, map: false });
    assert.ok(withoutMap.skipped_checks.some((s) => /repository map/.test(s)));

    // A model that claims the map was skipped when it was given one is overruled.
    const lying = enforceSkippedChecks({ ...result, skipped_checks: ['placement and codebase-pattern counts — no repository map'] }, { charter: true, system: true, map: true });
    assert.deepEqual(lying.skipped_checks, []);

    // A truncated map is its own state: the reviewer is told absence proves nothing.
    const cut = enforceSkippedChecks({ ...result, skipped_checks: [] }, { charter: true, system: true, map: 'truncated' });
    assert.ok(cut.skipped_checks.some((s) => /TRUNCATED/.test(s)));
  });

  it('names an unreadable ticket, says nothing when none was referenced, and overrules a paraphrase', () => {
    const base = { verdict: 'no-decisions' as const, summary: '', decisions: [], skipped_checks: [] as string[] };
    const ctx = { charter: true, system: true, map: true as const };

    // No ticket REFERENCED is not a skipped check: most repos do not use the board, and a
    // permanent line in all of their output would be noise, not honesty.
    assert.deepEqual(enforceSkippedChecks({ ...base }, { ...ctx, ticket: false }).skipped_checks, []);
    assert.deepEqual(enforceSkippedChecks({ ...base }, { ...ctx, ticket: true }).skipped_checks, []);

    // A ticket that WAS named and could not be read is recorded, with the reason.
    const unreadable = enforceSkippedChecks({ ...base }, { ...ctx, ticket: { configured: true, reason: 'the board answered 500' } });
    assert.ok(unreadable.skipped_checks.some((s) => /ticket could not be read \(the board answered 500\)/.test(s)));

    // An unconfigured board is its own shape, and the string DWLF-210 quotes verbatim. The
    // kind is passed through rather than sniffed out of the reason, so rewording the
    // human-readable message cannot silently change what the honesty record claims.
    const unconfigured = enforceSkippedChecks({ ...base }, { ...ctx, ticket: { configured: false, reason: 'anything at all' } });
    assert.deepEqual(unconfigured.skipped_checks, ['ticket check — no board access']);

    // And the model's OWN phrasing is overruled when the ticket was in fact provided —
    // matched on a fragment, like the other three, or a paraphrase survives and claims a
    // check was skipped that was not.
    const paraphrase = enforceSkippedChecks({ ...base, skipped_checks: ['ticket completeness — no board access'] }, { ...ctx, ticket: true });
    assert.deepEqual(paraphrase.skipped_checks, []);
  });
});
