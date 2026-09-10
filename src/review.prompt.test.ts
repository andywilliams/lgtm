import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, buildStablePrefix, buildVolatileTail } from './review.js';

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
  const stable = buildStablePrefix(base);
  const volatile = buildVolatileTail(base);
  assert.equal(buildReviewPrompt(base), stable + volatile);
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
  const prefix = buildStablePrefix(base);
  const variants = [
    { ...base, harshness: 'chill' as const },
    { ...base, extra: { ...base.extra, scope: 'something else' } },
    { ...base, extra: { ...base.extra, decided: [] } },
    { ...base, diff: '+const a = 2;\n+const c = 3;', prTitle: 'fix: other' },
  ];
  for (const v of variants) assert.equal(buildStablePrefix(v), prefix);
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

test('a resumed round sends only what moved, then the same volatile tail', async () => {
  const { buildResumePrompt } = await import('./review.js');
  const p = buildResumePrompt({ ...base, round: 3, changedSinceLast: { 'src/z.ts': 'new z' }, unchangedFiles: ['src/a.ts'] });
  assert.ok(p.startsWith('# Review round 3 of "feat: thing"'));
  assert.ok(p.includes('### src/z.ts\n```\nnew z'));
  assert.ok(!p.includes('invariant 1'), 'repo context is not re-sent');
  assert.ok(!p.includes('### src/a.ts'), 'unchanged file contents are not re-sent');
  assert.ok(p.includes('Unchanged since the last round (contents already in context): src/a.ts'));
  assert.ok(p.indexOf('## Files changed since the last round') < p.indexOf('## PR Title'));
  for (const v of ['+const a = 1;', 'harshness: medium', 'add the thing', 'dismissed because: domain term', 'OUTPUT FORMAT']) assert.ok(p.includes(v), v);
});

test('a resumed round renders updated repo context as context, not as a file', async () => {
  const { buildResumePrompt } = await import('./review.js');
  const p = buildResumePrompt({ ...base, round: 4, changedSinceLast: { '@charter': '## Architecture Charter\ninvariant 2', 'src/z.ts': 'z' }, unchangedFiles: ['@standards', 'src/a.ts'] });
  assert.ok(p.includes('## Repo context updated since the last round'));
  assert.ok(p.includes('invariant 2'));
  assert.ok(!p.includes('### @charter'));
  assert.ok(!p.includes('@standards'), 'pseudo-paths are not listed as unchanged files');
});

test('a reviewed file that contains the prompt\'s own headings does not leak into the resumed round', async () => {
  const { buildResumePrompt } = await import('./review.js');
  const trap = { 'src/review.ts': 'const t = `\n## PR Title\n${x}\n## Diff\n`; // template' };
  const full = { ...base, fileContents: trap };
  const p = buildResumePrompt({ ...full, round: 2, changedSinceLast: {}, unchangedFiles: ['src/review.ts'] });
  assert.ok(!p.includes('// template'), 'the unchanged file is not re-sent even though it contains the headings');
  // The ceiling is the volatile tail's size (prompt v2's output contract is ~1k of it),
  // not a round number: what this pins is that the FILE CONTENTS are not re-sent.
  assert.ok(p.length < 6000, `resumed prompt should be small, was ${p.length}`);
});
