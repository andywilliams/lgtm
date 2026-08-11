---
title: lgtm — engineering standards
profile: lib
---

# lgtm — engineering standards

The repo's adopted maintainability standards, selected from lgtm's clean-code catalog (rationale, sources and page refs: lgtm's docs/clean-code-catalog.md). Reviews may cite a listed standard as a `(standard <id>)` finding. Standards apply to NEW/CHANGED code (the diff is the gate) unless marked **[everywhere]**. Edit this file freely — it is yours, not the catalog's.

## Posture
*Working culture — context for reviews, rarely findings in themselves.*
- **META-1 · Boy Scout Rule, tidied first** — Leave every touched module a little cleaner; ship structural tidyings as separate commits before the behavior change, and only where you are already working.
- **META-2 · Later equals never** — Do not merge a working mess with a promised follow-up — clean it in this PR.
- **META-5 · Code without tests is not clean** — Untested code fails the definition of done regardless of elegance.

## Naming
- **N1 · Intention-revealing names** — A name says why it exists, what it does, how it is used; if it needs a comment to explain it, the name failed. Re-evaluate names as meaning drifts.
- **N2 · Name at the right abstraction level** — Do not name after the implementation (DynamoStore, fetchFromS3) when the abstraction is the store/loader the caller thinks in.
- **N3 · Standard nomenclature** — Use ecosystem idiom (handler, reducer, toJSON) and the project domain vocabulary, consistently across the estate.
- **N4 · Unambiguous over short** — A long precise name beats a vague short one; actively ask what else a name could be misread to mean.
- **N5 · Name length matches scope** — `i` in a five-line loop is fine; exports and shared APIs get full, searchable words.
- **N6 · No type/scope encodings — but units are welcome** — No Hungarian, no m_/IFoo/TFoo prefixes (the type system carries the type). Attribute qualifiers ARE good names: delayMs, maxRetries, priceGbp, unsafeHtml.
- **N7 · Names describe side effects** — getOrCreateClient, not getClient, when it lazily creates, caches, or writes.
- **G20 · Function names say what they do** — If you must read the body to know what a call does (units? mutation?), the name failed.
- **NAM-1 · No disinformation** — No false clues: no container types baked into names, no near-identical names for different things, never lone l or O.
- **NAM-2 · Meaningful distinctions** — Different names must mean different things — no Product/ProductInfo/ProductData, no noise suffixes.
- **NAM-3 · One word per concept; no puns** — Pick one of fetch/get/retrieve per concept estate-wide; never reuse one word for two ideas.
- **NAM-4 · Context via structure, not prefixes** — Group related names in modules/types (Address.firstName), never prefix-encode (addrFirstName); no app-initial prefixes.
- **NAM-5 · Pronounceable, not cute** — No genymdhms; no joke names; say what you mean.
- **NAM-6 · Nouns for things, verbs for actions** — Types/modules are noun phrases (Manager/Processor/utils names signal responsibility aggregation); functions are verb phrases; is/has for predicates.

## Functions
- **FUN-1 · Function size** — Cognitive complexity ≤15 per function is the primary gate (nesting penalized, guard clauses free); length is a backstop: warn >90 lines, finding >120.
- **FUN-2 · Shallow nesting** — Prefer guard clauses and early returns; nesting deeper than 3 levels (async try/catch counts) is a finding.
- **G30 · Do one thing** — A function whose body is a series of sections does several things — delegate each; handlers orchestrate only. Test: if you can extract a function whose name is not a restatement, it was doing too much.
- **G34 · One level of abstraction per function** — Statements sit one level below the function name — no business intent mixed with wire formatting.
- **FUN-3 · Stepdown order** — Entry points/exports first, helpers after, caller above callee — but order for the reader, never contort code for narrative flow.
- **XP-15 · Extract by topic, not size** — Extract when code solves a DIFFERENT problem than the function's stated goal — never on line count alone; sequential paragraphs inside one function are fine.
- **XP-11 · One Pile** — When logic is fragmented across pieces too small to understand, inlining them back together and re-chunking is the correct refactoring, not a regression.
- **F1 · Few arguments** — Max 3 positional args; past 2–3, a typed options object or a value object for the travelling clump. Few EXPLICIT args beat zero args fed by hidden state.
- **XP-7 · Data clumps** — The same 3+ values travelling together become a typed value object.
- **F2 · No output arguments** — Do not mutate parameters — return new values.
- **F3 · No flag or selector arguments** — A bare boolean/mode argument declares the function does N things — split it (named option objects like {dryRun:true} acceptable at API edges).
- **FUN-4 · Command–query separation** — A function does something or answers something, never both.
- **FUN-5 · No hidden side effects** — No sneaky state mutation (module state across warm invocations included); if temporal coupling exists, the name admits it.
- **G23 · One switch per selection** — Exhaustive discriminated-union switch with a never guard is idiomatic and preferred; the same type-dispatch must not repeat across modules — one switch/registry per selection.
- **G19 · Explanatory variables** — Break calculations into named intermediates — hard to overdo.
- **G28 · Encapsulate conditionals** — if (shouldBeDeleted(timer)) over inline compound boolean logic.
- **G29 · Positive conditionals** — isEnabled over !isDisabled; double-negative flags are a config-bug factory.
- **G31 · No hidden temporal coupling** — Make call-order structural — thread results through returns, not shared mutable state across sequential awaits.
- **G33 · Encapsulate boundary arithmetic** — Name the ±1s once (lookbackStart) instead of scattering them through expressions.
- **XP-16 · Complexity caps over length caps** — Cognitive complexity ≤15 / cyclomatic ≤20 per function; the caps that reward guard clauses and punish nesting.

## Comments
- **COM-1 · Comment posture** — First try to express it in code (names, types, extraction); but WHY-comments — intent, rationale, warnings, links to incidents/decisions — are encouraged, not failures.
- **C2 · No obsolete or misleading comments** — A comment that drifted from the code is worse than none (async: resolves WHEN vs IF); update or delete on touch.
- **C3 · No redundant comments** — Nothing that restates the code or the type annotation; comments say what code cannot.
- **C1 · No metadata in comments** — Change logs, authors, position banners, closing-brace markers: git and structure own these. A file needing section banners needs splitting.
- **C5 · No commented-out code** **[everywhere]** — Delete it — everywhere, including IaC/config files. Version control remembers.
- **C4 · Comments worth writing are written well** — Brief, precise, next to the code they describe; systemwide facts (env defaults, infra values) are documented at their source, not in distant comments.
- **COM-2 · Docs on the public surface only** — TSDoc on exported/published API; no mandated doc blocks on internals — enforced doc-everything propagates lies.
- **COM-3 · TODOs carry tickets and get swept** — A TODO is not an excuse to leave bad code; no bare TODOs — link an issue; sweep regularly.

## Formatting & file shape
- **FMT-1 · The formatter is the standard** **[everywhere]** — One committed formatter+linter config per repo, enforced in CI; style (incl. line width) is never argued in review.
- **FMT-2 · Small files** — Judged by responsibility first, lines second: warn >470 lines, finding >870.
- **FMT-3 · Newspaper order and vertical grouping** — High-level first, detail downward; related lines vertically dense, concepts separated by blank lines; declare variables at first use.

## Data, abstraction & coupling
- **G36 · Demeter, with the data exemption** — No reaching through a collaborator's returns (a.getB().getC().do()) — but dotting into plain DTOs, event payloads, config and API responses is exempt; the rule bites only on behavioral objects.
- **DAT-1 · Data + functions, or polymorphic types — chosen, not mixed** — Plain typed records through pure functions is legitimate design; discriminated unions/classes when new variants are expected. No hybrids (mutable public fields + business methods); no container classes for namespacing.
- **DAT-2 · Tell, don't ask (behavioral objects)** — Expose repo.saveSnapshot(x); don't hand callers a client + table name to compose operations.
- **G6 · Right level of abstraction** — No transport/SDK specifics leaking into domain interfaces; lower-level detail lives wholly in lower-level modules.
- **G8 · Small interfaces, no leakage** — Export the minimum per module; one design decision reflected in multiple modules is leakage — encapsulate it in one place.
- **G7 · Dependency direction is one-way** **[everywhere]** — A shared lib/base package never imports from, or knows the names of, its consumers.
- **G13 · No artificial coupling** — Shared types/constants don't live in one handler's module and get imported cross-service; put them where they belong.
- **G14 · Feature envy** — A function that mostly manipulates another module's data belongs there (formatters/serializers exempt).
- **G17 · Least-surprise placement** — Code lives where a reader would look first.
- **G18 · Inject behavior you may want to vary** — Hard-bound free functions are fine for Math.max-class utilities; where variants are plausible, take the behavior as a parameter.
- **G22 · Logical dependencies made physical** — Don't assume another module's page size/batch limit/schema — read its exported constant/config or ask its API.
- **G26 · Be precise** — Handle the possible null; never float money (integer minor units); conditional writes where concurrent update is possible; multi-row results handled explicitly.
- **G27 · Structure over convention** — Let the type system enforce decisions: required members, exhaustive never-checks, branded types — better than naming conventions.
- **G32 · Don't be arbitrary** — Structure communicates reasons; arbitrary-looking layout invites arbitrary change.
- **XP-3 · No temporal decomposition** — Structure modules by knowledge, not execution order — no read/process/write module triads.
- **XP-4 · Pull complexity downwards** — Handle awkward cases inside the module rather than exporting config/flags/preconditions to every caller.
- **XP-8 · Primitive obsession** — Domain concepts (money, symbol ids, timeframes) get types — branded/opaque in TS — not bare strings and numbers.
- **XP-10 · No global or shared mutable data** — Module-level mutable singletons and shared mutable state are smells at any dose — warm-invocation module state included.

## Error handling
- **ERR-1 · Errors must not obscure logic** — Error handling is one thing: centralize in wrappers/middleware; a function that handles errors does nothing else; extract try/catch bodies.
- **ERR-2 · One error strategy, no sentinels** — Thrown errors handled at a boundary, or an explicit Result type used consistently — never ad-hoc {ok:false}/magic-value returns scattered per function.
- **ERR-3 · Errors carry context, classified by caller's needs** — Operation, identifiers, cause chain; a small taxonomy keyed to handling decisions (retryable / user-input / fatal), not a mirror of upstream error types.
- **ERR-4 · Design errors out; special case over exceptional flow** — Expected absences return neutral objects/empty collections, not thrown-and-caught NotFound; where API design can make the error case impossible (clamping, idempotent ops), prefer that.
- **ERR-5 · Absence is typed; collections never nullish** — T | undefined under strictNullChecks; [] never undefined/null for lists; normalize SDK optionality at the adapter.
- **ERR-6 · Don't pass null** — Non-optional parameter types by default; validate payloads at the edge so interior functions never see nullish.
- **XP-17 · Only throw Error; empty catch justifies itself** **[everywhere]** — Never throw/reject non-Error values; a swallowing catch carries an explanatory comment or it is a finding.

## Boundaries (third-party code)
- **BND-1 · Wrap third-party code; few touch points** — SDK clients, raw command/response shapes and vendor error zoos stay inside a small adapter layer translating to types you own; never in public signatures.
- **BND-2 · Learning and boundary tests** — Explore a new dependency with tests, keep them, rerun on version bumps — a behavior change fails a test, not production.
- **BND-3 · Wish-driven interfaces + adapter seam** — Define the interface you wish you had, code against it, adapt the vendor behind it; the seam takes in-memory fakes in tests.

## Tests
- **TST-1 · Test code is first-class** — Same cleanliness/lint/review standards as production (efficiency may differ); rotting tests rot the code.
- **TST-2 · Tests read as intent** — Arrange/act/assert; setup noise behind grown-by-refactoring helpers; table-driven where the pattern of cases carries meaning.
- **TST-3 · One concept per test** — Minimal asserts per concept — one toEqual on a whole object satisfies it; plain explicit tests beat clever DSL compression.
- **TST-4 · F.I.R.S.T.** — Fast (in-memory default suite), Independent (no shared state/order), Repeatable (offline, injected clocks), Self-validating (assert values, never eyeballed logs), Timely (spec with the code, forcing testable shape).
- **T1 · Test what could break — especially boundaries** — "Seems like enough" is not a metric; every boundary condition gets a test (empty inputs, off-by-ones, time edges, pagination seams); validate calculations against known real data.
- **T2 · Coverage as gap-finder** **[everywhere]** — Coverage runs in CI to find untested branches (uncovered catch bodies especially) — a diagnostic, not a vanity gate.
- **T3 · Don't skip trivial tests** — Documentary value exceeds cost (serializers, mappers, config parsing).
- **T4 · A skipped test is a question, not a silencer** **[everywhere]** — test.skip/test.todo encode open requirement questions with a reason; skipping a FAILING test is an overridden safety (G4).
- **T6 · Bugs congregate** — A found bug triggers an exhaustive test battery around that function before the one-line fix ships.

## Modules & cohesion
- **MOD-1 · Single responsibility, by change-axis** — A module/handler has one reason to change. Operational test: one module changing for many unrelated reasons splits; one conceptual change forcing edits across many files consolidates.
- **MOD-2 · Size = responsibilities; the name is the test** — If you cannot name it concisely — or its one-sentence description needs an "and" — split it. utils.ts/manager.ts/helpers.ts are the smell wearing a filename.
- **MOD-3 · Cohesion splits** — A cluster of functions sharing state/params the rest doesn't touch is its own module; exports hang together or leave.
- **XP-1 · Deep modules** — Prefer simple interfaces hiding substantial implementation; flag shallow modules — pass-throughs, one-call wrappers whose interface is as complex as their body, adjacent layers with near-identical interfaces.
- **MOD-4 · Granularity stance** — Both failure modes are findings: a module aggregating unrelated responsibilities AND a shard of one-line pass-through modules; fewest elements that tests, dedup and clarity demand.
- **MOD-5 · Open for extension** — New variants extend (union member + registry entry + new file), not edit every existing switch body; reopening a module for every variant is the design talking.
- **MOD-6 · Depend on abstractions at seams** — Narrow interface types for external services, injected (parameter/factory), stubbed in tests — DIP without a framework.
- **MOD-7 · Export only the API** — Loosening encapsulation is a last resort — don't export internals just for tests; test through the public surface or extract a module.

## Design & change
- **DSN-1 · Four rules of simple design, in order** — Passes all tests > no duplication > expresses intent > minimal entities — the review's tie-breaker hierarchy.
- **DSN-2 · Composition root** — Construction/wiring separated from use: module-scope or explicit root builds the graph (clients at cold start); no new/lookup scattered through runtime paths.
- **DSN-3 · Framework-free domain core** — Domain modules import zero SDK/platform; adapters at the edge translate; domain logic unit-tests without platform mocks.
- **DSN-4 · Simplest thing; no speculative generality** — Today's stories, decoupled enough to restructure; hooks/params/abstractions for imagined futures are a finding.
- **G5 · DRY, for knowledge not lines** — Duplicated algorithms/policy are the enemy — helpers, or the shared lib for cross-repo repetition. Incidental similarity is NOT duplication; when unsure, apply the Rule of Three.

## Concurrency & async
- **CON-1 · Concurrency code is separated** — Batching, locking, idempotency, retry orchestration live in dedicated modules with their own tests; business logic stays pure.
- **CON-2 · Compound operations on shared state are atomic** — Read-then-write on a shared store is the classic trap: conditional expressions/transactions, never two calls; one module owns mutation of a given item.
- **CON-3 · Prefer copies and independence** — Immutable data, per-invocation state, partition work by key so units never contend; narrow genuinely shared state aggressively.
- **CON-4 · One-offs don't exist** **[everywhere]** — Intermittent CI flakes and sporadic prod anomalies (duplicate events, out-of-order writes) are real defects to chase, never retries to shrug off.
- **CON-5 · Force the interleavings in tests** — Timeouts, partial batch failures and draining are first-class test targets; jitter/fuzz ordering where races are plausible.

## General hygiene
- **G4 · No overridden safeties** **[everywhere]** — @ts-ignore, any-casts (unknown + narrowing instead), disabled lint rules, .skip-ed failing tests, force-merged red CI — each is a finding unless justified in place.
- **G25 · No magic numbers or strings** — Named constants for numbers AND the TS-dominant form: table names, event-type strings, ARN fragments, fixture IDs.
- **G11 · Consistency** — Same shape for similar things: handler naming, response envelopes, error patterns — identical across endpoints and repos.
- **G12 · No clutter** **[everywhere]** — Unused imports/params/vars, empty scaffolds — gone.
- **G9 · Dead code (incl. dead functions)** **[everywhere]** — Uncalled functions, impossible branches, retired-event handlers, never-fired flag branches: delete — git remembers.
- **G1 · One language per file (minimize embeds)** — Watch inline SQL/CFN-JSON/HTML inside TS files.
- **G2 · Obvious behavior is implemented** — A parse/convert helper handles the input variants callers will reasonably assume (least surprise).
- **G21 · Understand the algorithm** — Passing tests ≠ understanding; be able to explain why the logic is right, validated against real data — sharpened, not dulled, by AI-written code.
- **E1 · One-command build and test** **[everywhere]** — Clone → install → build, and one test command runs the suite; manual token/setup choreography is a build-step smell (or recorded as accepted debt).

## House rules
*Repo-specific standards no book wrote — same authority as the catalog entries above. Add freely; date them.*
- (none yet)

## Not enforced
*Deliberate choices — reviews must NOT raise these. Re-open by editing this file, not by re-arguing in review.*
- **TST-5 · TDD three laws** — Test-FIRST in strict 30-second cycles is unverifiable post-hoc and explicitly unresolved between Martin and Ousterhout; its value is folded into F.I.R.S.T. Timely. Tests themselves are non-negotiable (META-5).
- **DSN-5 · Postpone decisions / standards need demonstrable value** — Architecture-altitude concerns — they live in ARCHITECTURE.md standing decisions and `lgtm arch`, not the standards review.

## Rejected
*Catalog entries that do not translate to this stack — recorded so reviews never cite them.*
- **J1 · Wildcard imports** — Inverted in TS/ESM — explicit named imports win (tree-shaking, clarity).
- **J2 · Constants via inheritance** — Java-mechanics; moot in TS — import constants from modules.
- **J3 · Enums over int constants** — Already idiom in TS as string-literal unions / as-const objects; the Java form does not apply.

## Choices
*The contested-toggle answers from `lgtm standards init` (2026-08-11).*
- 2026-08-11 — **FUN-1** → Balanced (recommended) — cognitive complexity ≤15 primary, length backstop
- 2026-08-11 — **COM-1** → Why-comments encouraged (recommended) — code first, rationale welcome
- 2026-08-11 — **FMT-2** → Yes (recommended) — soft thresholds, responsibility judged first
- 2026-08-11 — **MOD-4** → Balanced (recommended) — flag both over-aggregation and over-sharding
- 2026-08-11 — **G5** → Rule of Three (recommended) — knowledge-dup only, abstraction must be real
- 2026-08-11 — thresholds: function warn >90 / finding >120 lines · file warn >470 / finding >870 lines
- 2026-08-11 — repo scan at selection time: 23 source files; function lines p50 11 / p95 85 / max 421; file lines p50 151 / p95 463 / max 1681 (approximate scan)
