import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractWriteIdentifiers, formatReadersContext } from './readers.js';

describe('readers of what a diff writes', () => {
  it('pulls the identifiers a change writes out of its ADDED lines only', () => {
    const diff = [
      'diff --git a/src/cycles.js b/src/cycles.js',
      '--- a/src/cycles.js',
      '+++ b/src/cycles.js',
      "+  const EVENT = 'cycle.low.break';",
      "+  payload.pivotTime = next.time;",
      '+  export function detectBreak(bars) {',
      "+  await put({ TableName: 'CycleStateTable', Item: item });",
      "-  const GONE = 'cycle.old.removed';",
      "   const CONTEXT = 'cycle.unchanged.context';",
    ].join('\n');
    const ids = extractWriteIdentifiers(diff).map((i) => i.id);
    assert.ok(ids.includes('cycle.low.break'), 'event type literal');
    assert.ok(ids.includes('pivotTime'), 'field written onto a persisted object');
    assert.ok(ids.includes('detectBreak'), 'exported symbol');
    assert.ok(ids.includes('CycleStateTable'), 'table name');
    assert.ok(!ids.includes('cycle.old.removed'), 'a REMOVED line is not something the diff writes');
    assert.ok(!ids.includes('cycle.unchanged.context'), 'nor a context line');
  });

  it('says plainly when a reader is in another repository', () => {
    const out = formatReadersContext([
      { identifier: 'cycle.low.break', why: 'event type emitted here', root: '/repos/jobs',
        file: '/repos/jobs/src/indicatorEventsService.js', lines: [{ line: 2090, text: 'payload.pivotTime' }] },
      { identifier: 'cycle.low.break', why: 'event type emitted here', root: '/repos/lib',
        file: '/repos/lib/src/other.ts', lines: [{ line: 4, text: "case 'cycle.low.break':" }] },
    ], '/repos/lib');
    assert.ok(out.includes('/repos/jobs/src/indicatorEventsService.js (ANOTHER REPOSITORY)'));
    assert.ok(out.includes('src/other.ts'));
    assert.ok(!out.includes('/repos/lib/src/other.ts (ANOTHER'), 'a file in this repo is not marked foreign');
    assert.ok(out.includes('2090: payload.pivotTime'));
    assert.ok(out.includes('CANNOT have been updated by this diff'));
  });

  it('is empty when nothing reads what the diff writes', () => {
    assert.equal(formatReadersContext([], '/repos/lib'), '');
  });
});

describe('readers: what counts as a write', () => {
  it('ignores comments, test files and non-object spreads', async () => {
    const { addedProductionLines, fieldsFromHelpers } = await import('./readers.js');
    const diff = [
      '+++ b/src/a.ts',
      "+  const E = 'a.b.c';",
      "+  // emits 'comment.only.event' — prose, not a write",
      '+  const xs = [...buildList(1)];',
      '+  const p = { ...createPayload(next) };',
      '+++ b/src/a.test.ts',
      "+  const T = 'test.only.event';",
    ].join('\n');
    const lines = addedProductionLines(diff);
    assert.ok(lines.some((l) => l.includes("'a.b.c'")));
    assert.ok(!lines.some((l) => l.includes('comment.only.event')), 'a comment is not a write');
    assert.ok(!lines.some((l) => l.includes('test.only.event')), 'a test file is not a write');

    const ids = extractWriteIdentifiers(diff).map((i) => i.id);
    assert.ok(ids.includes('a.b.c'));
    assert.ok(!ids.includes('comment.only.event'));
    assert.ok(!ids.includes('test.only.event'));

    assert.deepEqual(fieldsFromHelpers(diff, '/nonexistent-root'), [], 'no repo to resolve helpers in — and no crash');
  });

  it('dedupes and caps the combined identifier list', async () => {
    const { mergeIdentifiers } = await import('./readers.js');
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, why: 'helper field' }));
    const merged = mergeIdentifiers([{ id: 'f1', why: 'event type' }], many);
    assert.equal(merged[0].why, 'event type', 'the first list wins a duplicate');
    assert.ok(merged.length <= 14, `capped, was ${merged.length}`);
    assert.equal(new Set(merged.map((m) => m.id)).size, merged.length, 'no duplicates');
  });
});

describe('readers: following the payload helper', () => {
  it('follows the payload helper an object spread names, and not an unrelated call', async () => {
    const { fieldsFromHelpers } = await import('./readers.js');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'lgtm-readers-'));
    try {
      writeFileSync(join(dir, 'helpers.ts'), [
        'export function createPayload(s) {',
        '  return { pivotTime: s.t, pivotIndex: s.i, price: s.p };',
        '}',
        'export function unrelatedThing(n) {',
        '  return { neverEmitted: n };',
        '}',
      ].join('\n'));
      const diff = [
        '+++ b/src/emit.ts',
        '+  const x = unrelatedThing(1);',
        '+  emit({',
        '+    ...createPayload(next),',
        '+    cycleBreak: breakPayload,',
        '+  });',
      ].join('\n');
      const fields = fieldsFromHelpers(diff, dir).map((f) => f.id);
      // The spread names the emitted payload: its fields ARE things this change writes,
      // read out of the helper's own body (single-line literal included).
      assert.ok(fields.includes('pivotTime'), `object spread followed: ${fields.join(',') || '(none)'}`);
      assert.ok(fields.includes('price'));
      // A call that is neither spread into the payload nor named like a builder
      // (create*/build*/make*/to* — a deliberate second net) is not followed.
      assert.ok(!fields.includes('neverEmitted'), 'an unrelated call is not the payload');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a search root that does not exist instead of finding nothing', async () => {
    const { searchRoots } = await import('./readers.js');
    const { roots, missing } = searchRoots(process.cwd(), ['/definitely/not/here']);
    assert.deepEqual(missing, ['/definitely/not/here']);
    assert.ok(roots.includes(process.cwd()));
  });
});
