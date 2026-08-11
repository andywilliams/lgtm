import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG, GROUPS, REJECTED, askEntries } from './standardsCatalog.js';
import { findStandardsDoc, buildStandardsBlock, generateStandardsDoc, clampThresholds, thresholdsConsumed, DEFAULT_THRESHOLDS, type StandardsSelections } from './standards.js';
import { measureFunctions, proposeThresholds, type RepoScan } from './standardsInterview.js';

// Guards three promises: the catalog is internally consistent (unique ids, every
// ask-entry interviewable, recommended stances enforceable), STANDARDS.md
// generation is deterministic and complete (thresholds substituted, rejects and
// not-enforced recorded so reviews never re-litigate), and doc resolution for
// the review side mirrors the charter's best-effort contract.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lgtm-standards-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function defaultSelections(overrides: Partial<StandardsSelections> = {}): StandardsSelections {
  const askChoices: Record<string, string> = {};
  for (const e of askEntries()) askChoices[e.id] = e.ask!.options[0].value;
  return { askChoices, thresholds: DEFAULT_THRESHOLDS, houseRules: [], ...overrides };
}

describe('standards catalog integrity', () => {
  it('has unique ids across catalog and rejected list', () => {
    const ids = [...CATALOG.map((e) => e.id), ...REJECTED.map((r) => r.id)];
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it('every entry belongs to a declared group', () => {
    const groupKeys = new Set(GROUPS.map((g) => g.key));
    for (const e of CATALOG) assert.ok(groupKeys.has(e.group), `${e.id} has unknown group ${e.group}`);
  });

  it('ask entries have a question and 2+ options, with an enforceable recommended stance', () => {
    for (const e of askEntries()) {
      assert.ok(e.ask, `${e.id} default:ask without ask config`);
      assert.ok(e.ask!.question.trim());
      assert.ok(e.ask!.options.length >= 2, `${e.id} needs at least 2 options`);
      assert.ok(e.ask!.options[0].rule.trim(), `${e.id} recommended (first) option must carry a rule`);
      const values = e.ask!.options.map((o) => o.value);
      assert.strictEqual(new Set(values).size, values.length, `${e.id} duplicate option values`);
    }
  });

  it('on-entries carry a rule; off-entries carry a non-empty reason when they record one', () => {
    for (const e of CATALOG) {
      if (e.default === 'on') assert.ok(e.rule.trim(), `${e.id} default:on with empty rule`);
      if (e.default === 'off' && e.offReason !== undefined) {
        assert.ok(e.offReason.trim(), `${e.id} default:off with blank offReason — drop the field or state the reason`);
      }
    }
  });
});

describe('generateStandardsDoc', () => {
  it('renders adopted standards, substitutes thresholds, and leaves no placeholders', () => {
    const doc = generateStandardsDoc({ repoName: 'my-repo', profile: 'service', selections: defaultSelections(), date: '2026-08-11' });
    assert.match(doc, /G30 · Do one thing/);
    assert.match(doc, new RegExp(`warn >${DEFAULT_THRESHOLDS.fnWarn} lines`));
    assert.doesNotMatch(doc, /\{fnWarn\}|\{fnMax\}|\{fileWarn\}|\{fileMax\}/);
    assert.match(doc, /profile: service/);
  });

  it('records rejected entries and default-off entries so reviews never re-raise them', () => {
    const doc = generateStandardsDoc({ repoName: 'r', profile: 'lib', selections: defaultSelections(), date: '2026-08-11' });
    for (const r of REJECTED) assert.ok(doc.includes(`**${r.id} · `), `missing rejected ${r.id}`);
    assert.match(doc, /TST-5 · TDD three laws/); // off + reason → Not enforced
    assert.match(doc, /DSN-5 · Postpone decisions/);
  });

  it('an ask-entry answered "off" moves to Not enforced instead of rendering a rule', () => {
    const selections = defaultSelections();
    selections.askChoices['FUN-1'] = 'off';
    const doc = generateStandardsDoc({ repoName: 'r', profile: 'service', selections, date: '2026-08-11' });
    const notEnforced = doc.slice(doc.indexOf('## Not enforced'));
    assert.match(notEnforced, /FUN-1 · Function size/);
    assert.doesNotMatch(doc.slice(0, doc.indexOf('## Not enforced')), /FUN-1 · Function size/);
  });

  it('applies profile overrides (frontend drops boundary learning-tests)', () => {
    const doc = generateStandardsDoc({ repoName: 'r', profile: 'frontend', selections: defaultSelections(), date: '2026-08-11' });
    const notEnforced = doc.slice(doc.indexOf('## Not enforced'));
    assert.match(notEnforced, /BND-2 · Learning and boundary tests/);
  });

  it('renders house rules dated with HR ids, and records the interview choices', () => {
    const selections = defaultSelections({ houseRules: ['Every list read paginates or asserts single-page.'] });
    const doc = generateStandardsDoc({ repoName: 'r', profile: 'service', selections, date: '2026-08-11' });
    assert.match(doc, /\*\*HR-1\*\* \(2026-08-11\) — Every list read paginates/);
    assert.match(doc, /## Choices/);
    assert.match(doc, /2026-08-11 — \*\*FUN-1\*\*/);
  });

  it('marks everywhere-scope standards', () => {
    const doc = generateStandardsDoc({ repoName: 'r', profile: 'service', selections: defaultSelections(), date: '2026-08-11' });
    assert.match(doc, /C5 · No commented-out code\*\* \*\*\[everywhere\]\*\*/);
  });
});

describe('findStandardsDoc / buildStandardsBlock', () => {
  const DOC = `---\ntitle: r — engineering standards\n---\n\n# r — engineering standards\n\n- **G30 · Do one thing** — handlers orchestrate only.\n`;

  it('resolves root before docs/ before .lgtm/, stripping frontmatter', () => {
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'STANDARDS.md'), DOC);
    assert.strictEqual(findStandardsDoc(dir)!.path, join(dir, 'docs', 'STANDARDS.md'));
    writeFileSync(join(dir, 'STANDARDS.md'), DOC);
    const found = findStandardsDoc(dir)!;
    assert.strictEqual(found.path, join(dir, 'STANDARDS.md'));
    assert.ok(!found.content.startsWith('---'));
  });

  it('returns an empty block when there is no doc (never an error)', () => {
    assert.strictEqual(buildStandardsBlock(dir).block, '');
    assert.strictEqual(buildStandardsBlock(null).block, '');
  });

  it('builds a prompt block carrying the doc, the id-citation rule and the finding cap', () => {
    writeFileSync(join(dir, 'STANDARDS.md'), DOC);
    const { block, path } = buildStandardsBlock(dir);
    assert.strictEqual(path, join(dir, 'STANDARDS.md'));
    assert.match(block, /at most THREE/i);
    assert.match(block, /\(standard <id>\)/);
    assert.match(block, /G30 · Do one thing/);
    assert.match(block, /Rejected/); // the never-raise instruction names the section
  });

  it('clips an oversize doc from the middle, preserving the never-re-raise tail', () => {
    const tail = '## Rejected\n- **J1 · Wildcard imports** — inverted in TS.\n';
    const doc = '# r — engineering standards\n' + '- filler line about a standard\n'.repeat(1200) + tail;
    writeFileSync(join(dir, 'STANDARDS.md'), doc);
    const { block } = buildStandardsBlock(dir);
    assert.ok(block.length < doc.length);
    assert.match(block, /middle truncated/);
    assert.match(block, /J1 · Wildcard imports/); // tail survived
  });
});

describe('thresholdsConsumed', () => {
  it('default stances consume both threshold families', () => {
    const s = defaultSelections();
    assert.deepStrictEqual(thresholdsConsumed('service', s.askChoices), { fn: true, file: true });
  });

  it('FUN-1 "strict" consumes no function thresholds (its rule has no placeholders)', () => {
    const s = defaultSelections();
    s.askChoices['FUN-1'] = 'strict';
    assert.strictEqual(thresholdsConsumed('service', s.askChoices).fn, false);
  });

  it('FMT-2 "off" consumes no file thresholds', () => {
    const s = defaultSelections();
    s.askChoices['FMT-2'] = 'off';
    assert.strictEqual(thresholdsConsumed('service', s.askChoices).file, false);
  });

  it('the generated Choices line records only consumed families', () => {
    const s = defaultSelections();
    s.askChoices['FUN-1'] = 'strict';
    const doc = generateStandardsDoc({ repoName: 'r', profile: 'service', selections: s, date: '2026-08-11' });
    assert.doesNotMatch(doc, /thresholds: function warn/);
    assert.match(doc, /thresholds: file warn/);
    s.askChoices['FMT-2'] = 'off';
    const doc2 = generateStandardsDoc({ repoName: 'r', profile: 'service', selections: s, date: '2026-08-11' });
    assert.doesNotMatch(doc2, /— thresholds:/);
  });
});

describe('clampThresholds', () => {
  it('repairs an inverted warn/finding pair from independent answers', () => {
    const t = clampThresholds({ fnWarn: 100, fnMax: 80, fileWarn: 900, fileMax: 800 });
    assert.strictEqual(t.fnMax, 130);
    assert.strictEqual(t.fileMax, 1300);
  });

  it('leaves a valid pair untouched', () => {
    assert.deepStrictEqual(clampThresholds(DEFAULT_THRESHOLDS), DEFAULT_THRESHOLDS);
  });
});

describe('measureFunctions (approximate scan)', () => {
  it('measures declaration and arrow function lengths by brace tracking', () => {
    const src = [
      'export function five(a: number, b: number) {', '  const x = a;', '  const y = b;', '  return x + y;', '}',
      'const arrow = (a: string) => {', '  return a;', '};',
      'const notAFunction = 3;',
    ].join('\n');
    const { lengths } = measureFunctions(src);
    assert.deepStrictEqual(lengths, [5, 3]);
  });

  it('follows a wrapped signature across lines when counting parameters', () => {
    const src = [
      'export async function reviewPR(',
      '  diff: string,',
      '  prTitle: string,',
      '  prBody: string,',
      '  opts: { a: number, b: number }',
      ') {',
      '  return diff;',
      '}',
    ].join('\n');
    const { maxArgs } = measureFunctions(src);
    assert.strictEqual(maxArgs, 4);
  });

  it('takes an inline callback\'s own params, not the enclosing call\'s parens', () => {
    const src = [
      "router.get('/x', (req, res) => {",
      '  res.send(req.params);',
      '});',
    ].join('\n');
    const { lengths, maxArgs } = measureFunctions(src);
    assert.deepStrictEqual(lengths, [3]);
    assert.strictEqual(maxArgs, 2);
  });

  it('does not count control-flow blocks as functions', () => {
    const src = [
      'if (x) {', '  y();', '}',
      'for (const a of b) {', '  y();', '}',
      'while (x) {', '  y();', '}',
      'switch (x) {', '  default: break;', '}',
      'function real() {', '  return 1;', '}',
    ].join('\n');
    const { lengths } = measureFunctions(src);
    assert.deepStrictEqual(lengths, [3]);
  });

  it('counts only top-level commas as parameters', () => {
    const src = 'function f(opts: { a: number, b: number }, second: string) {\n  return opts;\n}\n';
    const { maxArgs } = measureFunctions(src);
    assert.strictEqual(maxArgs, 2);
  });
});

describe('proposeThresholds', () => {
  function scanWith(fnP95: number, fileP95: number): RepoScan {
    return {
      fileCount: 10,
      fileLines: { p50: 100, p95: fileP95, max: fileP95 * 2 },
      fnLines: { p50: 10, p95: fnP95, max: fnP95 * 2 },
      fnOver: () => 0,
      filesOver: () => 0,
      maxPositionalArgs: 3,
      profileGuess: 'service',
      profileEvidence: '',
      summary: '',
    };
  }

  it('keeps defaults when the repo is already under them', () => {
    assert.deepStrictEqual(proposeThresholds(scanWith(30, 200)), DEFAULT_THRESHOLDS);
  });

  it('rounds a higher p95 up and keeps warn < finding, capped', () => {
    const t = proposeThresholds(scanWith(74, 620));
    assert.strictEqual(t.fnWarn, 80);
    assert.ok(t.fnMax > t.fnWarn);
    assert.strictEqual(t.fileWarn, 620);
    assert.ok(t.fileMax > t.fileWarn);
    const capped = proposeThresholds(scanWith(400, 5000));
    assert.strictEqual(capped.fnWarn, 100);
    assert.strictEqual(capped.fileWarn, 700);
  });
});
