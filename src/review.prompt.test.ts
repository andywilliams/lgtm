import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, VOLATILE_MARKER } from './review.js';

const base = {
  diff: '+const a = 1;',
  prTitle: 'feat: thing',
  prBody: 'does a thing',
  harshness: 'medium' as const,
  fileContents: { 'src/a.ts': 'const a = 1;' },
  usageContext: '## Usage\nused in b.ts',
  expandedContext: '## Expanded Context (Auto-discovered)\n### src/b.ts',
  handbookContext: '## Handbook\nslash-form symbols',
  extra: { scope: 'add the thing', charter: '## Architecture Charter\ninvariant 1', standards: '## Standards\nG5', decided: [{ title: 'Rename', reason: 'domain term' }] },
};

test('everything stable across a loop precedes the first volatile byte; everything per-round follows it', () => {
  const p = buildReviewPrompt(base);
  const cut = p.indexOf(VOLATILE_MARKER);
  assert.ok(cut > 0);
  const stable = p.slice(0, cut);
  const volatile = p.slice(cut);
  for (const s of ['You are a senior code reviewer', 'slash-form symbols', 'invariant 1', '## Standards', 'src/b.ts', 'const a = 1;', 'used in b.ts']) {
    assert.ok(stable.includes(s), `stable prefix carries: ${s}`);
    assert.ok(!volatile.includes(s) || s === 'const a = 1;', `volatile tail does not repeat: ${s}`);
  }
  for (const v of ['feat: thing', '+const a = 1;', 'harshness: medium', 'add the thing', 'dismissed because: domain term', 'OUTPUT FORMAT']) {
    assert.ok(volatile.includes(v), `volatile tail carries: ${v}`);
    assert.ok(!stable.includes(v), `stable prefix free of: ${v}`);
  }
});

test('changing harshness, scope, dismissals or the diff leaves the stable prefix byte-identical', () => {
  const p1 = buildReviewPrompt(base);
  const cut = p1.indexOf(VOLATILE_MARKER);
  const prefix = p1.slice(0, cut);
  const variants = [
    { ...base, harshness: 'chill' as const },
    { ...base, extra: { ...base.extra, scope: 'something else' } },
    { ...base, extra: { ...base.extra, decided: [] } },
    { ...base, diff: '+const a = 2;\n+const c = 3;', prTitle: 'fix: other' },
  ];
  for (const v of variants) {
    const p = buildReviewPrompt(v);
    assert.equal(p.slice(0, cut), prefix);
  }
});

test('the output contract is last', () => {
  const p = buildReviewPrompt(base);
  assert.ok(p.trimEnd().endsWith('{"summary": "LGTM — no issues found", "comments": []}'));
});

test('changed files render in path order regardless of insertion order', () => {
  const a = buildReviewPrompt({ ...base, fileContents: { 'src/z.ts': 'z', 'src/a.ts': 'a' } });
  const b = buildReviewPrompt({ ...base, fileContents: { 'src/a.ts': 'a', 'src/z.ts': 'z' } });
  assert.equal(a, b);
  assert.ok(a.indexOf('### src/a.ts') < a.indexOf('### src/z.ts'));
});
