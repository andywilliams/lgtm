import { describe, it } from "node:test";
import assert from "node:assert";
import { extractJsonObject } from "./review.js";

// Guards the resilient JSON extraction that stops a malformed/truncated model
// response from killing an entire review (the recurring "Failed to parse" bug).
describe("extractJsonObject", () => {
  it("parses clean JSON", () => {
    const r = extractJsonObject('{"summary":"ok","comments":[{"file":"a.js"}]}');
    assert.strictEqual(r.summary, "ok");
    assert.strictEqual(r.comments.length, 1);
  });

  it("recovers a response truncated mid-string (the recurring failure)", () => {
    const r = extractJsonObject('{"summary":"ok","comments":[{"file":"a.js","body":"cut off her');
    assert.ok(r);
    assert.strictEqual(r.summary, "ok");
    assert.ok(Array.isArray(r.comments));
  });

  it("ignores prose around the object", () => {
    const r = extractJsonObject('Here is the review:\n{"summary":"ok","comments":[]}\nThanks!');
    assert.strictEqual(r.summary, "ok");
    assert.strictEqual(r.comments.length, 0);
  });

  it("extracts from a fenced json block", () => {
    const r = extractJsonObject('```json\n{"summary":"ok","comments":[]}\n```');
    assert.strictEqual(r.summary, "ok");
  });

  it("is not confused by braces inside strings", () => {
    const r = extractJsonObject('{"summary":"use { and } carefully","comments":[]}');
    assert.strictEqual(r.summary, "use { and } carefully");
  });

  it("returns null on genuine garbage (honest failure)", () => {
    assert.strictEqual(extractJsonObject("no json here at all"), null);
  });
});
