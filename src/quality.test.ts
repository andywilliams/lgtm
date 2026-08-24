/**
 * Phase-1 quality spine tests. The properties under guard:
 * - score follows Stryker's own definition (detected/valid; Ignored and
 *   CompileError excluded from BOTH sides — including them either way skews
 *   every downstream ratchet comparison);
 * - zero-valid files are DROPPED, never reported as 0% or 100% (a claim the
 *   data does not hold — the house records-never-claim rule);
 * - ranking is deterministic and blockedBy rides the row (fix-before-harden);
 * - the baseline is sorted and rounded so its diffs are stable in PRs.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseMutationReport, buildBaseline, rankHotspots, runQualityBaseline } from './quality.js';

const mutant = (status: string) => ({ id: 'm', status, mutatorName: 'X', location: {}, replacement: '' });

const report = {
  schemaVersion: '1.0',
  files: {
    'src/a.ts': { language: 'typescript', source: '', mutants: [
      mutant('Killed'), mutant('Killed'), mutant('Timeout'), mutant('Survived'),
    ] },
    'src/b.ts': { language: 'typescript', source: '', mutants: [
      mutant('Survived'), mutant('Survived'), mutant('NoCoverage'), mutant('Killed'),
    ] },
    'src/ignored-only.ts': { language: 'typescript', source: '', mutants: [
      mutant('Ignored'), mutant('CompileError'),
    ] },
  },
};

test('score is Stryker\'s definition: (Killed+Timeout)/valid, Ignored/CompileError excluded', () => {
  const files = parseMutationReport(report);
  const a = files.find((f) => f.path === 'src/a.ts')!;
  assert.equal(a.mutants, 4);
  assert.equal(a.killed, 3); // Timeout counts as detected
  assert.equal(a.score, 75);
  const b = files.find((f) => f.path === 'src/b.ts')!;
  assert.equal(b.score, 25);
  assert.equal(b.noCoverage, 1);
});

test('a file with zero valid mutants is DROPPED, not scored', () => {
  const files = parseMutationReport(report);
  assert.equal(files.find((f) => f.path === 'src/ignored-only.ts'), undefined);
});

test('a non-Stryker document throws, never returns an empty success', () => {
  assert.throws(() => parseMutationReport({ some: 'other json' }), /Not a Stryker mutation report/);
  assert.throws(() => parseMutationReport(null), /Not a Stryker mutation report/);
});

test('ranking: risk = (1−score) × mutants × (1+churn), highest first; blockedBy rides the row', () => {
  const files = parseMutationReport(report);
  const churn = new Map([['src/a.ts', 9], ['src/b.ts', 1]]);
  const blocked = new Map([['src/b.ts', [{ number: 93, title: 'classifyTrend wrong' }]]]);
  const ranked = rankHotspots(files, churn, blocked);
  // a: 0.25*4*10 = 10 ; b: 0.75*4*2 = 6 → a first despite the better score.
  assert.equal(ranked[0].path, 'src/a.ts');
  assert.equal(Math.round(ranked[0].risk), 10);
  assert.equal(ranked[1].blockedBy[0].number, 93);
});

test('churn defaults to 0 (missing from the map), never a crash', () => {
  const files = parseMutationReport(report);
  const ranked = rankHotspots(files, new Map(), new Map());
  assert.ok(ranked.every((r) => r.churn === 0 && Number.isFinite(r.risk)));
});

test('baseline: sorted keys, 2dp scores — stable diffs in PRs', () => {
  const files = parseMutationReport(report);
  const doc = buildBaseline(files.reverse(), { commit: 'abc123', reportPath: 'reports/mutation/mutation.json' });
  assert.deepEqual(Object.keys(doc.files), ['src/a.ts', 'src/b.ts']);
  assert.equal(doc.files['src/b.ts'].score, 25);
  assert.equal(doc.commit, 'abc123');
});

test('baseline doc carries version: 1 (Phase-2 gates must be able to tell schemas apart)', () => {
  const doc = buildBaseline(parseMutationReport(report), { commit: null, reportPath: 'x' });
  assert.equal(doc.version, 1);
});

// The ratchet-clearing guard: re-running baseline against a WEAKER report must
// refuse to lower committed scores without --force — this file IS the ratchet,
// and clearing it must be a conscious act (arch review finding, 24-Aug).
test('baseline refuses to LOWER a committed score without --force, allows it with', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-q-'));
  const strong = { schemaVersion: '1.0', files: { 'src/a.ts': { language: 'ts', source: '', mutants: [
    mutant('Killed'), mutant('Killed'), mutant('Killed'), mutant('Survived'),
  ] } } }; // 75%
  const weak = { schemaVersion: '1.0', files: { 'src/a.ts': { language: 'ts', source: '', mutants: [
    mutant('Killed'), mutant('Survived'), mutant('Survived'), mutant('Survived'),
  ] } } }; // 25%
  fs.writeFileSync(path.join(dir, 'mutation.json'), JSON.stringify(strong));
  await runQualityBaseline({ cwd: dir, report: 'mutation.json' });
  const committed = JSON.parse(fs.readFileSync(path.join(dir, '.lgtm/mutation-baseline.json'), 'utf8'));
  assert.equal(committed.files['src/a.ts'].score, 75);

  fs.writeFileSync(path.join(dir, 'mutation.json'), JSON.stringify(weak));
  await assert.rejects(
    () => runQualityBaseline({ cwd: dir, report: 'mutation.json' }),
    /Refusing to LOWER/
  );
  const stillCommitted = JSON.parse(fs.readFileSync(path.join(dir, '.lgtm/mutation-baseline.json'), 'utf8'));
  assert.equal(stillCommitted.files['src/a.ts'].score, 75, 'refusal must leave the ratchet untouched');

  await runQualityBaseline({ cwd: dir, report: 'mutation.json', force: true });
  const lowered = JSON.parse(fs.readFileSync(path.join(dir, '.lgtm/mutation-baseline.json'), 'utf8'));
  assert.equal(lowered.files['src/a.ts'].score, 25, '--force lowers, loudly');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a RISING score rewrites freely — that is the ratchet working, not a reset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lgtm-q-'));
  const weak = { schemaVersion: '1.0', files: { 'src/a.ts': { language: 'ts', source: '', mutants: [
    mutant('Killed'), mutant('Survived'),
  ] } } }; // 50%
  const strong = { schemaVersion: '1.0', files: { 'src/a.ts': { language: 'ts', source: '', mutants: [
    mutant('Killed'), mutant('Killed'), mutant('Killed'), mutant('Survived'),
  ] } } }; // 75%
  fs.writeFileSync(path.join(dir, 'mutation.json'), JSON.stringify(weak));
  await runQualityBaseline({ cwd: dir, report: 'mutation.json' });
  fs.writeFileSync(path.join(dir, 'mutation.json'), JSON.stringify(strong));
  await runQualityBaseline({ cwd: dir, report: 'mutation.json' }); // no --force needed
  const committed = JSON.parse(fs.readFileSync(path.join(dir, '.lgtm/mutation-baseline.json'), 'utf8'));
  assert.equal(committed.files['src/a.ts'].score, 75);
  fs.rmSync(dir, { recursive: true, force: true });
});
