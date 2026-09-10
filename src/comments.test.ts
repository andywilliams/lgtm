import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatReviewCommentBody, isDuplicateComment } from './comments.js';
import type { ReviewComment } from './types.js';

const finding = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  file: 'src/a.ts', line: 12, severity: 'BUG', title: 'Null deref in parseRow',
  body: 'The row can be null when the query misses.', ...over,
});

describe('posted-comment rendering and dedupe', () => {
  it('renders the triage fields a human needs before the prose', () => {
    const body = formatReviewCommentBody(finding({
      kind: 'removed', confidence: 'high', evidence: ['-  if (!row) return;'], how_to_verify: 'call with an id that misses',
      suggestion: 'if (!row) return;',
    }));
    assert.ok(body.startsWith('**Null deref in parseRow**'));
    assert.ok(body.includes('_removed_ · confidence: high'));
    assert.ok(body.includes('**Evidence:**\n> -  if (!row) return;'));
    assert.ok(body.includes('**How to check:** call with an id that misses'));
    assert.ok(body.includes('```suggestion'));
    // An ordinary added-code finding carries no kind tag — the common case stays clean.
    assert.ok(!formatReviewCommentBody(finding({ kind: 'added' })).includes('_added_'));
  });

  it('round-trips: a finding this build would post is recognised as already posted', () => {
    // The regression this pins: the fingerprint must survive our own rendering. It has
    // broken twice — once when the tag line was added between title and body, once when
    // the fingerprint spanned both.
    const shapes: Partial<ReviewComment>[] = [
      {},
      { kind: 'removed', confidence: 'high' },
      { kind: 'missing', confidence: 'low', evidence: ['x'], how_to_verify: 'run it' },
      { confidence: 'medium', suggestion: 'const a = 1;' },
      // The verifier's own paragraphs sit between title and body too — the exact shape
      // that broke this fingerprint the last two times a line was added there.
      { verdict: 'confirmed', verifier_note: 'the guard is absent on line 8', verifier_evidence: ['const row = rows[0];'] },
      { verdict: 'unproven', verifier_note: 'not visible in the shown windows' },
      { verdict: 'confirmed', original_severity: 'BUG', severity: 'SUGGESTION', verifier_note: 'at worst a naming problem' },
      { verdict: 'unverified' },
    ];
    for (const shape of shapes) {
      const c = finding(shape);
      const posted = [{ path: c.file, line: c.line, body: formatReviewCommentBody(c) }];
      assert.equal(isDuplicateComment(c, posted as any), true, `not recognised: ${JSON.stringify(shape)}`);
    }
    // And a comment rendered by an OLDER build (no tag line) is still matched.
    const c = finding({ kind: 'removed', confidence: 'high' });
    const old = [{ path: c.file, line: c.line, body: `**${c.title}**\n\n${c.body}` }];
    assert.equal(isDuplicateComment(c, old as any), true);
  });

  it('says what the verifier made of a finding, and only when it said something', () => {
    const confirmed = formatReviewCommentBody(finding({ verdict: 'confirmed', verifier_note: 'parseRow is called with the raw row on line 40' }));
    assert.ok(confirmed.includes('_Confirmed by a second review pass: parseRow is called with the raw row on line 40._'));

    // An unproven BUG survives BECAUSE it is a defect claim, and the reader has to know
    // that a second pass could not prove it before acting on it.
    const unproven = formatReviewCommentBody(finding({ verdict: 'unproven', verifier_note: 'not visible in the shown code' }));
    assert.ok(unproven.includes('could not prove this from the code it was shown'));

    const lowered = formatReviewCommentBody(finding({ verdict: 'confirmed', severity: 'SUGGESTION', original_severity: 'BUG', verifier_note: 'n' }));
    assert.ok(lowered.includes('_Severity lowered from BUG by that pass._'));

    // Nothing is claimed when nothing was checked, and a refuted finding is never posted
    // at all — so the renderer must not have a line that could imply one was.
    assert.ok(!formatReviewCommentBody(finding({ verdict: 'unverified' })).includes('second review pass'));
    assert.ok(!formatReviewCommentBody(finding()).includes('second review pass'));
    assert.ok(!formatReviewCommentBody(finding({ verdict: 'refuted', verifier_note: 'n' })).includes('second review pass'));
  });

  it('does not confuse a different finding, file or line', () => {
    const c = finding();
    const posted = [{ path: c.file, line: c.line, body: formatReviewCommentBody(c) }];
    assert.equal(isDuplicateComment(finding({ title: 'Something else entirely' }), posted as any), false);
    assert.equal(isDuplicateComment(finding({ file: 'src/b.ts' }), posted as any), false);
    assert.equal(isDuplicateComment(finding({ line: 99 }), posted as any), false);
  });
});
