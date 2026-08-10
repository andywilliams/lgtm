# LGTM

**AI-powered PR review CLI — you stay in control**

LGTM uses Claude to review your pull requests, but unlike automated bots, *you* decide which comments actually get posted. Choose your harshness level, review the AI's suggestions, and post only the ones you agree with.

## Installation

```bash
git clone https://github.com/andywilliams/lgtm.git
cd lgtm
npm install
npm run install-global   # builds and installs `lgtm` globally
```

This runs `npm install -g .`, which is a real global install — it persists across terminal sessions and survives new tabs (unlike `npm link`, which can break when switching Node versions via nvm).

To update after pulling changes, just re-run `npm run install-global`. To remove it, run `npm run uninstall-global`.

### For active development

If you're iterating on the tool itself and don't want to rebuild after every change, use `npm run dev -- <args>` (runs from source via `tsx`), or `npm link` for a live-symlinked global binary.

## Prerequisites

- **Node.js 18+**
- **GitHub CLI (`gh`)** — installed and authenticated ([install](https://cli.github.com/))
- **One of the following AI CLIs:**

  **Claude Code CLI** (recommended)
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login
  ```

  **Codex CLI** (alternative)
  ```bash
  npm install -g @openai/codex
  ```

LGTM auto-detects which CLI is available. If both are installed, it prefers Claude.

## GitHub Actions Mode

LGTM can run automatically as a GitHub Action, posting review comments on every PR push. This replaces tools like Cursor Bugbot with a fully automated review workflow.

### Setup

1. **Add the workflow file** to your repository at `.github/workflows/lgtm-review.yml`:

```yaml
name: lgtm PR Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
      
      - name: Run lgtm review
        run: npx @andywilliams/lgtm review ${{ github.event.pull_request.number }} --batch --related-files
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

2. **Add your Anthropic API key** as a repository secret:
   - Go to Settings → Secrets and variables → Actions
   - Add `ANTHROPIC_API_KEY` with your key from https://console.anthropic.com/

3. **Grant workflow permissions** (if not already enabled):
   - Go to Settings → Actions → General
   - Under "Workflow permissions", select "Read and write permissions"

### Features

- **Automatic reviews** — Runs on every PR open/update
- **Inline review threads** — Comments are grouped in a single review
- **Context expansion** — Auto-discovers related files (imports, infra, config)
- **Deduplication** — Won't re-post the same comment twice
- **Batch mode** — Posts all findings without human approval (CI-friendly)

### Customization

**Full review** (default — expanded context, thorough):
```yaml
run: npx @andywilliams/lgtm review ${{ github.event.pull_request.number }} --batch --related-files
```

**Quick review** (diff only, faster, uses fewer tokens):
```yaml
run: npx @andywilliams/lgtm review ${{ github.event.pull_request.number }} --batch
```

**Adjust harshness level:**
```yaml
run: npx @andywilliams/lgtm review ${{ github.event.pull_request.number }} --batch --related-files --harshness pedantic
```

**Add usage context** (finds code that calls changed functions):
```yaml
run: npx @andywilliams/lgtm review ${{ github.event.pull_request.number }} --batch --related-files --usage-context
```

## CLI Usage

```bash
# Quick review — diff only, fast (default)
lgtm review 86

# Full review — expanded context for thorough analysis (recommended for important PRs)
lgtm review 86 --max-context

# Specify repository
lgtm review 86 --repo owner/repo

# Set harshness level
lgtm review 86 --harshness pedantic

# Choose AI provider (auto-detects by default)
lgtm review 86 --ai claude
lgtm review 86 --ai codex

# Dry run (preview without posting)
lgtm review 86 --dry-run

# Batch mode (post all without prompting)
lgtm review 86 --batch

# Auto mode (non-interactive, JSON output — designed for agents/scripts)
lgtm review 86 --auto

# Agent mode (max context, read-only, returns ALL findings as JSON — never posts)
lgtm review 86 --agent

# Full context mode (include entire modified files for pattern analysis)
lgtm review 86 --full-context

# Usage context mode (include files that use changed symbols)
lgtm review 86 --usage-context

# Related files mode (auto-discover imports, callers, tests, infra)
lgtm review 86 --related-files

# Max context — shorthand for all three of the above
lgtm review 86 --max-context

# Recheck if existing comments are still valid after new commits
lgtm recheck 86

# Recheck and auto-resolve outdated comments
lgtm recheck 86 --batch

# Quiz yourself on a PR before approving
lgtm quiz 86

# Quiz with more questions
lgtm quiz 86 --questions 8
```

## AI Providers

LGTM supports multiple AI backends:

| Provider | CLI | Notes |
|----------|-----|-------|
| `claude` | `@anthropic-ai/claude-code` | Default if available. Uses `claude --print`. |
| `codex` | `@openai/codex` | Fallback. Uses `codex exec`. |

Use `--ai <provider>` to force a specific backend, or let LGTM auto-detect.

## Full Context Mode

By default, LGTM only sends the PR diff to the AI. This is fast but can miss pattern violations — cases where new code doesn't follow established patterns in the file.

Use `--full-context` to include the entire contents of modified files:

```bash
lgtm review 86 --full-context
```

This enables the AI to:
- Detect missing integrations (e.g., new state not synced with existing preference system)
- Flag inconsistencies with existing code patterns
- Catch registration omissions (new items not added to arrays/maps where similar items are registered)

Trade-off: Slower and uses more tokens, but catches more subtle issues.

**Real example:** On a PR adding a new toggle to a React component, `--full-context` caught a missing useEffect dependency that Cursor's Bugbot missed. Bugbot found the toggle wasn't being *saved* to preferences; lgtm found it also wasn't properly listed in the *loading* effect's dependency array.

## Usage Context Mode

By default, the AI only sees the files being changed. But what about code that *uses* the changed code? A function signature change might break callers in other files.

Use `--usage-context` to find and include usages of changed symbols:

```bash
lgtm review 86 --usage-context
```

This:
1. **Parses the diff** for changed symbols (functions, classes, exports)
2. **Searches the codebase** with ripgrep for usages
3. **Includes snippets** (~3 lines of context around each usage)
4. **Limits scope** to 5 usages per symbol to avoid token explosion

The AI then checks if the PR changes might break any of these usages:
- Breaking changes to function signatures
- Type changes that affect callers
- Missing updates to consumers of changed APIs

**Combine with `--full-context`** for maximum visibility:

```bash
lgtm review 86 --full-context --usage-context
```

This gives the AI both the full modified files (for pattern analysis) and external usages (for breaking change detection).

## Handbook Context (optional)

LGTM can enrich a review with domain knowledge about the repo being reviewed — known design constraints, gotchas, how the service is built, **and the related systems it touches** — pulled from an engineering "second-brain" knowledge base. This grounds the review in *why* the codebase is the way it is, not just the diff.

The contract is deliberately tiny: **given a repo name, a "brain" returns markdown context.** LGTM ships three pluggable providers, tried in priority order — set any one:

```bash
# 1. Any command that prints context to stdout — the escape hatch for ANY brain,
#    on any machine. Gets the repo as $LGTM_BRAIN_REPO and as the final argument.
export LGTM_BRAIN_CMD="my-brain context"        # runs: my-brain context <repo>

# 2. A second-brain HTTP API (pulls the handbook + its graph neighbours)
export LGTM_BRAIN_URL="http://localhost:3101"

# 3. A second-brain vault on disk (works with the server off)
export LGTM_BRAIN_DIR="$HOME/development/tools/second-brain/vault"
```

For the built-in URL/DIR providers, LGTM looks for a note named `<repo>-handbook` (e.g. `em-transactions-api` → `em-transactions-api-handbook`) and **follows the knowledge graph one hop** — pulling in condensed handbooks for related systems (relations + backlinks; e.g. a change in `em-transactions-api` brings in `em-cis`, `em-budgets-api`). The `LGTM_BRAIN_CMD` provider lets a *different* brain implementation do its own lookup/navigation however it likes.

It's best-effort and **off by default**: if nothing is configured, no handbook matches, or a lookup fails (server down, timeout), the review proceeds exactly as normal. When it kicks in you'll see `📖 Loaded engineering handbook context` and `handbook` in the mode line.

> Don't have a brain configured? You can ignore this entirely — it changes nothing about how LGTM works for you.

## Architecture Review (`lgtm arch`)

A second review altitude. `lgtm review` asks *"is this code correct?"* — `lgtm arch` asks *"was this the right thing to build, built in the right place, and what does it cost us later?"* It's a rarer, heavier review: run it against a draft PR or a branch while the decision is still cheap to change, not as a merge gate. Full design rationale: [docs/ARCHITECTURE-REVIEW.md](docs/ARCHITECTURE-REVIEW.md).

```bash
# Architecture-review a PR — offers to post ONE summary comment (never inline)
lgtm arch 42

# Read-only JSON for agents (never posts)
lgtm arch 42 --agent

# Review the working tree before a PR exists
lgtm arch --local --base main

# Infer a draft ARCHITECTURE.md for an EXISTING repo — every claim marked with
# its evidence, unknowns become "❓ TODO confirm" questions, you correct it
lgtm arch init

# Design a NEW repo's ARCHITECTURE.md by interview, BEFORE any code — one
# question at a time, then draft → critique → your responses folded back in
lgtm arch new
lgtm arch new --system ../my-system --answers rehearsal.json   # scripted run
```

Output is up to **5 ranked decision records** — the fork taken, its evidence, reversibility (`cheap` / `costly` / `one-way door`), ramifications, what would make the finding wrong, and a question for the author. **"No decisions" is a normal, common outcome** — most changes aren't architectural, and the tool is built not to manufacture significance.

Every finding declares which rung of the **authority ladder** it stands on, printed in the output:

| Authority | Grounded in | May say |
|---|---|---|
| `charter` | A cited line of your ARCHITECTURE.md / SYSTEM.md | "This contradicts X" — assertive |
| `codebase-pattern` | A counted fact ("6 of 7 handlers do X") | The divergence, with the count |
| `diff-evidence` | The change itself; the consequence is deduced | Evidence assertively, consequence as a question |
| `judgement` | Generic engineering opinion | Questions only — never "violates" |

### The charter: `ARCHITECTURE.md`

The normative document that lets findings climb above `judgement`: what the repo is for, what must **not** live in it, its interfaces, invariants, standing decisions (with rationale), and accepted debt. LGTM looks for it at `ARCHITECTURE.md`, then `docs/ARCHITECTURE.md`, then `.lgtm/ARCHITECTURE.md`. Bootstrap one with `lgtm arch init` (existing repo) or `lgtm arch new` (repo that doesn't exist yet).

**Charter evolution is deliberately manual** — the tools write drafts for you to correct and commit; no review ever edits a charter behind your back. Only three things are parsed by code (the filename search order, and the `title:` / `system:` frontmatter fields) — everything else in the file is prose read by the reviewer, so you can shape it freely.

**One conformance check in normal reviews:** when the repo has a charter, `lgtm review` gets it as context and may raise at most one `(charter)`-prefixed SUGGESTION if a diff contradicts a stated invariant/boundary, or changes a documented responsibility without updating the charter in the same diff. Turn it off with `--no-charter`.

### The level above the repo: `SYSTEM.md`

Cross-repo architecture lives in a small system doc — the repos, one-line responsibilities, and the **contracts** between them (who talks to whom, via what, who owns the schema). Keep it in its own repo checked out next to the others, and point each charter at it via frontmatter:

```yaml
---
title: my-repo — architecture charter
system: ../my-system        # local path to the system repo (or set LGTM_SYSTEM_DIR)
---
```

With a system doc resolved, `arch` also judges **placement** (does this work belong in this repo?) and **contract coherence** (does the change alter an edge another repo depends on?), and `arch new` checks a proposed repo for overlap with existing responsibilities — then proposes the SYSTEM.md addition (new node + edges) for you to land deliberately, ideally via a PR on the system repo. Remote URLs aren't fetched yet; use a local checkout.

If a repo has no charter file, the URL/DIR brain providers are tried for a `<repo>-charter` note as a fallback (the `LGTM_BRAIN_CMD` provider is deliberately not used here — its contract answers the *handbook* question, and feeding arbitrary command output in as a *normative* charter is how a review ends up arguing from junk). No charter anywhere? The review still runs and honestly reports `charter-grounded checks` in `skipped_checks`.

## Retrying Failed Uploads

If the GitHub upload fails after you've selected comments, LGTM saves them locally so you don't lose your work:

```bash
# List all pending (unsent) reviews
lgtm retry

# Retry a specific PR (uses current repo)
lgtm retry 220

# Retry with explicit repo
lgtm retry 220 -r owner/repo
```

The cache lives at `~/.lgtm/pending/`. On a successful upload it's automatically deleted. If the retry also fails, the cache is kept so you can try again later.

## Rechecking Existing Comments

After a PR author pushes new commits, previous review comments may no longer apply. Use `recheck` to evaluate whether existing comments are still valid:

```bash
# Recheck all review comments on a PR (interactive mode)
lgtm recheck 86

# Only recheck comments from a specific author
lgtm recheck 86 --author my-bot-username

# Dry run (see results without resolving anything)
lgtm recheck 86 --dry-run

# Batch mode (auto-resolve all outdated/resolved comments)
lgtm recheck 86 --batch

# Specify repo or AI provider
lgtm recheck 86 --repo owner/repo --ai claude
```

The AI evaluates each comment against the current diff and classifies it as:

| Status | Meaning |
|--------|---------|
| **still valid** | The issue raised by the comment is still present |
| **resolved** | The code was updated to address the concern |
| **outdated** | The code the comment refers to no longer exists |

In interactive mode, you're prompted to **Resolve**, **Keep**, or **Quit** for each resolved/outdated comment. Resolving a comment minimizes (collapses) it on GitHub — it's not deleted, just hidden behind a "Show resolved" toggle.

### Example

```
$ lgtm recheck 86

🔍 Fetching PR #86...
   "fix: handle edge case in parser" by andywilliams

💬 Fetching review comments...
   Found 3 review comment(s)

📄 Fetching current diff...

🤖 Rechecking comments with Claude...

2 of 3 comments appear resolved.

────────────────────────────────────────────────────────────
[1/3] ⚠ STILL VALID | src/parser.ts:42
────────────────────────────────────────────────────────────
Missing null check for input parameter...

Reason: The null check is still missing on line 42.

────────────────────────────────────────────────────────────
[2/3] ✓ RESOLVED | src/parser.ts:87
────────────────────────────────────────────────────────────
Consider extracting magic number...

Reason: The magic number 1024 has been replaced with MAX_BUFFER_SIZE constant.

? Action › Resolve (minimize comment) / Keep / Quit
✓ Queued for resolution

════════════════════════════════════════════════════════════
Summary: 1 still valid, 1 to resolve, 1 kept
════════════════════════════════════════════════════════════

? Resolve (minimize) 1 comment(s) on PR #86? › Yes

📤 Resolving comments...
✓ Resolved 1 comment(s)
```

## Quiz Mode

Test your understanding of a PR before approving it. The AI generates multiple-choice questions about what the PR changes, why, how, and what could go wrong — helping ensure you actually understand the code you're approving.

```bash
# Take a 5-question quiz on a PR
lgtm quiz 86

# Specify number of questions (1–10)
lgtm quiz 86 --questions 8

# Specify repo or AI provider
lgtm quiz 86 --repo owner/repo --ai claude
```

### Example

```
$ lgtm quiz 86

🔍 Fetching PR #86...
   "fix: handle edge case in parser" by andywilliams
   3 files, +45/-12

📄 Fetching diff...

🧠 Generating quiz with Claude...

📝 PR Comprehension Quiz: "fix: handle edge case in parser"

Answer 5 questions to test your understanding.

────────────────────────────────────────────────────────────
Question 1/5
What is the primary purpose of this PR?

? Your answer › A) Add a new parser module
                B) Fix a null pointer crash when input is empty
                C) Refactor the parser for performance
                D) Add unit tests for the parser

  ✓ Correct!
  The PR fixes a crash that occurred when the parser received
  empty input, by adding a guard clause at line 42.

...

════════════════════════════════════════════════════════════

  Result: 4/5 (80%)

  👍 Great job — you understand this PR well.
```

### Scoring

| Score | Verdict |
|-------|---------|
| 100% | Perfect — you have a strong understanding of this PR |
| 80%+ | Great job — you understand this PR well |
| 60%+ | Consider re-reading the parts you missed before approving |
| Below 60% | Spend more time reviewing this PR before approving |

## Auto Mode (Non-Interactive)

Use `--auto` for fully non-interactive operation, designed for agents, scripts, and CI pipelines that need to parse the output programmatically.

```bash
# Run a review and get JSON output
lgtm review 86 --auto

# Combine with other flags
lgtm review 86 --auto --harshness pedantic --related-files
lgtm review 86 --auto --repo owner/repo

# Dry run in auto mode (review without posting, still get JSON)
lgtm review 86 --auto --dry-run
```

### Behavior

- **Implies `--batch`** — all comments are posted without prompting
- **JSON output** — a single JSON object is printed to stdout (no decorative output)
- **Machine-friendly exit codes** — `0` on success, `1` on error

### JSON Output Format

On success:
```json
{
  "success": true,
  "summary": "Found 2 issues: 1 bug, 1 suggestion",
  "dryRun": false,
  "commentsPosted": 2,
  "duplicatesSkipped": 0,
  "comments": [
    {
      "file": "src/parser.ts",
      "line": 42,
      "severity": "BUG",
      "title": "Missing null check",
      "body": "The input parameter could be undefined...",
      "suggestion": "if (!input) return null;"
    }
  ]
}
```

On error:
```json
{
  "success": false,
  "summary": "",
  "dryRun": false,
  "commentsPosted": 0,
  "duplicatesSkipped": 0,
  "comments": [],
  "error": "GitHub CLI error: ..."
}
```

When no issues are found:
```json
{
  "success": true,
  "summary": "LGTM — no issues found",
  "dryRun": false,
  "commentsPosted": 0,
  "duplicatesSkipped": 0,
  "comments": []
}
```

### Agent Integration Example

```bash
# Use in a script that processes the output
result=$(lgtm review 86 --auto --repo owner/repo 2>/dev/null)
posted=$(echo "$result" | jq '.commentsPosted')
echo "Posted $posted comments"

# Use with dry-run to inspect without posting
lgtm review 86 --auto --dry-run | jq '.comments[] | {file, line, severity, title}'
```

## Agent Mode

`--agent` is a single flag for agents that want to **run a full-power review and consume the results themselves** rather than have LGTM post to GitHub. It's built for the case where an autonomous coding agent reviews its own (or another) PR, reads every finding, and decides what to do next.

```bash
lgtm review 86 --agent
```

It bundles three behaviors:

- **Max context, always** — implies `--max-context` (full file contents + symbol usages + related files), so the AI sees as much as possible.
- **Read-only** — it **never** posts comments and never writes to the PR. `posted` is always `false`.
- **All findings returned** — every finding the review produced is emitted as JSON. Findings that duplicate a comment already on the PR are **flagged** (`"duplicate": true`), not dropped — so the agent gets the complete picture.

### `--agent` vs `--auto`

| | `--auto` | `--agent` |
|---|---|---|
| Output | JSON | JSON |
| Context | whatever flags you pass | always max context |
| Posts to GitHub | **yes** (implies `--batch`) | **no, ever** |
| Duplicate findings | dropped from output | included, flagged `duplicate: true` |
| Use case | automated reviewer (CI bot) | agent that acts on the results itself |

If you want an agent to post, use `--auto`. If you want an agent to *read everything and decide*, use `--agent`.

### JSON Output Format

```json
{
  "success": true,
  "mode": "agent",
  "summary": "Found 2 issues: 1 bug, 1 suggestion",
  "posted": false,
  "commentsFound": 2,
  "duplicates": 1,
  "comments": [
    {
      "file": "src/parser.ts",
      "line": 42,
      "severity": "BUG",
      "title": "Missing null check",
      "body": "The input parameter could be undefined...",
      "suggestion": "if (!input) return null;",
      "duplicate": false
    },
    {
      "file": "src/parser.ts",
      "line": 87,
      "severity": "SUGGESTION",
      "title": "Extract magic number",
      "body": "The value 1024 appears without explanation...",
      "duplicate": true
    }
  ],
  "context": {
    "maxContext": true,
    "relatedFiles": [
      { "path": "src/lexer.ts", "reason": "imported by src/parser.ts" }
    ],
    "tokenEstimate": 12188
  }
}
```

On error (e.g. AI/CLI failure, invalid input), the same shape is returned with `success: false`, an `error` string, and an empty `comments` array. Exit code is `0` on success, `1` on error.

### Agent Integration Example

```bash
# Get every finding, including ones already commented on, and act on the new ones
result=$(lgtm review 86 --agent 2>/dev/null)
echo "$result" | jq '.comments[] | select(.duplicate == false) | {file, line, severity, title}'

# Count actionable (non-duplicate) bugs
echo "$result" | jq '[.comments[] | select(.duplicate == false and .severity == "BUG")] | length'
```

> **Note:** Because agent mode always runs with max context, the AI response is large. The underlying review CLI occasionally returns malformed JSON on very large responses; when that happens you'll get `success: false` with an `error` — retry, or fall back to a lighter context mode.

## Harshness Levels

### `chill`
Only flags real problems:
- Bugs that will cause runtime errors
- Security vulnerabilities
- Breaking API changes

### `medium` (default)
Bugs plus code quality:
- Everything from `chill`
- Potential null/undefined issues
- Missing error handling
- Confusing code patterns

### `pedantic`
Full nitpick mode:
- Everything from `medium`
- Style suggestions
- Naming improvements
- Documentation gaps
- "Consider this approach..." suggestions

## Interactive Flow

```
$ lgtm review 86

🔍 Fetching PR #86...
   "fix: handle edge case in parser" by andywilliams
   3 files, +45/-12

📄 Fetching diff...

🤖 Reviewing with Claude (medium mode)...

Found 2 potential comment(s):

────────────────────────────────────────────────────────────
[1/2] 🐛 BUG | src/parser.ts:42
────────────────────────────────────────────────────────────
Missing null check

The `input` parameter could be undefined if called without
arguments, causing a runtime error on line 43.

Suggested fix:
if (!input) return null;

? Action › Add / Skip / Quit
✓ Queued

────────────────────────────────────────────────────────────
[2/2] 💡 SUGGESTION | src/parser.ts:87
────────────────────────────────────────────────────────────
Consider extracting magic number

The value `1024` appears without explanation. Consider
extracting to a named constant.

? Action › Add / Skip / Quit
⊘ Skipped

════════════════════════════════════════════════════════════
Summary: 1 to post, 1 skipped
════════════════════════════════════════════════════════════

? Post 1 comment(s) to PR #86? › Yes

📤 Posting review...
✓ Posted 1 comment(s)
```

## Why LGTM?

- **You're the gatekeeper** — AI suggests, you decide
- **Configurable harshness** — match the review depth to the PR importance  
- **Interactive** — review each suggestion before posting
- **Uses `gh` CLI** — works with your existing GitHub auth
- **Uses `claude` CLI** — works with your existing Claude login, no API key config needed
- **Transparent** — you see exactly what will be posted
- **Recheck** — verify old comments are still relevant after new commits

## License

MIT

---

> Why do programmers prefer dark mode?
>
> Because light attracts bugs.

**Why is this funny?** This joke works on two levels. In the real world, insects (bugs) are attracted to light sources — that's just nature. In programming, "bugs" are errors in code. So preferring "dark mode" becomes a tongue-in-cheek way of saying programmers want to avoid bugs in their code. The humor comes from this double meaning bridging the natural world and software development. 🐛
