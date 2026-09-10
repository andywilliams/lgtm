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

describe('repository map: what it refuses to guess', () => {
  it('names how many directories it left out, so absence is never evidence', async () => {
    // A repo with more directories than the census shows — the branch the caveat exists
    // for. Built for real, so a regression in the header or the caveat fails this test.
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'lgtm-map-big-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
      for (let i = 0; i < 50; i++) {
        mkdirSync(join(dir, `d${i}`));
        writeFileSync(join(dir, `d${i}`, 'f.ts'), 'export const a = 1;\n');
      }
      execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
      const { block } = buildRepoMap(dir, 100_000);
      assert.ok(block.includes('50 tracked files, 50 directories, 40 largest shown'), block.slice(0, 200));
      assert.ok(block.includes('10 smaller directories are not listed'), block.slice(0, 400));
      assert.ok(/absence of a file, or of a directory, is not evidence/.test(block));
      assert.equal((block.match(/^- /gm) ?? []).length, 40, 'the census itself is capped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says every directory is listed when none were dropped', () => {
    const { block } = buildRepoMap(process.cwd(), 100_000);
    const capped = block.includes('largest shown');
    assert.equal(capped, false, 'this repo has fewer than 40 directories');
    assert.ok(block.includes('every directory is listed'));
  });

  it('renders a string or array exports field without character indices', async () => {
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'lgtm-map-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', exports: './index.js' }));
      execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
      const { block } = buildRepoMap(dir);
      assert.ok(block.includes('exports: ./index.js'), block);
      assert.ok(!block.includes("exports: 0, 1, 2"), 'a string is not a set of character indices');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
