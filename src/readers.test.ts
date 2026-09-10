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
