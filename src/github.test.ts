import { describe, it } from "node:test";
import assert from "node:assert";
import { friendlyGhError } from "./github.js";

// Guards the translation of gh's raw "not a git repository" failure — which surfaced as a
// confusing "failed to run git" error — into an actionable "pass --repo / run inside the repo"
// message, without swallowing genuinely different gh errors (auth, PR-not-found, etc.).
describe("friendlyGhError", () => {
  const cmd = "gh pr view 3210 --json number,title";

  it("translates 'not a git repository' when no --repo was given", () => {
    const msg = friendlyGhError(
      "Command failed: gh pr view 3210\nfailed to run git: fatal: not a git repository (or any of the parent directories): .git",
      undefined,
      cmd
    );
    assert.match(msg, /Could not determine which repository/);
    assert.match(msg, /--repo owner\/repo/);
    assert.doesNotMatch(msg, /GitHub CLI error/); // not the raw wrapping
  });

  it("handles the 'no GitHub remote' phrasing too", () => {
    const msg = friendlyGhError(
      "none of the git remotes configured for this repository point to a known GitHub host",
      undefined,
      cmd
    );
    assert.match(msg, /Could not determine which repository/);
  });

  it("keeps the raw error when --repo WAS given (repo resolution isn't the problem)", () => {
    const msg = friendlyGhError("fatal: not a git repository", "EqualsGroup/em-transactions-api", cmd);
    assert.match(msg, /GitHub CLI error/);
    assert.match(msg, /Command: gh pr view 3210/);
  });

  it("falls through for unrelated gh errors (e.g. auth failures)", () => {
    const msg = friendlyGhError("HTTP 401: Bad credentials", undefined, cmd);
    assert.match(msg, /GitHub CLI error/);
    assert.match(msg, /Bad credentials/);
    assert.doesNotMatch(msg, /Could not determine which repository/);
  });
});
