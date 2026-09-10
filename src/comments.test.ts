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

  it('does not confuse a different finding, file or line', () => {
    const c = finding();
    const posted = [{ path: c.file, line: c.line, body: formatReviewCommentBody(c) }];
    assert.equal(isDuplicateComment(finding({ title: 'Something else entirely' }), posted as any), false);
    assert.equal(isDuplicateComment(finding({ file: 'src/b.ts' }), posted as any), false);
    assert.equal(isDuplicateComment(finding({ line: 99 }), posted as any), false);
  });
});
