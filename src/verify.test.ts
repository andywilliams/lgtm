import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyVerdicts, parseVerdicts, buildWindows, buildVerifyPrompt, citesDocs, verifyModel, verifyMaxContextBytes, kept, dropped } from './verify.js';
import type { ReviewComment, Severity } from './types.js';

const finding = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  file: 'src/a.ts', line: 10, severity: 'BUG', title: 'boom', body: 'it explodes',
  kind: 'added', confidence: 'medium', evidence: ['const x = null;'], ...over,
});

describe('applyVerdicts — what may drop a finding', () => {
  test('a refuted finding is dropped, whatever its severity', () => {
    const out = applyVerdicts([finding()], { 1: { verdict: 'refuted', verifier_evidence: ['if (x === null) return;'], verifier_note: 'the guard is on line 8' } });
    assert.equal(out[0].verdict, 'refuted');
    assert.equal(out[0].verifier_dropped, true);
    assert.deepEqual(dropped(out).map((c) => c.title), ['boom']);
    assert.deepEqual(kept(out), []);
  });

  test('a refutation with nothing quoted is only "unproven" — so it cannot drop a BUG', () => {
    const out = applyVerdicts([finding()], { 1: { verdict: 'refuted', verifier_evidence: [], verifier_note: 'looks fine to me' } });
    assert.equal(out[0].verdict, 'unproven');
    assert.equal(out[0].verifier_dropped, undefined);
    assert.equal(out[0].confidence, 'low');
  });

  test('an unproven BUG is kept at low confidence; an unproven SUGGESTION is dropped', () => {
    const out = applyVerdicts(
      [finding({ severity: 'BUG' }), finding({ severity: 'SUGGESTION', title: 'naming' }), finding({ severity: 'NITPICK', title: 'spacing' })],
      { 1: { verdict: 'unproven', verifier_note: 'not visible here' }, 2: { verdict: 'unproven', verifier_note: 'a matter of taste' }, 3: { verdict: 'unproven', verifier_note: 'no' } },
    );
    assert.equal(out[0].verifier_dropped, undefined);
    assert.equal(out[0].confidence, 'low');
    assert.deepEqual(dropped(out).map((c) => c.title), ['naming', 'spacing']);
  });

  test('a BUG lowered to SUGGESTION is NOT droppable by the lowering — the reviewer severity decides', () => {
    // The failure this guards: verdict "unproven" + severity "SUGGESTION" would otherwise
    // be a two-step route from BUG to deleted, which is exactly the drop that must not happen.
    const out = applyVerdicts([finding({ severity: 'BUG' })], { 1: { verdict: 'unproven', severity: 'SUGGESTION', verifier_note: 'at worst a readability issue' } });
    assert.equal(out[0].severity, 'SUGGESTION');
    assert.equal(out[0].original_severity, 'BUG');
    assert.equal(out[0].verifier_dropped, undefined, 'a BUG the verifier merely downgraded is still shown');
  });

  test('a finding with no verdict at all is "unverified" and untouched', () => {
    const out = applyVerdicts([finding({ severity: 'SUGGESTION' })], {});
    assert.equal(out[0].verdict, 'unverified');
    assert.equal(out[0].verifier_dropped, undefined, 'silence must never be what deletes a finding');
    assert.equal(out[0].confidence, 'medium', 'and it must not restate the confidence either');
  });
});

describe('applyVerdicts — severity and confidence', () => {
  test('severity may only move down', () => {
    const cases: [Severity, Severity, Severity][] = [
      ['SUGGESTION', 'BUG', 'SUGGESTION'],   // raise refused
      ['NITPICK', 'SUGGESTION', 'NITPICK'],  // raise refused
      ['BUG', 'NITPICK', 'NITPICK'],         // lower accepted
      ['SECURITY', 'BUG', 'SECURITY'],       // lateral refused: BUG and SECURITY rank the same
    ];
    for (const [claimed, proposed, expected] of cases) {
      const out = applyVerdicts([finding({ severity: claimed })], { 1: { verdict: 'confirmed', severity: proposed, verifier_evidence: ['x'], verifier_note: 'n' } });
      assert.equal(out[0].severity, expected, `${claimed} + ${proposed}`);
    }
  });

  test('confirmed with quoted lines earns high confidence; confirmed without keeps what it had', () => {
    const withEvidence = applyVerdicts([finding({ confidence: 'low' })], { 1: { verdict: 'confirmed', verifier_evidence: ['const x = null;'], verifier_note: 'n' } });
    assert.equal(withEvidence[0].confidence, 'high');
    const without = applyVerdicts([finding({ confidence: 'low' })], { 1: { verdict: 'confirmed', verifier_evidence: [], verifier_note: 'n' } });
    assert.equal(without[0].confidence, 'low');
  });
});

describe('parseVerdicts', () => {
  test('ignores verdicts for findings that do not exist — the verifier cannot add any', () => {
    const v = parseVerdicts(JSON.stringify({ verdicts: [
      { id: 1, verdict: 'confirmed', verifier_note: 'a' },
      { id: 4, verdict: 'refuted', verifier_note: 'invented' },
      { id: 0, verdict: 'refuted', verifier_note: 'invented' },
    ] }), 2);
    assert.deepEqual(Object.keys(v), ['1']);
  });

  test('an unrecognised verdict string reads as unproven, not as a drop', () => {
    const v = parseVerdicts(JSON.stringify({ verdicts: [{ id: 1, verdict: 'nonsense', verifier_note: 'a' }] }), 1);
    assert.equal(v[1].verdict, 'unproven');
  });

  test('reads a fenced, chatty reply', () => {
    const v = parseVerdicts('Sure!\n```json\n{"verdicts":[{"id":1,"verdict":"refuted","verifier_evidence":["ok"],"verifier_note":"n"}]}\n```\n', 1);
    assert.equal(v[1].verdict, 'refuted');
  });

  test('an unreadable reply yields no verdicts, so nothing is dropped', () => {
    assert.deepEqual(parseVerdicts('the model apologises and says nothing else', 3), {});
  });
});

describe('buildWindows', () => {
  const file = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n');

  test('shows the neighbourhood of each finding, with the file\'s own line numbers', () => {
    const out = buildWindows([finding({ file: 'src/a.ts', line: 200 })], { 'src/a.ts': file }, 100_000);
    assert.match(out, /src\/a\.ts — lines 140-260/);
    assert.match(out, /^200\tline 200$/m);
    assert.doesNotMatch(out, /^300\t/m, 'lines outside the window are not sent');
  });

  test('merges overlapping windows instead of sending the same lines twice', () => {
    const out = buildWindows([finding({ line: 200 }), finding({ line: 220 })], { 'src/a.ts': file }, 100_000);
    assert.equal(out.match(/— lines /g)?.length, 1);
    assert.match(out, /lines 140-280/);
  });

  test('clamps to the file and skips files it was not given', () => {
    const out = buildWindows([finding({ line: 3 }), finding({ file: 'src/gone.ts', line: 9 })], { 'src/a.ts': file }, 100_000);
    assert.match(out, /lines 1-63/);
    assert.doesNotMatch(out, /src\/gone\.ts/);
  });

  test('a window that does not fit the cap is left out and the header says so', () => {
    const out = buildWindows([finding({ line: 200 })], { 'src/a.ts': file }, 10);
    assert.match(out, /some windows did not fit within the size cap/);
    assert.doesNotMatch(out, /^200\tline 200$/m);
    assert.notEqual(out, '', 'a block that vanished under the cap must still say it existed');
  });

  test('no windows at all produces nothing rather than an empty header', () => {
    assert.equal(buildWindows([], { 'src/a.ts': file }, 100_000), '');
  });
});

describe('buildVerifyPrompt', () => {
  test('sends the charter only when a finding actually cites it', () => {
    const base = { diff: 'diff --git a b', prTitle: 'T', contents: {}, docs: 'CHARTER-TEXT-MARKER' };
    assert.doesNotMatch(buildVerifyPrompt({ ...base, findings: [finding()] }), /CHARTER-TEXT-MARKER/);
    assert.match(buildVerifyPrompt({ ...base, findings: [finding({ title: '(charter) drifted' })] }), /CHARTER-TEXT-MARKER/);
    assert.match(buildVerifyPrompt({ ...base, findings: [finding({ title: '(standard FUN-1) too long' })] }), /CHARTER-TEXT-MARKER/);
  });

  test('says when the reviewer quoted nothing, so an unevidenced claim is visible as one', () => {
    const p = buildVerifyPrompt({ diff: 'd', prTitle: 'T', findings: [finding({ evidence: [] })] });
    assert.match(p, /the reviewer quoted nothing/);
  });

  test('numbers the findings so verdicts can be matched back', () => {
    const p = buildVerifyPrompt({ diff: 'd', prTitle: 'T', findings: [finding(), finding({ title: 'second' })] });
    assert.match(p, /### Finding 1/);
    assert.match(p, /### Finding 2/);
    assert.match(p, /Findings to verify \(2\)/);
  });

  test('citesDocs recognises both tag spellings and nothing else', () => {
    assert.equal(citesDocs([finding({ title: '(charter) x' })]), true);
    assert.equal(citesDocs([finding({ title: '(standard NAM-2) x' })]), true);
    assert.equal(citesDocs([finding({ title: '(out of scope) x' })]), false);
  });
});

describe('configuration', () => {
  test('the verifier model defaults to the cheap one, is overridable, and is not assumed for a non-first-party id', () => {
    delete process.env.LGTM_VERIFY_MODEL;
    assert.equal(verifyModel('claude-opus-5').model, 'claude-sonnet-5');
    assert.equal(verifyModel('arn:aws:bedrock:eu-west-2::foundation-model/x').model, undefined);
    process.env.LGTM_VERIFY_MODEL = 'claude-haiku-4-5-20251001';
    assert.equal(verifyModel('claude-opus-5').model, 'claude-haiku-4-5-20251001');
    delete process.env.LGTM_VERIFY_MODEL;
  });

  test('a junk byte cap falls back to the default rather than sending nothing', () => {
    assert.equal(verifyMaxContextBytes('0'), verifyMaxContextBytes(undefined));
    assert.equal(verifyMaxContextBytes('-5'), verifyMaxContextBytes(undefined));
    assert.equal(verifyMaxContextBytes('banana'), verifyMaxContextBytes(undefined));
    assert.equal(verifyMaxContextBytes('1234'), 1234);
  });
});
