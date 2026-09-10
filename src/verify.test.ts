import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyVerdicts, parseVerdicts, buildWindows, buildVerifyPrompt, citesDocs, citesDoc, DOC_TAG_EXEMPT, quotesShownText, referencedPaths, extraFilesFor, diffFiles, wasShown, verifyModel, verifyMaxContextBytes, verifyFindings, kept, dropped } from './verify.js';
import { setModelOverride, getModelOverride } from './ai.js';
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

  test('"unshown" never drops anything — the verifier is describing its own context, not the code', () => {
    // Round 3 of this feature's own loop dropped three TRUE findings as "unproven"
    // because their proof was in files it was never given. That is the failure this
    // verdict exists to make impossible.
    const out = applyVerdicts(
      [finding({ severity: 'SUGGESTION', title: 'stale docs' }), finding({ severity: 'NITPICK', title: 'nit' }), finding({ severity: 'BUG', title: 'bug' })],
      { 1: { verdict: 'unshown', verifier_note: 'README.md was not among the files' },
        2: { verdict: 'unshown', verifier_note: 'not shown' },
        3: { verdict: 'unshown', verifier_note: 'not shown' } },
    );
    assert.deepEqual(dropped(out), []);
    assert.deepEqual(out.map((c) => c.confidence), ['medium', 'medium', 'medium'], 'and it is not downgraded either');
  });

  test('an unrecognised verdict is "unshown", so a garbled reply cannot delete a finding', () => {
    const v = parseVerdicts(JSON.stringify({ verdicts: [{ id: 1, verdict: 'probably fine', verifier_note: 'a' }] }), 1);
    assert.equal(v[1].verdict, 'unshown');
    assert.deepEqual(dropped(applyVerdicts([finding({ severity: 'NITPICK' })], v)), []);
  });

  test('a finding whose evidence is a DOCUMENT is not dropped merely as unproven', () => {
    // Each document check is capped at ONE finding and is always a SUGGESTION, so the
    // opinion-drop could otherwise delete a whole capped feature silently. The completeness
    // check is the sharp case: one SUGGESTION asserting an ABSENCE, which has no lines to
    // quote. They can still be REFUTED; what is refused is deletion by inability to prove.
    const docs = [
      finding({ severity: 'SUGGESTION', title: '(ticket) criterion 2 is not addressed' }),
      finding({ severity: 'SUGGESTION', title: '(charter) this contradicts an invariant' }),
      finding({ severity: 'NITPICK', title: '(standard FUN-1) the function is too long' }),
    ];
    const unproven = Object.fromEntries(docs.map((_, i) => [i + 1, { verdict: 'unproven' as const, verifier_note: 'n' }]));
    assert.deepEqual(dropped(applyVerdicts(docs, unproven)), []);

    const refuted = Object.fromEntries(docs.map((_, i) => [i + 1, { verdict: 'refuted' as const, verifier_evidence: ['x'], verifier_note: 'n' }]));
    assert.equal(dropped(applyVerdicts(docs, refuted)).length, 3, 'a refuted document claim is still dropped');

    assert.equal(citesDoc(finding({ title: '(out of scope) x' })), false);
    assert.equal(citesDoc(finding({ title: 'plain finding' })), false);
  });

  test('the exemption is CAPPED per tag, so it cannot switch the filter off', () => {
    // The caps each check states are instructions to a model, and the exemption is keyed on
    // a title prefix the reviewer chooses. Unbounded, a pedantic round could put any number
    // of undroppable opinions through with no signal that it had happened.
    const many = [
      ...Array.from({ length: 3 }, (_, i) => finding({ severity: 'SUGGESTION', title: `(ticket) criterion ${i}` })),
      ...Array.from({ length: 5 }, (_, i) => finding({ severity: 'SUGGESTION', title: `(standard FUN-${i}) too long` })),
    ];
    const unproven = Object.fromEntries(many.map((_, i) => [i + 1, { verdict: 'unproven' as const, verifier_note: 'n' }]));
    const out = applyVerdicts(many, unproven);
    const kept = out.filter((c) => !c.verifier_dropped);
    assert.equal(kept.length, DOC_TAG_EXEMPT.ticket + DOC_TAG_EXEMPT.standard, 'one ticket finding and three standards findings survive');
    assert.equal(dropped(out).length, 4, 'the rest are ordinary opinions');
    assert.deepEqual(kept.map((c) => c.title), ['(ticket) criterion 0', '(standard FUN-0) too long', '(standard FUN-1) too long', '(standard FUN-2) too long']);
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

  test('a file a finding NAMES is shown whole, even though the finding is anchored elsewhere', () => {
    // The failure this fixes, measured on this feature's own round 3: all three drops were
    // true findings whose proof was in another file — "getMonthlyStats counts only
    // usage_source = 'measured'", raised against a line in cli.ts.
    const f = finding({ file: 'src/a.ts', line: 5, body: 'the reader is getMonthlyStats in src/db.ts, which counts only measured rows' });
    const out = buildWindows([f], { 'src/a.ts': 'a\nb\nc', 'src/db.ts': 'const measured = 1;' }, 100_000);
    assert.match(out, /src\/db\.ts — whole file \(named by a finding\)/);
    assert.match(out, /const measured = 1;/);
    assert.match(out, /Files below: src\/a\.ts, src\/db\.ts/);
  });

  test('a named file already windowed is not sent twice, and an ambiguous name is not guessed', () => {
    const f = finding({ file: 'src/a.ts', line: 1, body: 'see src/a.ts and also index.ts' });
    const out = buildWindows([f], { 'src/a.ts': 'x', 'one/index.ts': 'y', 'two/index.ts': 'z' }, 100_000);
    assert.equal(out.match(/### src\/a\.ts/g)?.length, 1);
    assert.doesNotMatch(out, /index\.ts/, 'a basename shared by two files resolves to neither');
  });

  test('referencedPaths reads paths out of the finding\'s own text, wherever they appear', () => {
    const paths = referencedPaths(finding({
      title: 'README.md is stale', body: 'compare src/db.ts:863 with the docs',
      evidence: ['- import x from "./cache.js";'], how_to_verify: 'grep ARCHITECTURE.md',
    }));
    for (const p of ['README.md', 'src/db.ts', 'ARCHITECTURE.md']) assert.ok(paths.includes(p), `missing ${p}`);
  });

  test('extraFilesFor never returns a pseudo-path block', () => {
    const f = finding({ body: 'the charter says so' });
    assert.deepEqual(extraFilesFor([f], { '@charter': 'x', 'src/a.ts': 'y' }, new Set()), []);
  });

  test('a window that does not fit the cap is left out and the header says so', () => {
    const out = buildWindows([finding({ line: 200 })], { 'src/a.ts': file }, 10);
    assert.match(out, /did not fit within the size cap/);
    assert.doesNotMatch(out, /^200\tline 200$/m);
    assert.notEqual(out, '', 'a block that vanished under the cap must still say it existed');
  });

  test('no windows at all produces nothing rather than an empty header', () => {
    assert.equal(buildWindows([], { 'src/a.ts': file }, 100_000), '');
  });

  test('a file name that is an inherited property is not a file', () => {
    // `file` is model output; a bare contents[f.file] resolves "toString" to a function.
    assert.equal(buildWindows([finding({ file: 'toString' })], { 'src/a.ts': file }, 100_000), '');
    assert.equal(buildWindows([finding({ file: 'constructor' })], {}, 100_000), '');
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

  test('citesDocs recognises every document tag and nothing else', () => {
    // Each of these is a finding whose ONLY evidence is a document. Miss one and the drop
    // rule deletes that whole class as unprovable opinion, since they are all SUGGESTIONs.
    assert.equal(citesDocs([finding({ title: '(charter) x' })]), true);
    assert.equal(citesDocs([finding({ title: '(standard NAM-2) x' })]), true);
    assert.equal(citesDocs([finding({ title: '(ticket) x' })]), true);
    assert.equal(citesDocs([finding({ title: '(out of scope) x' })]), false);
  });

  test('a (ticket) finding is verified WITH the ticket in front of the verifier', () => {
    const p = buildVerifyPrompt({ diff: 'd', prTitle: 'T', docs: 'TICKET-TEXT-MARKER', findings: [finding({ severity: 'SUGGESTION', title: '(ticket) criterion 2 is not addressed' })] });
    assert.match(p, /TICKET-TEXT-MARKER/);
  });
});

describe('configuration', () => {
  test('the verifier model defaults to the cheap one, is overridable, and is not assumed for a non-first-party id', () => {
    delete process.env.LGTM_VERIFY_MODEL;
    assert.deepEqual({ ...verifyModel('claude-opus-5'), reason: '' }, { enabled: true, model: 'claude-sonnet-5', reason: '' });
    assert.equal(verifyModel('arn:aws:bedrock:eu-west-2::foundation-model/x').model, undefined);
    process.env.LGTM_VERIFY_MODEL = 'claude-haiku-4-5-20251001';
    assert.equal(verifyModel('claude-opus-5').model, 'claude-haiku-4-5-20251001');
    delete process.env.LGTM_VERIFY_MODEL;
  });

  test('LGTM_VERIFY_MODEL=off turns the pass off; junk is ignored rather than passed through', () => {
    process.env.LGTM_VERIFY_MODEL = 'off';
    assert.equal(verifyModel('claude-opus-5').enabled, false, 'the same idiom as LGTM_LATE_MODEL=off');
    // Unvalidated, a typo reaches setModelOverride, throws inside the pass's own guard,
    // and every round silently verifies nothing with no warning anywhere.
    process.env.LGTM_VERIFY_MODEL = 'sonnet please';
    const junk = verifyModel('claude-opus-5');
    assert.equal(junk.enabled, true);
    assert.equal(junk.model, 'claude-sonnet-5', 'falls back to the default');
    assert.match(junk.reason, /ignored: not a model id/);
    delete process.env.LGTM_VERIFY_MODEL;
  });

  test('a junk byte cap falls back to the default rather than sending nothing', () => {
    assert.equal(verifyMaxContextBytes('0'), verifyMaxContextBytes(undefined));
    assert.equal(verifyMaxContextBytes('-5'), verifyMaxContextBytes(undefined));
    assert.equal(verifyMaxContextBytes('banana'), verifyMaxContextBytes(undefined));
    assert.equal(verifyMaxContextBytes('1234'), 1234);
  });
});


describe('verifyFindings — the contract that must hold when it goes wrong', () => {
  test('a pass that cannot run leaves every finding exactly as raised, and says why', () => {
    // LGTM_NO_CALL is the "stop before any model call" sentinel: the closest thing to a
    // CLI that is missing, broken or refusing, without spending anything.
    process.env.LGTM_NO_CALL = '1';
    try {
      const findings = [finding({ severity: 'BUG' }), finding({ severity: 'SUGGESTION', title: 'nit' })];
      const out = verifyFindings({ diff: 'd', prTitle: 'T', findings, ai: 'claude', model: 'claude-sonnet-5' });
      assert.match(out.failed ?? '', /LGTM_NO_CALL/);
      assert.deepEqual(out.comments, findings, 'not one finding is altered, and none is dropped');
      assert.deepEqual(dropped(out.comments), []);
    } finally {
      delete process.env.LGTM_NO_CALL;
    }
  });

  test('it puts the review\'s model back, even when it fails', () => {
    // The override is process-wide: leaving the verifier's cheaper model set would run
    // whatever the command does after this on it.
    process.env.LGTM_NO_CALL = '1';
    setModelOverride('claude-opus-5');
    try {
      verifyFindings({ diff: 'd', prTitle: 'T', findings: [finding()], ai: 'claude', model: 'claude-sonnet-5' });
      assert.equal(getModelOverride(), 'claude-opus-5');
    } finally {
      delete process.env.LGTM_NO_CALL;
      setModelOverride(undefined);
    }
  });

  test('a finding whose file names an inherited property does not escape the guard', () => {
    // `file` is model output. Before the fix, buildVerifyPrompt ran ABOVE the try and
    // indexed `contents[f.file]` bare, so "toString" resolved to a function and threw out
    // of the function documented as never throwing — losing a review already paid for.
    process.env.LGTM_NO_CALL = '1';
    try {
      const out = verifyFindings({ diff: 'd', prTitle: 'T', findings: [finding({ file: 'toString' })], contents: { 'src/a.ts': 'x' }, ai: 'claude' });
      assert.ok(out.failed, 'it reports a failure rather than throwing');
      assert.equal(out.comments.length, 1);
    } finally {
      delete process.env.LGTM_NO_CALL;
    }
  });

  test('nothing to verify means no model call at all', () => {
    process.env.LGTM_NO_CALL = '1';
    try {
      const out = verifyFindings({ diff: 'd', prTitle: 'T', findings: [], ai: 'claude' });
      assert.deepEqual(out.comments, []);
      assert.equal(out.failed, undefined, 'an empty round is not a failed pass');
    } finally {
      delete process.env.LGTM_NO_CALL;
    }
  });
});


describe('the shown-context rule — the caller decides, not the prose', () => {
  const ctx = (shown: string[], inDiff: string[] = []) => ({ shown: new Set(shown), inDiff: new Set(inDiff) });

  test('a verdict about code the verifier never held becomes "unshown", whatever it called it', () => {
    // Exactly this feature's round 3: a finding anchored in a file that IS in the diff,
    // whose proof is a function in another file that was never sent. The model answered
    // "unproven" and the finding — which was true — was dropped.
    const f = finding({ severity: 'SUGGESTION', file: 'src/cli.ts', line: 661, body: "the reader is getMonthlyStats in src/db.ts, which counts only 'measured'" });
    const contents = { 'src/cli.ts': 'x', 'src/db.ts': 'y' };
    const verdicts = { 1: { verdict: 'unproven' as const, verifier_note: 'src/db.ts was not shown' } };

    const unguarded = applyVerdicts([f], verdicts);
    assert.equal(unguarded[0].verifier_dropped, true, 'the prose alone would have dropped it');

    const guarded = applyVerdicts([f], verdicts, ctx([], ['src/cli.ts']), contents);
    assert.equal(guarded[0].verdict, 'unshown');
    assert.equal(guarded[0].verifier_dropped, undefined);
  });

  test('a refutation must quote text that was actually sent', () => {
    // The route this closes: ticket text is attacker-writable and reaches this pass, so an
    // instruction planted there could produce a `refuted` verdict with invented quoted
    // lines about a file that WAS sent — which wasShown cannot catch, and `refuted` is the
    // one verdict that deletes a BUG outright.
    const f = finding({ severity: 'BUG', file: 'src/a.ts' });
    const shownCode = ctx(['src/a.ts']);
    const real = { ...shownCode, text: 'function parse(row) {\n  if (!row) return null;\n}' };

    const invented = applyVerdicts([f], { 1: { verdict: 'refuted', verifier_evidence: ['if (row === undefined) throw new Error("never written");'], verifier_note: 'n' } }, real, {});
    assert.equal(invented[0].verdict, 'unproven');
    assert.equal(invented[0].verifier_dropped, undefined, 'the BUG survives');

    const genuine = applyVerdicts([f], { 1: { verdict: 'refuted', verifier_evidence: ['if (!row) return null;'], verifier_note: 'the guard is there' } }, real, {});
    assert.equal(genuine[0].verdict, 'refuted');
    assert.equal(genuine[0].verifier_dropped, true, 'a real refutation still drops');
  });

  test('quotesShownText ignores whitespace and refuses a quote too short to mean anything', () => {
    const hay = 'const x = 1;\n    if (!row)   return null;';
    assert.equal(quotesShownText(['if (!row) return null;'], hay), true, 're-indentation must not fail an honest quote');
    assert.equal(quotesShownText(['not in there at all, definitely'], hay), false);
    assert.equal(quotesShownText([';'], hay), false, 'a fragment that matches anything proves nothing');
    assert.equal(quotesShownText([], hay), false);
  });

  test('the quote check haystack is the CODE, never the ticket text', () => {
    const out: { shown?: Set<string>; code?: string } = {};
    buildVerifyPrompt({ diff: 'DIFF-MARKER', prTitle: 'T', docs: 'PLANTED-TICKET-MARKER', findings: [finding({ title: '(ticket) x' })] }, out);
    assert.match(out.code!, /DIFF-MARKER/);
    assert.doesNotMatch(out.code!, /PLANTED-TICKET-MARKER/, 'a haystack containing attacker text would accept the attacker\'s own quotes');
  });

  test('a refutation of code that was never sent is corrected too', () => {
    const f = finding({ severity: 'BUG', file: 'src/gone.ts' });
    const out = applyVerdicts([f], { 1: { verdict: 'refuted', verifier_evidence: ['line'], verifier_note: 'n' } }, ctx(['src/a.ts']), {});
    assert.equal(out[0].verdict, 'unshown');
    assert.equal(out[0].verifier_dropped, undefined);
  });

  test('a finding whose files WERE all shown keeps the verdict it was given', () => {
    const f = finding({ severity: 'SUGGESTION', file: 'src/cli.ts', body: 'see src/db.ts' });
    const out = applyVerdicts([f], { 1: { verdict: 'unproven', verifier_note: 'read it; not a defect' } }, ctx(['src/cli.ts', 'src/db.ts']), { 'src/cli.ts': 'x', 'src/db.ts': 'y' });
    assert.equal(out[0].verdict, 'unproven');
    assert.equal(out[0].verifier_dropped, true, 'this is the drop the pass exists to make');
  });

  test('wasShown counts the diff as shown, and ignores a path that names nothing', () => {
    assert.equal(wasShown(finding({ file: 'src/a.ts' }), ctx([], ['src/a.ts'])), true);
    // "config.yaml" resolves to no file in this change, so it is prose, not a dependency.
    assert.equal(wasShown(finding({ file: 'src/a.ts', body: 'unlike config.yaml' }), ctx(['src/a.ts']), { 'src/a.ts': 'x' }), true);
  });

  test('diffFiles reads both sides of a unified diff', () => {
    const d = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
    assert.deepEqual([...diffFiles(d)].sort(), ['src/a.ts']);
    assert.deepEqual([...diffFiles('diff --git a/x b/y\n--- a/old.ts\n+++ b/new.ts\n')].sort(), ['new.ts', 'old.ts']);
  });
});
