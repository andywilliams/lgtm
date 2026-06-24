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

LGTM can enrich a review with domain knowledge about the repo being reviewed — known design constraints, gotchas, how the service is built — pulled from an engineering handbook in a local **second-brain** knowledge vault. This grounds the review in *why* the codebase is the way it is, not just the diff.

This is **off by default** and has no effect unless you point LGTM at a vault. Set one of:

```bash
# Read handbooks straight from the vault on disk (preferred — no server needed)
export LGTM_BRAIN_DIR="$HOME/development/tools/second-brain/vault"

# …or fetch them from the second-brain HTTP API
export LGTM_BRAIN_URL="http://localhost:3101"
```

LGTM looks for a note named `<repo>-handbook` (e.g. `em-transactions-api` → `em-transactions-api-handbook`) and, if found, feeds its body to the model as background context. It's best-effort: if no vault is configured, no handbook matches, or the lookup fails, the review proceeds exactly as normal. You'll see `📖 Loaded engineering handbook context` and `handbook` in the mode line when it kicks in.

> Don't have a second-brain vault? You can ignore this entirely — it changes nothing about how LGTM works for you.

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
