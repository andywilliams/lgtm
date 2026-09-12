import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_SURFACE, DEBUG_HOOKS, GROUP_HEADINGS, renderEnvSurface, type EnvGroup } from './envTiers.js';

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
    // Two shapes hide a name from a grep for it — destructuring it out, and aliasing the
    // object first — and a variable read either way would be in no tier with every test
    // here still green. Refusing both is cheaper than parsing for them, and nothing needs
    // either. (A spread, `{ ...process.env, X: y }`, passes the environment ON and is not a
    // read of any name; brain.ts does exactly that.)
    const hidden: [RegExp, string][] = [
      [/[{,]\s*LGTM_[A-Z_]*[\s\S]{0,120}?\}\s*=\s*process\.env/, 'destructures process.env'],
      [/(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*process\.env\s*(?![.[?])/, 'aliases process.env'],
    ];
    for (const f of sourceFiles()) {
      const text = readFileSync(f, 'utf8');
      for (const [shape, what] of hidden) {
        assert.ok(!shape.test(text), `${f} ${what} — read it as process.env.NAME so the tier guard can see the name.`);
      }
    }
  });

  it('declares nothing the code has stopped reading', () => {
    const reads = read();
    for (const name of [...ENV_SURFACE.map((e) => e.name), ...DEBUG_HOOKS]) {
      assert.ok(reads.has(name), `${name} is declared but nothing reads it`);
    }
  });

  it('renders every operator control into --help, and no hook', () => {
    const help = renderEnvSurface();
    for (const { name } of ENV_SURFACE) assert.match(help, new RegExp(`\\b${name}\\b`));
    for (const name of DEBUG_HOOKS) assert.doesNotMatch(help, new RegExp(`\\b${name}\\b`));
    // Every declared group reaches the display, and every entry lands under a heading: a
    // group typo would otherwise drop a whole block from --help while both lists still
    // agreed with each other.
    for (const heading of Object.values(GROUP_HEADINGS)) assert.ok(help.includes(heading), heading.trim().split('\n')[0]);
    const groups = new Set(ENV_SURFACE.map((e) => e.group));
    for (const g of groups) assert.ok(g in GROUP_HEADINGS, `group '${g}' has no heading`);
    assert.equal(help.split('\n').filter((l) => /^ {2}LGTM_/.test(l)).length, ENV_SURFACE.length);
  });

  it('documents every operator control in the README as well', () => {
    // `--help` and the charter are updated by the declaration; the README table is a third,
    // hand-kept surface, and the one this policy would otherwise let drift silently.
    const readme = readFileSync(join(SRC, '..', 'README.md'), 'utf8');
    for (const { name } of ENV_SURFACE) assert.match(readme, new RegExp(`\\b${name}\\b`), `${name} is in no README section`);
  });
});
