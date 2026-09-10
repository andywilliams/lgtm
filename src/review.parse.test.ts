import { describe, it } from "node:test";
import assert from "node:assert";
import { extractJsonObject, parseReviewForTest, citedDocument } from "./review.js";

// Guards the resilient JSON extraction that stops a malformed/truncated model
// response from killing an entire review (the recurring "Failed to parse" bug),
// and the `recovered` flag that tells a driving agent the result was salvaged.
describe("extractJsonObject", () => {
  it("parses clean JSON (not flagged as recovered)", () => {
    const { value: r, recovered } = extractJsonObject('{"summary":"ok","comments":[{"file":"a.js"}]}');
    assert.ok(r);
    assert.strictEqual(r.summary, "ok");
    assert.strictEqual(r.comments.length, 1);
    assert.strictEqual(recovered, false);
  });

  it("recovers a response truncated mid-string and flags recovered=true", () => {
    const { value: r, recovered } = extractJsonObject('{"summary":"ok","comments":[{"file":"a.js","body":"cut off her');
    assert.ok(r);
    assert.strictEqual(r.summary, "ok");
    // the partially-recovered finding must SURVIVE repair, not be silently dropped
    assert.strictEqual(r.comments.length, 1);
    assert.strictEqual(r.comments[0].file, "a.js");
    // ...and the caller must be told the result was salvaged (may be partial)
    assert.strictEqual(recovered, true);
  });

  it("ignores prose around the object", () => {
    const { value: r, recovered } = extractJsonObject('Here is the review:\n{"summary":"ok","comments":[]}\nThanks!');
    assert.strictEqual(r.summary, "ok");
    assert.strictEqual(r.comments.length, 0);
    assert.strictEqual(recovered, false);
  });

  it("extracts from a fenced json block", () => {
    const { value: r } = extractJsonObject('```json\n{"summary":"ok","comments":[]}\n```');
    assert.strictEqual(r.summary, "ok");
  });

  it("is not confused by braces inside strings", () => {
    const { value: r } = extractJsonObject('{"summary":"use { and } carefully","comments":[]}');
    assert.strictEqual(r.summary, "use { and } carefully");
  });

  it("returns null on genuine garbage (honest failure, not flagged recovered)", () => {
    const { value, recovered } = extractJsonObject("no json here at all");
    assert.strictEqual(value, null);
    assert.strictEqual(recovered, false);
  });
});

// ---- prompt v2 (DWLF-208) --------------------------------------------------------
describe('prompt v2 finding fields', () => {

it('prompt v2: kind, confidence, evidence and fingerprint survive parsing, with safe defaults', () => {
  const r = parseReviewForTest(JSON.stringify({
    summary: 's',
    comments: [
      { file: 'a.ts', line: 3, severity: 'BUG', kind: 'removed', confidence: 'high', title: 'Guard deleted',
        body: 'b', evidence: ['-  if (!x) return;'], how_to_verify: 'call with null', fingerprint: 'parseRow' },
      { file: 'b.ts', line: 9, severity: 'SUGGESTION', title: 'Old shape' }, // pre-v2 / codex
      { file: 'c.ts', line: 1, severity: 'BUG', kind: 'missing', confidence: 'high', title: 'No reader updated', body: 'b', evidence: [] },
      { file: 'd.ts', line: 1, severity: 'BUG', kind: 'nonsense', confidence: 'certain', title: 'x', body: 'b' },
    ],
  })).comments;

  assert.equal(r[0].kind, 'removed');
  assert.equal(r[0].confidence, 'high');
  assert.deepEqual(r[0].evidence, ['-  if (!x) return;']);
  assert.equal(r[0].fingerprint, 'parseRow');

  assert.equal(r[1].kind, 'added', 'an unlabelled finding is about added code, as every finding was before v2');
  assert.equal(r[1].confidence, 'medium');
  assert.deepEqual(r[1].evidence, []);

  assert.equal(r[2].confidence, 'medium', 'high confidence is earned by evidence, not claimed');
  assert.equal(r[3].kind, 'added', 'an unknown kind falls back');
  assert.equal(r[3].confidence, 'medium', 'an unknown confidence falls back');
});
});


describe("citedDocument", () => {
  it("takes the title prefix when there is one, else the declared field, and normalises both spellings", () => {
    assert.equal(citedDocument({ cites: "ticket", title: "anything at all" }), "ticket", "the field covers a finding with no prefix");
    assert.equal(citedDocument({ cites: "standards", title: "x" }), "standard", "either spelling of the middle one");
    assert.equal(citedDocument({ cites: "STANDARD", title: "x" }), "standard");
    assert.equal(citedDocument({ title: "(standard FUN-1) too long" }), "standard", "the prefix still works for codex");
    assert.equal(citedDocument({ title: "(charter) drifted" }), "charter");
    assert.equal(citedDocument({ cites: "nonsense", title: "(ticket) x" }), "ticket", "a junk field falls through to the prefix");
    // The reader sees "(charter)"; the filter must not be acting on the ticket's slot.
    assert.equal(citedDocument({ cites: "ticket", title: "(charter) drifted" }), "charter", "on disagreement, what is SHOWN wins");
    assert.equal(citedDocument({ title: "(out of scope) x" }), undefined);
    assert.equal(citedDocument({}), undefined);
  });

  it("a cites value naming an inherited property is not a document", () => {
    // `cites` is not schema-constrained on the normal path (the schema is a retry tool, and
    // codex never gets one), so any string arrives here. A bare object index would return
    // Object / Object.prototype for these — truthy, and then bound as a finding column,
    // which throws inside the metrics guard and loses every findings row for the round
    // while the review row survives as one that "raised nothing".
    for (const evil of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      assert.equal(citedDocument({ cites: evil, title: "ordinary" }), undefined, evil);
    }
    const r = parseReviewForTest(JSON.stringify({ summary: "s", comments: [
      { file: "a.ts", line: 1, severity: "SUGGESTION", title: "t", body: "b", cites: "constructor" },
    ] }));
    assert.equal(r.comments[0].cites, undefined);
  });

  it("normalizeComment sets cites from either source, so the verifier reads one field", () => {
    const r = parseReviewForTest(JSON.stringify({ summary: "s", comments: [
      { file: "a.ts", line: 1, severity: "SUGGESTION", title: "Criterion 2 unaddressed", body: "b", cites: "ticket" },
      { file: "a.ts", line: 2, severity: "SUGGESTION", title: "(charter) drifted", body: "b" },
      { file: "a.ts", line: 3, severity: "SUGGESTION", title: "ordinary", body: "b" },
    ] }));
    assert.deepEqual(r.comments.map((c) => c.cites), ["ticket", "charter", undefined]);
  });
});
