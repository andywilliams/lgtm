import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepoMap, directoryCensus } from './repoMap.js';

describe('repository map', () => {
  it('counts two directory levels, biggest first', () => {
    const census = directoryCensus([
      'src/handlers/a.js', 'src/handlers/b.js', 'src/handlers/c.js',
      'src/services/x.js', 'src/services/y.js',
      'README.md', 'package.json',
      'test/unit/one.test.js',
    ]);
    // Ties break alphabetically, so the order is stable from run to run.
    assert.deepEqual(census, [
      { dir: 'src/handlers', count: 3 },
      { dir: '(root)', count: 2 },
      { dir: 'src/services', count: 2 },
      { dir: 'test/unit', count: 1 },
    ]);
    // The census is what makes "11 files live under src/handlers/, this one does not"
    // a countable claim rather than an impression.
    assert.equal(census[0].count, 3);
  });

  it('maps this repo, names its entry points, and stays small', () => {
    const { block, truncated } = buildRepoMap(process.cwd());
    assert.ok(block.includes('## Repository map'));
    assert.ok(/- src\/ — |- src — |- \(root\)\/ — /.test(block), block.slice(0, 300));
    assert.ok(block.includes('bin: '), 'the CLI entry point is part of what placement is judged against');
    assert.equal(truncated, false);
    // A map is context, not a document: an arch review already carries a charter,
    // a system doc and full file contents.
    assert.ok(block.length < 8000, `map is ${block.length} bytes`);
  });

  it('says nothing rather than guessing when the directory is not a checkout', () => {
    const { block } = buildRepoMap('/definitely/not/a/repo');
    assert.equal(block, '', 'an empty map is reported as a skipped check, not passed off as a small repo');
  });

  it('truncates loudly', () => {
    const { block, truncated } = buildRepoMap(process.cwd(), 200);
    assert.equal(truncated, true);
    assert.ok(block.endsWith('… (map truncated)\n'));
  });
});
