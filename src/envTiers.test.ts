import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_SURFACE, DEBUG_HOOKS, renderEnvHelp } from './envTiers.js';

const SRC = new URL('.', import.meta.url).pathname;

/** Every source file under src/, at any depth and in any of the languages it is written in. */
const sourceFiles = (dir = SRC): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|js|mjs|cjs)$/.test(e.name) && !/\.test\.[a-z]+$/.test(e.name) ? [path] : [];
  });

/** Every LGTM_ variable the code READS. A name only written into a child's env (LGTM_BRAIN_REPO,
 *  LGTM_TICKET_REF) is an output of lgtm's, not an input to it, and is not on this surface. */
const read = () => {
  const names = new Set<string>();
  for (const f of sourceFiles()) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/process\.env\.(LGTM_[A-Z_]+)/g)) names.add(m[1]);
    for (const m of text.matchAll(/process\.env\[\s*['"`](LGTM_[A-Z_]+)['"`]/g)) names.add(m[1]);
  }
  return names;
};

describe("lgtm's environment surface", () => {
  it('puts every variable it reads in exactly one tier', () => {
    const controls = new Set(ENV_SURFACE.map((e) => e.name));
    const hooks = new Set(DEBUG_HOOKS);

    for (const name of read()) {
      const tiers = [controls.has(name) && 'operator control', hooks.has(name) && 'debugging hook'].filter(Boolean);
      assert.equal(tiers.length, 1,
        `${name} is in ${tiers.length === 0 ? 'no tier' : tiers.join(' AND ')} — add it to ENV_SURFACE ` +
        'if operators are meant to set it, or to DEBUG_HOOKS if it exists to inspect lgtm itself.');
    }
  });

  it('reads the environment where the scan can see it', () => {
    // `const { LGTM_X } = process.env` is invisible to a grep for the name, so the surface
    // could grow a variable in no tier while this file stayed green. Refusing the shape is
    // cheaper than parsing for it, and there is no reason to prefer it here.
    for (const f of sourceFiles()) {
      assert.ok(!/[{,]\s*LGTM_[A-Z_]*[\s\S]{0,120}?\}\s*=\s*process\.env/.test(readFileSync(f, 'utf8')),
        `${f} destructures process.env — read it as process.env.NAME so the tier guard can see the name.`);
    }
  });

  it('declares nothing the code has stopped reading', () => {
    const reads = read();
    for (const name of [...ENV_SURFACE.map((e) => e.name), ...DEBUG_HOOKS]) {
      assert.ok(reads.has(name), `${name} is declared but nothing reads it`);
    }
  });

  it('renders every operator control into --help, and no hook', () => {
    const help = renderEnvHelp('brain') + renderEnvHelp('call');
    for (const { name } of ENV_SURFACE) assert.match(help, new RegExp(`\\b${name}\\b`));
    for (const name of DEBUG_HOOKS) assert.doesNotMatch(help, new RegExp(`\\b${name}\\b`));
    // Every group's entries reach the display: a group typo would otherwise drop a whole
    // block from --help while both lists still agreed with each other.
    assert.equal(help.trimEnd().split('\n').length, ENV_SURFACE.length);
  });
});
