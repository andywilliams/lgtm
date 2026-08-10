# `lgtm arch` — architecture review

A second review altitude. `lgtm review` asks *"is this code correct?"*. `lgtm arch` asks
*"was this the right thing to build, built in the right place, and what does it cost us later?"*

## Why it can't be a harshness level

`lgtm review` emits `{file, line, severity, title, body, suggestion}`. Every finding must anchor to
an added line in the diff. That schema is the ceiling — not the prompt.

The load-bearing facts about a change's architecture frequently have **no line to anchor to**:

- The table created instead of a column added to an existing one
- The abstraction introduced for exactly one caller
- The coupling edge that now exists between two previously-independent components
- The cron job added at 04:30 that races the one at 04:30 already there
- **The place the change should have touched and didn't**

That last class — absence — is invisible to a line-anchored reviewer by construction. `arch` is a
different output type, not a louder prompt.

## Unit of output: the decision record

```jsonc
{
  "id": "new-ranges-table",
  "decision": "Range state persisted in a new RangesTable rather than extending EventsTable",
  "evidence": ["serverless.yml:583-593", "src/handlers/rangeDetection.js:22-58"],
  "rationale_found": "none — the PR description doesn't address the choice",
  "alternatives_not_taken": ["a new event type on EventsTable"],
  "reversibility": "costly",          // cheap | costly | one-way
  "ramifications": [
    "a second write path to keep consistent with events",
    "a new backfill story that doesn't exist yet",
    "consumers must now query two sources to assemble a symbol view"
  ],
  "authority": "codebase-pattern",    // charter | codebase-pattern | judgement
  "confidence": "medium",             // high | medium | low
  "falsifiable_by": "if range rows need in-place updates and EventsTable rows are append-only-immutable, a separate table is correct",
  "ask_the_author": "What made a separate table right here rather than a new event type?"
}
```

The envelope:

```jsonc
{
  "verdict": "decisions-found",       // no-decisions | decisions-found
  "summary": "One paragraph: what this PR commits the system to.",
  "decisions": [ /* ranked, max 5 */ ],
  "skipped_checks": ["org-fit — no org context configured"]
}
```

`ask_the_author` is the highest-value field. A good architecture reviewer mostly asks questions that
are awkward not to have an answer to. The tool is not trying to be right — it's trying to make the
decision **visible and answerable** before it sets.

## The authority ladder

The dominant failure mode of every architecture-review bot is confident, unfalsifiable prose that
invents organisational rules. At this altitude the language is vague enough that the model can always
produce something that *sounds* like principle. Three wrong "this violates our layering convention"
findings and the tool is dead.

So every decision must declare which rung it stands on, and the rung is **printed in the output**:

| `authority` | Grounded in | Allowed to say | Max severity |
|---|---|---|---|
| `charter` | A cited line in the repo's charter / an ADR | "This contradicts X, which says Y" — assertive | blocking |
| `codebase-pattern` | An observed, counted fact: "6 of 7 handlers do X; this doesn't" | "This diverges from the established shape" + the count as evidence | discuss |
| `diff-evidence` | The change itself; the *consequence* is deduced from it | State the evidence assertively, phrase the consequence as a question | discuss |
| `judgement` | Generic engineering opinion, no repo authority | **Must be phrased as a question.** Never "violation", never a verdict | question |

`diff-evidence` exists because grounding and assertiveness are different axes — see the worked example
below, where the run's most valuable finding cites hard evidence but is a deduction about downstream
consequence. Without this rung those findings get systematically under-rated.

A finding that can't name its rung is not emitted. `judgement` findings that can't be phrased as a
question are not emitted either.

## Reference material: the charter

`brain.ts` already resolves `<repo>-handbook` plus one graph hop, with three pluggable providers.
Reuse that contract exactly — `arch` adds a second lookup for `<repo>-charter`.

The distinction that matters: **a handbook is descriptive, a charter is normative.** The handbook says
"here's how the backtest engine works and where the traps are." The charter says "here's what we
decided, why, and what must stay true." A reviewer needs the second to say anything stronger than
`judgement`.

### Charter schema

```yaml
---
id: <repo>-charter
title: <repo> — architecture charter
type: charter
area: <area>
---
```

Five sections, deliberately small:

1. **Scope boundary** — what this service is for, and explicitly what it is *not* for. The single most
   useful section: most bad architecture is something landing in the wrong place.
2. **Invariants** — what must stay true. Phrased so a reviewer can test a diff against them.
3. **Standing decisions** — dated mini-ADRs *with rationale*. The rationale is what makes them
   reviewable rather than dogma; a decision whose reason has expired should be challenged, and that's
   only possible if the reason is written down.
4. **Accepted debt** — so the tool stops re-flagging what you've already decided to live with. Without
   this section the signal-to-noise collapses by round three.
5. **Org context** — ownership boundaries, cost/latency posture, roadmap. Optional, and its absence is
   reported rather than papered over.

### Bootstrapping: `lgtm arch init`

Nobody writes a charter from scratch. `arch init` reads the repo structure plus the last ~30 merged PRs
and **infers a draft** — the recurring shapes, the tables owned vs. borrowed, the conventions visible in
commit history — then hands it over for correction. Editing a wrong draft is an order of magnitude
easier than facing an empty file.

The draft must mark every inferred item with its evidence, so a human can see what it's leaning on and
delete what's wrong. An inferred charter that is silently wrong is worse than no charter, because it
promotes `judgement` findings to `charter` authority.

## What it looks for

Ranked by value, not by frequency:

1. **One-way doors** — schema, persisted formats, published API shape, anything carrying a migration
   cost. Disproportionate scrutiny here is the single best reason to run the tool.
2. **New concepts** — every new table / event / flag / abstraction is a permanent lifetime cost. Was an
   existing one available?
3. **Missing follow-through** — a capability shipped but not wired into what would consume it.
4. **Placement** — logic in the handler that belongs in the lib; duplicated across repos instead of hoisted.
5. **Coupling delta** — did this PR add an edge to the dependency graph?
6. **Operational shape** — how does this fail, is it observable, what's the backfill story?
7. **Hidden second PR** — one change doing two unrelated things.
8. **Framework for one caller** — the simpler thing that would have done.

## Guardrails

Non-negotiable, because each one is a documented way this class of tool dies:

- **Max 5 decisions, ranked.** A design review with 20 items is ignored in full.
- **`no-decisions` must be a common, cheap outcome.** Most PRs are dependency bumps. If the tool always
  finds something profound, it is manufacturing significance and will stop being read.
- **Every decision states what would make it wrong** (`falsifiable_by`).
- **Never post inline.** One PR comment, or JSON for agent mode. Architecture feedback stapled to line 47
  reads as a nitpick and gets resolved as one.

## The flywheel

The output *is* an ADR stub. Surface a decision → the author answers the question on the PR → that answer
is captured into the brain as a standing decision → it becomes charter material that raises the *next*
review from `judgement` to `charter` authority.

The reference document gets written as a byproduct of using the tool. That's the adoption story, and
it's why this compounds instead of plateauing.

## CLI surface

```bash
lgtm arch <pr>                 # architecture review, one summary comment
lgtm arch <pr> --agent         # read-only, full JSON, never posts
lgtm arch --local --base main  # review a branch before opening the PR
lgtm arch init                 # bootstrap a charter draft from repo + merged PRs
lgtm arch drift --last 30      # decision drift across the last N merged PRs
```

`--drift` is the differentiated capability: one PR adding a table is fine, the fifth this month is the
finding. Architectural erosion is only visible over time and nothing in the current toolchain can see it.

### Positioning note

`lgtm review --agent` is a merge gate. `arch` should **not** be — it's a "before you build it" tool more
than a "before you merge it" one, and it's most valuable against a **draft PR** or a branch, while the
decision is still cheap to change. Wiring it as a required check would invert its purpose.

## Worked example — dwlf-scheduled-jobs PR #302

Run by hand against a real, well-written PR (range/level detection, Phase 1) to check the design
produces signal rather than prose. Three candidate findings were **suppressed** on inspection:

| Candidate | Why suppressed |
|---|---|
| New cron may race the ledger it reads | Invariant 1 **satisfied** — `serverless.yml:311-327` states the dependency and the reasoning in full |
| New persisted output has no backfill handler | Detector is a full recompute from the ledger each run; backfill is meaningless here |
| Phase 1 of 5 — consumers not wired up | PR body explicitly scopes later phases. `rationale_found` = stated → not a finding |

That 3-of-5 suppression rate is the design working. A tool that had reported all five would be noise.

The finding that survived is the one worth building for:

```jsonc
{
  "decision": "Daily ranges are refreshed on a WEEKLY cadence, making every daily row's state/position/nowPrice snapshot up to ~6 days stale",
  "evidence": ["serverless.yml:318-327", "src/services/rangeStoreService.js"],
  "rationale_found": "stated in the cron comment, with the mitigation: readers must recompute position from a live price and age-check nowTime",
  "reversibility": "cheap now, costly later",
  "ramifications": [
    "the correctness of every future consumer depends on a rule recorded only in a YAML comment",
    "consumers are in other repos (SPT, MCP, frontend) — the rule doesn't travel with the data",
    "a reader that renders `state` directly is wrong in a way no test in this repo can catch"
  ],
  "authority": "judgement",
  "confidence": "high",
  "falsifiable_by": "if the stored row carries its own staleness marker that consumers must handle, the contract travels with the data and this is a non-issue",
  "ask_the_author": "Four consumers landed after this (SPT #558, the MCP tool, the Today card, the briefing) — does each one recompute position from live price, or does the contract only exist in this comment?"
}
```

This is precisely the finding `lgtm review` cannot reach: the code is correct, well-commented, and
there is no line to anchor to. The risk lives in *other repos, in the future*.

### What the example changed in the design

The ladder as first drafted conflated **how grounded** a finding is with **how assertive** it may be.
The finding above cites hard evidence in the diff, yet is still a judgement about downstream
consequence — so it landed on the weakest rung despite being the most valuable output of the run.

Fix: add a fourth rung, `diff-evidence` — *cites the change itself; the consequence is deduced*.
It may state the evidence assertively while keeping the consequence phrased as a question. Without it,
the highest-value findings are systematically under-rated.

## System prompt (draft)

> You are a principal engineer reviewing a change for its **architectural consequences**, not its
> correctness. A separate tool already reviews correctness — do not report bugs, style, naming, or
> missing null checks. If you find one, ignore it.
>
> Your job is to surface the **decisions** this change commits the system to, and what they cost later.
> A decision is a fork the author took where a different path was available: introducing a new concept,
> choosing where code lives, adding a dependency edge, fixing a data shape, or **not** changing something
> that arguably should have changed.
>
> **Absence counts.** The most important finding is often what the diff does *not* touch: a new capability
> not wired into its consumers, a new write path with no backfill, a new failure mode with no alarm.
>
> **AUTHORITY — the rule that matters most.** Every decision must declare `authority`:
> - `charter` — you can cite a specific line of the charter below. Quote it. Be assertive.
> - `codebase-pattern` — you can cite an observed, *counted* fact from the provided context
>   ("6 of 7 handlers do X"). State the count. If you cannot count it, this is not the rung.
> - `judgement` — generic engineering opinion with no authority in this repo. **Phrase it as a question.**
>   Never say "violates", "should", "convention", or "standard". You may say "what made X right here?"
>
> Do NOT invent principles, conventions, or organisational standards. If it is not in the charter or
> visibly, countably in the context, it does not exist. A confidently-wrong architectural claim is far
> more damaging than a missed one, because it is expensive to argue down.
>
> **Silence is a correct answer.** Most changes contain no architectural decisions. If this one doesn't,
> return `{"verdict": "no-decisions", ...}` with an empty array. Do not manufacture significance.
>
> Rank by consequence and return **at most 5**. Prefer one-way doors over reversible choices, and
> consequences over preferences.

## Implementation notes — deltas from this design (shipped 2026-08-10)

The `feat/arch` implementation follows this document with these deliberate changes:

1. **The charter moved in-repo.** Primary location is `ARCHITECTURE.md` (then `docs/`, then `.lgtm/`)
   inside the repo itself — versioned with the code, visible in PRs, standalone with **no brain
   required**. The brain `<repo>-charter` note demoted to an optional fallback (URL/DIR providers
   only; CMD is deliberately skipped — its contract answers the *handbook* question, and arbitrary
   command output must not be promoted to *normative* charter authority). Schema: merged with the
   conversation design — Purpose & scope boundary (with **Not for**), Interfaces & dependencies,
   Invariants, Standing decisions, Accepted debt, Org context (template: `CHARTER_TEMPLATE` in
   `src/charter.ts`).
2. **A system level was added.** `SYSTEM.md` — repos, one-line responsibilities, and contracts
   (who→whom, via what, who owns the schema) — lives in its own repo beside the others, resolved via
   the charter's `system:` frontmatter pointer or `LGTM_SYSTEM_DIR`. Local paths only for now (no
   remote fetch). Cited system-doc lines carry `charter` authority; it powers placement and
   contract-coherence checks, and `arch new` overlap checks.
3. **Contract vs convention boundary** (so a charter edit knows what it can safely change): code
   parses ONLY the filename search order and the `title:` / `system:` frontmatter fields, plus the
   `<repo>-charter` brain-note id. Everything else in a charter/system doc is prose read by prompts.
4. **`arch new` was added** — design-before-code: interview (one question per turn, `--answers` for
   scripted/rehearsal runs), draft, critique-as-questions, author responses folded back in, then the
   charter is written and a SYSTEM.md addition is *proposed* (never applied — a new repo IS a system
   change, landed deliberately). Charter evolution overall is manual by design: nothing edits a
   charter behind the author's back.
5. **`lgtm review` gained the cheap half**: when a charter resolves, one conformance rule rides along
   (max one `(charter)`-prefixed SUGGESTION per review; `--no-charter` is the off switch — added
   after the tool's own self-review flagged charter context as the only always-on context source).
6. **The ladder shipped with all four rungs** including `diff-evidence`. Parse-layer normalization
   collapses unknown enum values to the *weakest* claim (`judgement` / `cheap` / `low`), and the
   verdict is derived from the decisions that survive — a mislabeled envelope can't mislead.
7. **`arch drift` is not yet implemented** — still the differentiated capability, still next.
