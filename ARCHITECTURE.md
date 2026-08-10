---
title: lgtm — architecture charter
---

# lgtm — architecture charter

## Purpose & scope boundary
lgtm is a single-operator, human-in-the-loop AI PR-review CLI: it fetches a GitHub PR (or diffs the local working tree), has an LLM CLI produce findings, and keeps the human in charge of what actually gets posted *(inferred from: package.json description "AI-powered PR review CLI — you stay in control"; README)*. A second, unattended posture exists for agents and CI: `--agent`/`--auto`/`--batch` emit findings as JSON without prompting, and a GitHub Actions recipe runs it on every PR push *(inferred from: PR titles #9, #11, #24; README "GitHub Actions Mode")*.

**Not for:**
- A hosted service or GitHub App. Only a CLI binary ships (`bin: {"lgtm": "dist/cli.js"}`); the App exists solely as design docs *(inferred from: package.json `bin`; docs/ARCHITECTURE-GITHUB-APP.md and docs/IMPLEMENTATION-TICKETS.md with no server code under src/)*.
- Knowledge-base content. Engineering handbooks live in an external "second brain"; this repo only *fetches* that context through pluggable providers and must keep working without one *(inferred from: src/brain.ts header comment)*.
- DWLF production code. lgtm is standalone local tooling consumed *by* the DWLF workflow, not part of its deploy cascade or code-freeze *(inferred from: engineering handbook "Conventions & deploy")*.

## Interfaces & dependencies
**Exposes**
- The `lgtm` global CLI (`dist/cli.js`), commands: `review [pr]` (incl. `--local` working-tree mode), `recheck`, `retry`, `tag`, `report`, `quiz` *(inferred from: package.json `bin`; command registrations in src/cli.ts)*. Consumers: the operator interactively; coding agents and CI via `--agent`/`--auto`/`--batch` (JSON findings, no prompts) *(inferred from: PR titles #8, #11; the DWLF workflow's `lgtm review <PR#> --agent` in CLAUDE.md)*.
- Local data: a review log in SQLite at `~/.lgtm/reviews.db` (src/db.ts) and metrics/false-negative data in cwd-relative `data/reviews.json` (src/metrics/reviewLogger.js).

**Depends on**
- GitHub CLI `gh`, authenticated, for PR fetch and comment posting *(inferred from: README prerequisites; src/github.ts)*.
- An AI CLI on PATH — `claude` (preferred) or `codex`, auto-detected; Action mode supplies `ANTHROPIC_API_KEY` instead *(inferred from: README prerequisites and workflow snippet)*.
- `git` for repo resolution and `--local` base-ref diffs *(inferred from: src/git.ts; PR titles #20, #25)*.
- Optionally, a second brain via env — `LGTM_BRAIN_CMD` → `LGTM_BRAIN_URL` → `LGTM_BRAIN_DIR`, tried in that order, first provider that yields anything wins *(inferred from: src/brain.ts header comment)*.
- npm runtime deps: `commander`, `prompts`, `chalk`, `better-sqlite3`, `jsonrepair` *(inferred from: package.json dependencies)*.

> ❓ TODO confirm: the README Action step runs `npx @andywilliams/lgtm`, but the manifest is named `lgtm-review` at v0.1.0. Is the package published to npm under either name, or is Action mode currently clone-only?

## Invariants
- Brain context can never break a review: no `LGTM_BRAIN_*` env → no-op; any provider failure, timeout, or bad output resolves to `''`; latency is bounded (`TIMEOUT_MS = 2500`, `MAX_ATTEMPTS = 14`). No code path may throw out of `fetchBrainContext` *(inferred from: src/brain.ts header comment and constants)*.
- Non-TTY stdin never hangs: interactive commands guard on `process.stdin.isTTY` and degrade to read-only or fail fast; `--agent`/`--auto`/`--batch` never prompt *(inferred from: PR #24 title)*.
- `--local` reviews never post anything to GitHub *(inferred from: PR #20; handbook "--local … NEVER posts")*.
- Malformed or truncated model JSON is recovered rather than failing the whole review; agent-mode output carries a `recovered` flag when salvage happened *(inferred from: PR titles #22, #23; `jsonrepair` dependency)*.
- Interactive mode posts nothing without per-finding operator approval *(inferred from: README "you decide which comments actually get posted")*.
- The reviewer runs one-shot with no repo access, so it must not assert unverifiable project conventions; convention-dependent findings stay conditional and are capped at SUGGESTION *(inferred from: PR #21 "convention-evidence prompt rule")*.
- Auxiliary inputs are best-effort: a bad or missing `--decided` file warns on stderr and never kills the review *(inferred from: PR #21; handbook)*.

## Standing decisions
- 2026-06-24 — Brain context is optional, pluggable (CMD → URL → DIR), and fully defensive — because reviews must work with zero configuration and a personal knowledge base must never block or break a review *(PR #18; rationale written in the src/brain.ts header)*.
- 2026-07-14 — Added `--decided` (dismissed-findings memory) and `--scope` (intent statement) — because multi-round fix→re-review loops churned on re-raised nitpicks and out-of-scope style flags *(PR #21; handbook rationale)*.
- 2026-07-14 — Added `--local` working-tree review against a base ref — so changes can be reviewed before a PR exists, without ever posting *(PR #20)*.
- 2026-07-23 — Interactive commands are TTY-guarded; non-TTY runs degrade read-only (`review`/`recheck`), keep cache and exit 1 (`retry`), or fail fast before spending an AI call (`quiz`) — because unconditional `prompts()` hung forever on piped/CI stdin *(PR #24)*.
- date unknown — Global install is a real `npm install -g .` (`install-global`), not `npm link` — because nvm Node-version switches break link-based globals *(README installation notes)*.

## Accepted debt
- Two overlapping review-history stores: SQLite at `~/.lgtm/reviews.db` (src/db.ts) and cwd-relative `data/reviews.json` (src/metrics/reviewLogger.js) — the latter is also committed to this repo, and being cwd-relative it lands in whatever directory lgtm runs from *(inferred from: src/db.ts `DB_PATH` vs src/metrics/reviewLogger.js `DATA_DIR`; data/reviews.json in git ls-files)*.
  > ❓ TODO confirm: which review-log store is canonical — is the other legacy to be removed, or do they serve deliberately different purposes?
- `src/metrics/*.js` are plain JS in an otherwise TypeScript codebase, and reviewLogger.js contains TypeScript-only syntax (`export interface`) inside a `.js` file *(inferred from: file tree; src/metrics/reviewLogger.js head)*.
- Tests cover only parsing and context expansion (`contextExpander.test.ts`, `github.test.ts`, `review.parse.test.ts`); CLI orchestration, the brain providers, and the db layer are untested *(inferred from: the test files present in the tree)*.

## Org context
- Single owner and effectively single consumer (Andy); developed on the work machine, consumed on the personal one via `git pull` + build *(inferred from: handbook "Two machines" note)*.
- Sits beside, not inside, DWLF: it is the reviewer invoked by the DWLF ship loop but exempt from DWLF freeze/deploy rules *(inferred from: CLAUDE.md; handbook)*. No `system:` link is set in this charter's frontmatter.
  > ❓ TODO confirm: is there a system-level doc (e.g. a DWLF tooling SYSTEM.md) this charter's `system:` field should point at, or is lgtm genuinely standalone?
- Cost posture: interactive/agent runs ride the locally-authenticated AI CLI; Action mode spends `ANTHROPIC_API_KEY` directly on every PR push *(inferred from: README workflow env)*.
- Roadmap pressure: a GitHub App / hosted direction is designed but unbuilt *(inferred from: docs/ARCHITECTURE-GITHUB-APP.md; docs/IMPLEMENTATION-TICKETS.md)*.
  > ❓ TODO confirm: is the GitHub App direction committed roadmap or parked exploration?
