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

    // Only the object spread is treated as the emitted payload's builder.
    const helpers = fieldsFromHelpers(diff, '/nonexistent-root');
    assert.deepEqual(helpers, [], 'no repo to resolve helpers in — and no crash');
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
