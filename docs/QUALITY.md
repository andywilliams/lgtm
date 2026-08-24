# lgtm quality — the 4th altitude

*Do the tests actually hold the code down?* — the question none of the other altitudes asks
(`review` = is it correct · `arch` = was it the right thing to build · `STANDARDS.md` = will it
be cheap to change), and the one that should never be answered by an LLM, because it is
mechanically decidable. Mutation testing (Stryker) decides it; lgtm consumes the verdict.

## Division of labour (the core design decision)

**lgtm consumes `mutation.json`; producing it is the target repo's job** (nightly CI or a local
`npm run test:mutation`). Reading a report artifact is a far smaller invariant surface than
executing foreign test suites. A missing report is a loud, actionable error on the explicit
`quality` commands — and must be a no-op warning wherever quality later participates in a
review (the `brain.ts` posture: optional inputs never break a review).

## Phases

| Phase | What | State |
|---|---|---|
| 0 | Design interview — the decisions in this doc | ✅ 24-Aug-2026 (Andy) |
| 1 | `quality baseline` + `quality hotspots` — the deterministic spine, no AI call | ✅ 24-Aug-2026 |
| 2 | `quality [pr] --local --gate` — the diff-time ratchet | planned |
| 3 | `quality review <file\|dir>` — AI triage of a file's survivors, capped findings tagged `(mutant <mutator>)` | planned |
| 4 | The burn-down campaign on dwlf-indicators (start `liveWeeklyCycleHighs.ts`, NOT `regime.ts` — see fix-before-harden) | planned |

## The decisions, with reasons

- **Ratchet, not threshold.** An absolute score gate on a ~42% codebase is unshippable. The gate
  (Phase 2) is: touched files' scores must not fall; no new surviving mutant on an added line.
- **Committed baseline** (`.lgtm/mutation-baseline.json`, `version: 1`), not the sqlite store —
  the ratchet travels with the repo: PR-visible, diffable, CI-readable.
- **Loud resets, no inheritance.** A file absent from the baseline seeds at its current score and
  is reported (a rename = one DROPPED + one NEW line). A rewrite that would LOWER a committed
  score refuses without `--force`, then lists every fall. History can be shed or the ratchet
  lowered — never silently, in either case.
- **hotspots is a report, deliberately uncapped.** Detection is deterministic; only Phase 3's AI
  triage spends capped finding slots.
- **Fix before you harden.** Hardening a file pins its CURRENT behaviour — bugs included — and
  the tests then defend the bug. `hotspots` cross-checks open issues per file (`gh`, live tracker
  state by design) and flags blocked files. Canonical example: `regime.ts` ranks high AND carries
  dwlf-indicators#93 — harden it first and the suite would defend the bug.
- **Ranking formula (v1):** `(1−score) × mutants × (1+churn)`, churn = full-history commit count
  (`--follow`). Validated by reproducing the indicators baseline's known worst files
  (`orderBlocks.ts` 3.7% with a 233-line test file exercising almost nothing; `regime.ts` 22.9%
  with the live bug). Full-history churn is a deliberate risk input and a known bias: if a real
  repo's top ten reads as oldest-and-most-touched rather than weakest-held, window or reweight it
  then — as a deliberate change, here.
- **Equivalent-mutant escape hatch is mandatory** (Phase 2): `// Stryker disable next-line
  <mutator>: <reason>` with a REQUIRED reason — without it a hardener agent writes nonsense tests
  to satisfy the gate, which is the exact test theatre this exists to kill. A growing pile of
  disables is itself a signal.

## Honest limits

Mutation testing hardens tests against the spec you wrote — a zero-survivor suite can still
encode the wrong semantics perfectly. It complements, never replaces, validation against real
data. And Stryker is JS/TS-only: non-JS repos must degrade to a no-op, never a broken review.
