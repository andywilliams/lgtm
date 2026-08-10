import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCharter, resolveSystemDoc, buildArchitectureContext } from './charter.js';

// Guards the charter chain resolution: in-repo file discovery (with precedence),
// the `system:` frontmatter pointer, and the promise that a missing document is a
// '' block — never an error that could break a review.

const CHARTER = `---
title: my-repo — architecture charter
system: ../my-system
---

# my-repo — architecture charter

## Purpose & scope boundary
Detects things.
`;

let dir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['LGTM_SYSTEM_DIR', 'LGTM_BRAIN_CMD', 'LGTM_BRAIN_URL', 'LGTM_BRAIN_DIR'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lgtm-charter-test-'));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('findCharter', () => {
  it('returns null when the repo has no charter', () => {
    assert.strictEqual(findCharter(dir), null);
  });

  it('finds ARCHITECTURE.md at the repo root and parses frontmatter', () => {
    writeFileSync(join(dir, 'ARCHITECTURE.md'), CHARTER);
    const c = findCharter(dir);
    assert.ok(c);
    assert.strictEqual(c.title, 'my-repo — architecture charter');
    assert.strictEqual(c.systemRef, '../my-system');
    assert.ok(c.body.startsWith('# my-repo'));
    assert.ok(!c.body.includes('title:'));
  });

  it('prefers the root file over docs/ and .lgtm/', () => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'ARCHITECTURE.md'), '# docs charter\ncontent');
    writeFileSync(join(dir, 'ARCHITECTURE.md'), '# root charter\ncontent');
    const c = findCharter(dir);
    assert.ok(c?.body.startsWith('# root charter'));
  });

  it('falls back to docs/ARCHITECTURE.md', () => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'ARCHITECTURE.md'), '# docs charter\ncontent');
    const c = findCharter(dir);
    assert.ok(c?.body.startsWith('# docs charter'));
  });

  it('reads the system pointer with an inline comment', () => {
    writeFileSync(join(dir, 'ARCHITECTURE.md'), '---\nsystem: ../sys   # local checkout\n---\n# c\nbody');
    assert.strictEqual(findCharter(dir)?.systemRef, '../sys');
  });
});

describe('resolveSystemDoc', () => {
  it('resolves a relative ref to a directory containing SYSTEM.md', () => {
    const repo = join(dir, 'repo');
    const sys = join(dir, 'my-system');
    mkdirSync(repo);
    mkdirSync(sys);
    writeFileSync(join(sys, 'SYSTEM.md'), '# The System\nrepos and contracts');
    const doc = resolveSystemDoc(repo, '../my-system');
    assert.ok(doc);
    assert.ok(doc.content.includes('The System'));
  });

  it('resolves a ref that names the doc file directly', () => {
    writeFileSync(join(dir, 'SYSTEM.md'), '# Direct\ncontent');
    const doc = resolveSystemDoc(dir, 'SYSTEM.md');
    assert.ok(doc?.content.includes('Direct'));
  });

  it('falls back to LGTM_SYSTEM_DIR when the charter has no pointer', () => {
    const sys = join(dir, 'sys');
    mkdirSync(sys);
    writeFileSync(join(sys, 'SYSTEM.md'), '# EnvSystem\ncontent');
    process.env.LGTM_SYSTEM_DIR = sys;
    const doc = resolveSystemDoc(dir, undefined);
    assert.ok(doc?.content.includes('EnvSystem'));
  });

  it('skips remote refs (local-path resolution only)', () => {
    assert.strictEqual(resolveSystemDoc(dir, 'https://github.com/x/y'), null);
    assert.strictEqual(resolveSystemDoc(dir, 'git@github.com:x/y.git'), null);
  });

  it('returns null when nothing resolves', () => {
    assert.strictEqual(resolveSystemDoc(dir, '../does-not-exist'), null);
  });
});

describe('buildArchitectureContext', () => {
  it('assembles charter + system blocks from an in-repo charter', async () => {
    const repo = join(dir, 'repo');
    const sys = join(dir, 'my-system');
    mkdirSync(repo);
    mkdirSync(sys);
    writeFileSync(join(repo, 'ARCHITECTURE.md'), CHARTER);
    writeFileSync(join(sys, 'SYSTEM.md'), '# The System\nedges');
    const ctx = await buildArchitectureContext(repo, 'my-repo');
    assert.strictEqual(ctx.charterSource, 'repo');
    assert.ok(ctx.charterBlock.includes('Detects things'));
    assert.ok(ctx.systemBlock.includes('edges'));
    assert.ok(ctx.charterPath?.endsWith('ARCHITECTURE.md'));
    assert.ok(ctx.systemPath?.endsWith('SYSTEM.md'));
  });

  it('yields empty blocks (not errors) when nothing exists', async () => {
    const ctx = await buildArchitectureContext(dir, 'nope');
    assert.strictEqual(ctx.charterBlock, '');
    assert.strictEqual(ctx.systemBlock, '');
    assert.strictEqual(ctx.charterSource, undefined);
  });

  it('survives a null repo root', async () => {
    const ctx = await buildArchitectureContext(null, undefined);
    assert.strictEqual(ctx.charterBlock, '');
  });
});
