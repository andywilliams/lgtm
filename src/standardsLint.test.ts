import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { deriveRules, generateEslintFragment, usesEsm, parseEslintJson, partitionStructural, STRUCTURAL_RULES, hasEslintConfig, jsLiteral } from './standardsLint.js';
import { buildWholeFileDiff, collectTargets, lintAsDecided, findCoveringTests, runEslint, repoRootOf } from './standardsReview.js';
import { DEFAULT_THRESHOLDS, type StandardsSelections } from './standards.js';
import { checkFragmentLints, ignoreRemedy, firstUsefulLine } from './standardsInterview.js';
import { askEntries } from './standardsCatalog.js';

// Guards the deterministic half: that the emitted rules actually track the
// STANDARDS.md selections (the whole point — one source, two mechanisms, no
// drift), that the fragment matches the repo's module system, and that the
// synthetic whole-file diff keeps line numbers aligned with the real file.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lgtm-lint-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function selections(overrides: Partial<StandardsSelections> = {}): StandardsSelections {
  const askChoices: Record<string, string> = {};
  for (const e of askEntries()) askChoices[e.id] = e.ask!.options[0].value;
  return { askChoices, thresholds: DEFAULT_THRESHOLDS, houseRules: [], ...overrides };
}

describe('deriveRules — the doc drives the config', () => {
  it('uses the chosen thresholds, not the defaults', () => {
    const s = selections({ thresholds: { fnWarn: 60, fnMax: 90, fileWarn: 500, fileMax: 900 } });
    const rules = deriveRules(s);
    const fn = rules.find((r) => r.name === 'max-lines-per-function')!;
    assert.strictEqual((fn.value as any[])[1].max, 90);
    const file = rules.find((r) => r.name === 'max-lines')!;
    assert.strictEqual((file.value as any[])[1].max, 900);
  });

  it('FUN-1 "strict" tightens both length and complexity', () => {
    const s = selections();
    s.askChoices['FUN-1'] = 'strict';
    const rules = deriveRules(s);
    assert.strictEqual(((rules.find((r) => r.name === 'max-lines-per-function')!).value as any[])[1].max, 20);
    assert.strictEqual(((rules.find((r) => r.name === 'complexity')!).value as any[])[1], 10);
  });

  it('FUN-1 "off" emits no length or complexity rule at all', () => {
    const s = selections();
    s.askChoices['FUN-1'] = 'off';
    const names = deriveRules(s).map((r) => r.name);
    assert.ok(!names.includes('max-lines-per-function'));
    assert.ok(!names.includes('complexity'));
    assert.ok(names.includes('max-depth')); // unrelated rules survive
  });

  it('FMT-2 "off" emits no file-length rule', () => {
    const s = selections();
    s.askChoices['FMT-2'] = 'off';
    assert.ok(!deriveRules(s).map((r) => r.name).includes('max-lines'));
  });

  it('applies the requested severity to every rule', () => {
    for (const r of deriveRules(selections(), 'error')) {
      const sev = Array.isArray(r.value) ? r.value[0] : r.value;
      assert.strictEqual(sev, 'error', `${r.name} did not take the severity`);
    }
  });

  it('every rule names the standard it came from', () => {
    for (const r of deriveRules(selections())) assert.ok(r.from.trim(), `${r.name} has no provenance`);
  });
});

describe('generateEslintFragment', () => {
  it('emits CommonJS by default and ESM when the manifest says so', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    assert.strictEqual(usesEsm(dir), false);
    const cjs = generateEslintFragment({ repoName: 'x', profile: 'service', selections: selections(), esm: false });
    assert.match(cjs, /module\.exports = \{ standardsRules \}/);
    assert.doesNotMatch(cjs, /export default/);

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));
    assert.strictEqual(usesEsm(dir), true);
    const esm = generateEslintFragment({ repoName: 'x', profile: 'service', selections: selections(), esm: true });
    assert.match(esm, /export default standardsRules/);
    assert.match(esm, /export const standardsRules =/);
  });

  it('is not fooled by an unrelated "type" field elsewhere in the manifest', () => {
    // A repository block carries `"type": "git"` — grepping for "type" would misread it.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', repository: { type: 'git', url: 'u' } }));
    assert.strictEqual(usesEsm(dir), false);
  });

  it('treats a missing or unreadable manifest as CommonJS', () => {
    assert.strictEqual(usesEsm(dir), false);
    writeFileSync(join(dir, 'package.json'), '{ not json');
    assert.strictEqual(usesEsm(dir), false);
  });

  it('carries the new-code CI hint and marks itself generated', () => {
    const out = generateEslintFragment({ repoName: 'x', profile: 'service', selections: selections(), esm: false, date: '2026-08-12' });
    assert.match(out, /GENERATED by `lgtm standards init` on 2026-08-12/);
    assert.match(out, /git diff --name-only/);
    assert.match(out, /do not edit by hand/);
  });

  it('lists plugin-dependent rules as comments only, never active', () => {
    const out = generateEslintFragment({ repoName: 'x', profile: 'service', selections: selections(), esm: false });
    const active = out.slice(out.indexOf('standardsRules = {'), out.indexOf('};'));
    assert.doesNotMatch(active, /sonarjs|typescript-eslint|jest\//);
    assert.match(out, /sonarjs\/cognitive-complexity/); // present, but in the commented block
  });
});

describe('jsLiteral — sound serialisation, not regex-munged JSON', () => {
  it('preserves commas and quotes inside string values', () => {
    assert.strictEqual(jsLiteral({ argsIgnorePattern: '^(_|a,b)$' }), "{ argsIgnorePattern: '^(_|a,b)$' }");
    assert.strictEqual(jsLiteral("it's"), "'it\\'s'");
    assert.strictEqual(jsLiteral({ 'kebab-key': 1 }), "{ 'kebab-key': 1 }");
  });

  it('round-trips through a real JS parser', () => {
    const value = ['warn', { max: 90, pattern: '^(a,b)$', nested: [1, true, null] }];
    // eslint-disable-next-line no-eval
    assert.deepStrictEqual(eval(`(${jsLiteral(value)})`), value);
  });
});

describe('lint findings feed the gate and the suppression channel', () => {
  it('parses eslint json, skipping rule-less parse errors', () => {
    const raw = JSON.stringify([
      { filePath: '/r/a.js', messages: [
        { ruleId: 'max-params', line: 10, message: 'too many', severity: 1 },
        { ruleId: null, line: 1, message: 'Parsing error', severity: 2 },
      ] },
    ]);
    const findings = parseEslintJson(raw);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].rule, 'max-params');
    assert.strictEqual(findings[0].severity, 'warning');
  });

  it('returns [] on unparseable output rather than throwing', () => {
    assert.deepStrictEqual(parseEslintJson('not json'), []);
  });

  it('partitions shape-changing rules from the rest', () => {
    const f = (rule: string): any => ({ file: '/r/a.js', line: 1, rule, message: '', severity: 'warning' });
    const { structural, other } = partitionStructural([f('max-params'), f('no-unused-vars'), f('complexity'), f('no-negated-condition')]);
    assert.deepStrictEqual(structural.map((s) => s.rule).sort(), ['complexity', 'max-params']);
    assert.deepStrictEqual(other.map((s) => s.rule).sort(), ['no-negated-condition', 'no-unused-vars']);
    for (const r of structural) assert.ok(STRUCTURAL_RULES.has(r.rule));
  });

  it('converts lint findings into repo-relative already-reported entries', () => {
    const decided = lintAsDecided('/r', [{ file: '/r/src/a.js', line: 7, rule: 'no-unused-vars', message: "'x' is unused", severity: 'error' }]);
    assert.strictEqual(decided.length, 1);
    assert.match(decided[0].title, /no-unused-vars/);
    assert.match(decided[0].reason, /ESLint/);
    assert.strictEqual(decided[0].line, 7);
    // Must match the synthetic diff's repo-relative headers, or the model can't connect them.
    assert.strictEqual(decided[0].file, 'src/a.js');
  });

  it('detects flat, TypeScript-flat and legacy eslint configs', () => {
    assert.strictEqual(hasEslintConfig(dir), false);
    writeFileSync(join(dir, 'eslint.config.js'), 'module.exports = [];');
    assert.strictEqual(hasEslintConfig(dir), true);
    rmSync(join(dir, 'eslint.config.js'));
    writeFileSync(join(dir, 'eslint.config.ts'), 'export default [];');
    assert.strictEqual(hasEslintConfig(dir), true);
  });

  it("reports no-config rather than a clean run when there is no eslint config", () => {
    const run = runEslint(dir, [join(dir, 'a.js')]);
    assert.strictEqual(run.ok, false);
    if (!run.ok) assert.strictEqual(run.status, 'no-eslint-config');
  });
});

describe('repoRootOf', () => {
  it('throws rather than silently falling back to cwd outside a repo', () => {
    // A cwd fallback would apply the CURRENT repo's STANDARDS.md to foreign code.
    assert.throws(() => repoRootOf(dir), /not inside a git repository/);
  });
});

describe('buildWholeFileDiff', () => {
  it('renders every line as an addition with line numbers matching the file', () => {
    const diff = buildWholeFileDiff(dir, join(dir, 'src', 'a.js'), 'const a = 1;\nconst b = 2;\n');
    assert.match(diff, /^diff --git a\/src\/a\.js b\/src\/a\.js$/m);
    assert.match(diff, /^@@ -0,0 \+1,2 @@$/m);
    assert.match(diff, /^\+const a = 1;$/m);
    assert.match(diff, /^\+const b = 2;$/m);
    // The trailing newline must not become a phantom third line.
    assert.strictEqual(diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length, 2);
  });

  it('handles a file with no trailing newline', () => {
    const diff = buildWholeFileDiff(dir, join(dir, 'a.js'), 'only');
    assert.match(diff, /@@ -0,0 \+1,1 @@/);
  });
});

describe('findCoveringTests — regex-metachar stems', () => {
  it('does not throw on a stem containing regex metacharacters', () => {
    // Same class as the git-grep -F fix: a stem is a filename, not a pattern.
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (const name of ['a+b.js', 'x[1].js', 'foo.bar.js']) {
      const f = join(dir, 'src', name);
      writeFileSync(f, 'x');
      assert.doesNotThrow(() => findCoveringTests(dir, f), `threw on stem from ${name}`);
    }
  });
});

describe('collectTargets', () => {
  it('returns a single file unchanged', () => {
    const f = join(dir, 'a.js');
    writeFileSync(f, 'x');
    assert.deepStrictEqual(collectTargets(f, 5), [f]);
  });

  it('walks a directory, skipping tests, node_modules and non-source files', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'x');
    writeFileSync(join(dir, 'src', 'b.test.ts'), 'x');
    writeFileSync(join(dir, 'src', 'readme.md'), 'x');
    writeFileSync(join(dir, 'node_modules', 'pkg', 'c.js'), 'x');
    const found = collectTargets(join(dir, 'src'), 10).map((p) => p.split('/').pop());
    assert.deepStrictEqual(found, ['a.ts']);
  });

  it('honours the file cap and errors on a missing path', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (const n of ['a', 'b', 'c']) writeFileSync(join(dir, 'src', `${n}.js`), 'x');
    assert.strictEqual(collectTargets(join(dir, 'src'), 2).length, 2);
    assert.throws(() => collectTargets(join(dir, 'nope'), 5), /No such file or directory/);
  });
});

describe('checkFragmentLints — does the file we just wrote break their build?', () => {
  const repos: string[] = [];
  const scratch = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'lgtm-fraglint-'));
    repos.push(dir);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    return dir;
  };
  after(() => { for (const d of repos) rmSync(d, { recursive: true, force: true }); });

  it('says nothing when the repo has no ESLint to break', () => {
    const dir = scratch({ '.lgtm/standards.eslint.js': 'export const standardsRules = {};\n' });
    const out = checkFragmentLints(dir, join(dir, '.lgtm/standards.eslint.js'));
    assert.equal(out.status, 'skipped');
  });

  it('reports BROKEN when the repo\'s eslint cannot lint the file at all', () => {
    // The real case, reduced: an eslint that exits 2 the way a typed config does on a .js
    // file in no tsconfig project. Exit 2 is the distinction that matters — `eslint .`
    // fails outright rather than reporting warnings, and takes the commit with it.
    const dir = scratch({
      '.lgtm/standards.eslint.js': 'export const standardsRules = {};\n',
      'node_modules/.bin/eslint': '#!/bin/sh\necho "Error: parserServices required for @typescript-eslint/await-thenable" >&2\nexit 2\n',
    });
    chmodSync(join(dir, 'node_modules/.bin/eslint'), 0o755);
    const out = checkFragmentLints(dir, join(dir, '.lgtm/standards.eslint.js'));
    assert.equal(out.status, 'broken');
    assert.match((out as { detail: string }).detail, /parserServices/);
  });

  it('tells lint PROBLEMS (exit 1) apart from a config that cannot run (exit 2)', () => {
    const dir = scratch({
      '.lgtm/standards.eslint.js': 'export const standardsRules = {};\n',
      'node_modules/.bin/eslint': '#!/bin/sh\necho "1:1 error Unexpected thing no-thing"\nexit 1\n',
    });
    chmodSync(join(dir, 'node_modules/.bin/eslint'), 0o755);
    assert.equal(checkFragmentLints(dir, join(dir, '.lgtm/standards.eslint.js')).status, 'problems');
  });

  it('is OK when their lint is happy', () => {
    const dir = scratch({
      '.lgtm/standards.eslint.js': 'export const standardsRules = {};\n',
      'node_modules/.bin/eslint': '#!/bin/sh\nexit 0\n',
    });
    chmodSync(join(dir, 'node_modules/.bin/eslint'), 0o755);
    assert.equal(checkFragmentLints(dir, join(dir, '.lgtm/standards.eslint.js')).status, 'ok');
  });

  it('lints the DIRECTORY, so a repo that already applied the remedy is not accused forever', () => {
    // Naming the file explicitly makes ESLint lint it even when the config ignores it, so
    // the probe would keep reporting `broken` after the fix. Caught in live verification
    // against dwlf-indicators, which reported broken while its own `pnpm lint` passed.
    const dir = scratch({
      '.lgtm/standards.eslint.js': 'export const standardsRules = {};\n',
      'node_modules/.bin/eslint': '#!/bin/sh\ncase "$1" in\n  *.js) echo "crash" >&2; exit 2 ;;\n  *) exit 0 ;;\nesac\n',
    });
    chmodSync(join(dir, 'node_modules/.bin/eslint'), 0o755);
    assert.equal(checkFragmentLints(dir, join(dir, '.lgtm/standards.eslint.js')).status, 'ok');
  });

  it('quotes the sentence that explains the crash, not ESLint\'s banner', () => {
    // Verbatim shape of the real failure. "Oops! Something went wrong! :(" is what ESLint
    // prints first and it tells the operator nothing — showing it would reproduce the
    // original problem in miniature: told something broke, not what.
    const real = [
      'Oops! Something went wrong! :(', '', 'ESLint: 8.57.1', '',
      "Error: Error while loading rule '@typescript-eslint/await-thenable': You have used a rule which requires parserServices to be generated.",
      '    at throwError (/x/y/z.js:38:11)',
    ].join('\n');
    assert.match(firstUsefulLine(real), /parserServices/);
    assert.doesNotMatch(firstUsefulLine(real), /Oops/);
    assert.equal(firstUsefulLine(''), 'no output');
  });

  it('a binary that cannot be RUN is "could not tell", not "your lint is broken"', () => {
    // spawnSync leaves status null and no output on EACCES/ENOEXEC. Classified as broken,
    // the operator gets "your lint will now FAIL" followed by the words "no output" — an
    // accusation with no evidence behind it.
    const dir = scratch({
      '.lgtm/standards.eslint.js': 'export const standardsRules = {};\n',
      'node_modules/.bin/eslint': 'not executable\n',
    });
    chmodSync(join(dir, 'node_modules/.bin/eslint'), 0o644);
    const out = checkFragmentLints(dir, join(dir, '.lgtm/standards.eslint.js'));
    assert.equal(out.status, 'skipped');
  });

  it('does not blame the fragment for a lint that was already broken', () => {
    // A missing plugin or unparseable config also exits 2, before the fragment is read.
    // Claiming this file did it comes with a remedy that will not fix anything.
    const dir = scratch({
      '.lgtm/standards.eslint.js': 'export const standardsRules = {};\n',
      'node_modules/.bin/eslint': '#!/bin/sh\necho "Error: Cannot find package \'eslint-plugin-nope\'" >&2\nexit 2\n',
    });
    chmodSync(join(dir, 'node_modules/.bin/eslint'), 0o755);
    const out = checkFragmentLints(dir, join(dir, '.lgtm/standards.eslint.js'));
    assert.equal(out.status, 'broken');
    assert.equal((out as { namesFragment: boolean }).namesFragment, false, 'nothing in the output points at our file');

    const ours = scratch({
      '.lgtm/standards.eslint.js': 'export const standardsRules = {};\n',
      'node_modules/.bin/eslint': '#!/bin/sh\necho "Error while loading rule: .lgtm/standards.eslint.js" >&2\nexit 2\n',
    });
    chmodSync(join(ours, 'node_modules/.bin/eslint'), 0o755);
    assert.equal((checkFragmentLints(ours, join(ours, '.lgtm/standards.eslint.js')) as { namesFragment: boolean }).namesFragment, true);
  });

  it('does not blame the fragment for a neighbour in the same directory', () => {
    // `.lgtm/` is not a one-file directory: the answers JSON is written beside the fragment
    // and `quality baseline` puts its own file there. A rule firing on a neighbour exits 1,
    // and asserting "problems in this generated file" aims the remedy at the wrong file.
    const dir = scratch({
      '.lgtm/standards.eslint.js': 'export const standardsRules = {};\n',
      '.lgtm/standards.answers.json': '{}\n',
      'node_modules/.bin/eslint': '#!/bin/sh\necho ".lgtm/standards.answers.json 1:1 error Bad jsonc/no-comments"\nexit 1\n',
    });
    chmodSync(join(dir, 'node_modules/.bin/eslint'), 0o755);
    const out = checkFragmentLints(dir, join(dir, '.lgtm/standards.eslint.js'));
    assert.equal(out.status, 'problems');
    assert.equal((out as { namesFragment: boolean }).namesFragment, false);
  });

  it('does not probe a fragment written outside the repo by a preview run', () => {
    // `--out /tmp/draft/STANDARDS.md` puts the fragment in /tmp. Linting it with the repo's
    // cwd answers a question about a file that is not in the repo — most likely "ok",
    // because it sits outside the config's base directory. A clean bill for nothing.
    const dir = scratch({ 'node_modules/.bin/eslint': '#!/bin/sh\nexit 2\n' });
    chmodSync(join(dir, 'node_modules/.bin/eslint'), 0o755);
    const out = checkFragmentLints(dir, join(tmpdir(), 'draft', '.lgtm', 'standards.eslint.js'));
    assert.equal(out.status, 'skipped');
    assert.match((out as { reason: string }).reason, /outside this repo/);
  });

  it('tells "no ESLint here" apart from "configured but I cannot run it"', () => {
    // Yarn PnP has no node_modules at all, and in a workspace ESLint may live below the git
    // root. Reporting "nothing to break" there is the exact wrong reassurance.
    const bare = scratch({ '.lgtm/standards.eslint.js': '' });
    assert.match((checkFragmentLints(bare, join(bare, '.lgtm/standards.eslint.js')) as { reason: string }).reason, /no ESLint configured/);

    const pnp = scratch({ '.lgtm/standards.eslint.js': '', 'eslint.config.js': 'export default [];\n' });
    assert.match((checkFragmentLints(pnp, join(pnp, '.lgtm/standards.eslint.js')) as { reason: string }).reason, /no local binary/);
  });

  it('names the real directory in the remedy, not a guessed one', () => {
    const dir = scratch({ '.lgtm/standards.eslint.js': '' });
    assert.match(ignoreRemedy(dir, join(dir, '.lgtm/standards.eslint.js')), /add '\.lgtm' to the `ignores` array/);
    assert.match(ignoreRemedy(dir, join(dir, 'tools/gen/standards.eslint.js')), /add 'tools\/gen'/);
  });
});
