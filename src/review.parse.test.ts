import { describe, it } from "node:test";
import assert from "node:assert";
import { extractJsonObject } from "./review.js";

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
