# Clean-code standards catalog

> **Status: DRAFT v2 — book synthesis + counterpoints research complete.** All 17 chapters
> extracted with page-verified refs; ~120 raw principles curated into the entries below; §14 now
> carries the cross-source additions (Ousterhout, Fowler, Beck, Boswell & Foucher, Google
> eng-practices, qntm/community critiques, linter conventions) and each contested entry names its
> opposition. This document is Andy's to argue with — every `verdict` is a recommendation, not a
> decision.

## What this file is

The **catalog** that ships inside lgtm: every candidate standard a repo might adopt, distilled from
Clean Code (Robert C. Martin, 2008) and stress-tested against 2026 TypeScript/serverless practice.
It is **not** a repo's standards. A repo's `STANDARDS.md` records the *selections* — adopted /
adapted (with modified threshold) / rejected (with why), dated — produced by the
`lgtm standards init` interview flow. The catalog seeds the interview; it does not bound the doc
(repos can add house rules the book never wrote — see §15).

Design decisions carried in from the 2026-08-11 discussion:

- **Catalog ≠ selection.** Catalog lives in lgtm and can grow; `STANDARDS.md` lives in the repo and
  records choices. An update flow diffs catalog-vs-doc and interviews only on what's new.
- **Ids reuse the book's smell codes** (G/N/T/F/C/E/J) where they exist, so `(standard G30)`
  findings cite both the repo doc and the book. Chapter-only principles get minted theme ids
  (NAM-, FUN-, COM-, FMT-, DAT-, ERR-, BND-, TST-, MOD-, DSN-, CON-, META-).
- **Uncontested entries default ON silently** — the interview asks only about `ask` entries and
  parameterised thresholds. A profile question up front sets smarter defaults:
  **lib** (pure-function library, e.g. indicators) · **service** (Lambda/API repos, e.g. SPT,
  scheduled-jobs, charting, mcp-server) · **frontend** (React, e.g. portfolio-frontend).
- **Enforcement scope per entry:** `new-code` (the diff is the gate — the norm) vs `everywhere`
  (audit mode: capped, hotspot-ranked, a debt backlog never a merge gate).
- **Findings:** `(standard <id>)` at charter-level authority — cite the line, be assertive —
  capped per review like arch's five ranked decision records.

## Entry format

```
- **<id> · <Title>.** The rule as we'd enforce it. (source refs)
  default on|off|ask · scope new-code|everywhere · verdict adopt|adapt|reject
  [contested: who pushes back and why]   [params: thresholds]   [profiles: differences]
```

---

## 1 · Posture (META) — culture, cited sparingly, rarely findings

- **META-1 · Boy Scout Rule.** Leave every touched module a little cleaner than you found it —
  one rename, one split, one dedup; keep drive-bys small enough not to bloat the diff. (Ch1 p14)
  default on · scope new-code · verdict adopt
- **META-2 · Later equals never.** Don't merge a working mess with a promised follow-up; clean it
  in this PR. (Ch1 p3–4) default on · scope new-code · verdict adopt
- **META-3 · Clean to go fast.** The mess slows you down immediately, not eventually; "the only way
  to go fast is to keep the code as clean as possible at all times." (Ch1 p6)
  default on · scope n/a (rationale, not a finding) · verdict adopt
- **META-4 · Write for readers.** Read:write time is >10:1 — optimize for the reader even at the
  writer's cost. (Ch1 p13–14) default on · scope n/a · verdict adopt
- **META-5 · Code without tests is not clean.** Untested code fails the definition regardless of
  elegance. (Ch1 p9) default on · scope new-code · verdict adopt

## 2 · Naming — Ch2 + N1–N7, G20

- **N1 · Descriptive, intention-revealing names.** A name tells you why it exists, what it does,
  how it's used; if it needs a comment, it failed. Re-evaluate names as meaning drifts. "Names are
  90 percent of what make software readable." (Ch2 p18–19; N1 p309)
  default on · scope new-code · verdict adopt
- **N2 · Name at the right abstraction level.** Don't name after the implementation
  (`DynamoStore`, `fetchFromS3`) when the abstraction is `TradeStore`/`loadSnapshot`. (N2 p311)
  default on · scope new-code · verdict adopt
- **N3 · Standard nomenclature.** Use ecosystem idiom (`handler`, `reducer`, `toJSON`, `use*`) and
  the project's own domain vocabulary (signal, regime, setup) consistently across repos.
  (N3 p311; Ch2 solution/problem-domain p27) default on · scope new-code · verdict adopt
- **N4 · Unambiguous over short.** A long precise name beats a vague short one
  (`renamePageAndOptionallyAllReferences` is fine). (N4 p312; Ch3 p39)
  default on · scope new-code · verdict adopt
- **N5 · Name length ∝ scope.** `i` in a 5-line loop is fine; exports and shared APIs need full
  words; searchable names for anything used in multiple places. (N5 p312; Ch2 p22–23)
  default on · scope new-code · verdict adopt
- **N6 · No encodings.** No Hungarian, no `m_`, no `IFoo`/`TFoo`-style prefixes — the type system
  carries the type; the name carries the meaning. (N6 p312; Ch2 p23–24)
  default on · scope new-code · verdict adopt
- **N7 · Names describe side effects.** `getOrCreateClient`, not `getClient`, when it lazily
  creates/caches/writes. (N7 p313) default on · scope new-code · verdict adopt
- **G20 · Function names say what they do.** If you must read the body to know what a call does
  (units? mutation?), the name failed. (G20 p297) default on · scope new-code · verdict adopt
- **NAM-1 · No disinformation.** No false clues: don't bake container types into names, avoid
  near-identical names, never lone `l`/`O`. (Ch2 p19–20) default on · scope new-code · verdict adopt
- **NAM-2 · Meaningful distinctions.** Different names must mean different things — no
  `Product`/`ProductInfo`/`ProductData`, no noise suffixes. (Ch2 p20–21)
  default on · scope new-code · verdict adopt
- **NAM-3 · One word per concept; don't pun.** One lexicon across the estate (`fetch` vs `get` vs
  `retrieve` — pick one); never the same word for two ideas. (Ch2 p26–27)
  default on · scope new-code (estate-wide lexicon: everywhere) · verdict adopt
- **NAM-4 · Context without gratuitous prefixes.** Group names in modules/types rather than
  prefix-encoding (`Address.firstName` not `addrFirstName`); no app-initial prefixes. (Ch2 p27–30)
  default on · scope new-code · verdict adopt
- **NAM-5 · Pronounceable, not cute.** No `genymdhms`; no joke names; say what you mean.
  (Ch2 p21–22, 26) default on · scope new-code · verdict adopt
- **NAM-6 · Nouns for things, verbs for actions.** Types/modules are noun phrases (and `Manager`/
  `Processor`/`utils` names signal responsibility aggregation — see MOD-2); functions are verb
  phrases; `is`/`has` for predicates. Adapted: JavaBean `get`/`set` prefixes not required. (Ch2 p25)
  default on · scope new-code · verdict adapt

## 3 · Functions — Ch3 + F1–F4, G15, G19, G28–G31, G34

- **FUN-1 · Small functions.** Book: "hardly ever 20 lines," ideal 2–4. **Adapted:** small enough
  to do one thing at one level; enforce by soft threshold, not dogma — the 2–4-line ideal
  fragments control flow (see §14 counterpoints). (Ch3 p34–35)
  default ask · scope new-code · verdict adapt
  contested: the book's most-criticised rule — Ousterhout (deep modules/entanglement), Beck (One
  Pile), Fowler (Lazy Element), and every linter default (50–200 lines) push back; in the 2024–25
  written debate Martin CONCEDED the 1st ed lacks over-decomposition guardrails (§14).
  params: prefer XP-16 cognitive-complexity ≤15 as the primary mechanical gate; length as
  backstop only (warn >50, finding >80; pure-math lib may run longer bodies).
- **FUN-2 · Shallow nesting.** Book: 1-line blocks, indent ≤1–2. **Adapted:** prefer guard
  clauses/early returns; flag deep nesting. (Ch3 p35, 48–49) default on · scope new-code ·
  verdict adapt · params: max nesting 3 (async try/catch counts).
- **G30 · Do one thing.** A function whose body is a series of sections does several things —
  delegate each; the extraction test: if you can pull out a function whose name isn't a
  restatement, it was doing too much. Handlers orchestrate only. (Ch3 p35–36; G30 p302)
  default on · scope new-code · verdict adopt
- **G34 · One level of abstraction per function.** Statements sit one level below the function's
  name; no business intent mixed with wire formatting. (Ch3 p36–37; G34 p304)
  default on · scope new-code · verdict adopt
- **FUN-3 · Stepdown order.** File reads top-down: entry point/exports first, helpers after, each
  function followed by its next level down (hoisted `function` declarations make this free).
  Adapted: order for the reader, don't contort code for narrative flow (qntm: IDEs jump anyway;
  Beck's Reading Order tidying is the softer form). (Ch3 p37; Ch5 p82–85; G10 p292)
  default on · scope new-code · verdict adapt
- **F1 · Few arguments.** 1–2 ideal, 3 questionable, >3 needs justification; in TS the idiomatic
  fix is a typed options object (or data clump → value object, XP-7) once past 2–3. The book's
  ZERO-arg ideal is rejected: zero args plus no-side-effects is contradictory (qntm) — few
  *explicit* args beat none fed by hidden state (Beck's Explicit Parameters). (Ch3 p40–43; F1 p288)
  default on · scope new-code · verdict adapt · params: max 3 positional.
- **F2 · No output arguments.** Callers read args as inputs. **Adapted for TS:** don't mutate
  parameters at all — return new values. (Ch3 p45; F2 p288) default on · scope new-code · verdict adapt
- **F3/G15 · No flag or selector arguments.** A bare boolean/mode arg declares the function does
  N things — split it (named-option objects `{dryRun:true}` acceptable at API edges).
  (Ch3 p41; F3 p288; G15 p294) default on · scope new-code · verdict adapt
- **FUN-4 · Command–query separation.** Do something or answer something, never both; no
  `if (set(...))`. (Ch3 p45–46) default on · scope new-code · verdict adopt
- **FUN-5 · No hidden side effects.** "Side effects are lies" — no sneaky session inits, no
  module-state mutation across warm invocations; if coupling exists, the name admits it (N7).
  (Ch3 p44) default on · scope new-code · verdict adopt
- **G23 · One switch per selection.** Book: bury switches under polymorphism. **Adapted for TS:**
  discriminated unions with exhaustive `switch` + `never` guard are idiomatic and *preferred*;
  the enforceable core is: the same type-dispatch must not repeat across modules — one
  switch/registry per selection. Fowler's 2nd-ed rename of the smell to *Repeated* Switches
  confirms exactly this narrowing. (Ch3 p37–39; G23 p299)
  default on · scope new-code · verdict adapt
- **G19 · Explanatory variables.** Break calculations into named intermediates; "hard to overdo."
  (G19 p296; Ch4 p67) default on · scope new-code · verdict adopt
- **G28 · Encapsulate conditionals.** `if (shouldBeDeleted(timer))` over compound boolean logic
  inline. (G28 p301) default on · scope new-code · verdict adopt
- **G29 · Positive conditionals.** `isEnabled` over `!isDisabled`; double-negative flags are a
  config-bug factory. (G29 p302) default on · scope new-code · verdict adopt
- **G31 · No hidden temporal coupling.** Make call-order structural — thread results through
  returns ("bucket brigade"), not shared mutable state across sequential awaits. (G31 p302)
  default on · scope new-code · verdict adopt
- **G33 · Encapsulate boundary arithmetic.** Name the ±1s once (`lookbackStart`) instead of
  scattering them — indicator-loop territory. (G33 p304) default on · scope new-code · verdict adopt
- **F4/G9 · Dead code.** Uncalled functions, impossible branches, retired-event handlers,
  never-fired flag branches: delete (git remembers). (F4 p288; G9 p292; Ch4 p68–69)
  default on · scope everywhere · verdict adopt

## 4 · Comments — Ch4 + C1–C5

- **COM-1 · Comment posture: prefer code, keep the whys.** Book: "comments are always failures."
  **Adapted:** first try to express it in code (names, types, extraction); but *why*-comments —
  intent, rationale, warnings, links to incidents/ADRs — are encouraged, not failures. The
  absolutist reading is rejected (see §14: Ousterhout). (Ch4 p53–55)
  default ask · scope new-code · verdict adapt
  contested: the book's second-most-criticised stance. Ousterhout: missing comments cost 10–100x
  more than stale ones; interface comments ARE design. Google: comments carry "information the
  code can't possibly contain." Beck pairs Explaining Comments WITH Delete Redundant Comments.
  In the 2024–25 debate Martin conceded comments can be more precise than code for qualitative
  concepts. All sources still agree on C3 (no redundancy) — the fight is only over the default.
- **C2 · No obsolete/misleading comments.** A comment that drifted from the code is worse than
  none; imprecise comments (async: resolves *when* vs *if*) send readers into debugging holes.
  Update or delete on touch. (C2 p286; Ch4 p54, 63) default on · scope new-code · verdict adopt
- **C3 · No redundant/noise comments.** Nothing that restates the code or the type annotation
  (`/** The logger */`); comments say what code cannot. (C3 p286; Ch4 p60–66)
  default on · scope new-code · verdict adopt
- **C1 · No metadata in comments.** Change logs, authors, bylines, position banners, closing-brace
  markers: git and structure own these. A file needing section banners needs splitting. (C1 p286;
  Ch4 p63–68) default on · scope new-code · verdict adopt
- **C5 · No commented-out code.** Delete it — everywhere, including `serverless.yml`/IaC. (C5
  p287; Ch4 p68–69) default on · scope everywhere · verdict adopt
- **C4 · Comments worth writing are written well.** Brief, precise, grammatical; a comment needing
  its own explanation failed; describe the code it sits next to, not systemwide facts owned
  elsewhere (env defaults live at the config source). (C4 p287; Ch4 p59–60, 69–70)
  default on · scope new-code · verdict adopt
- **COM-2 · Docs on the public surface only.** TSDoc on exported/published API (the lib's npm
  surface); no mandated doc blocks on internals — "every function must have a javadoc" propagates
  lies. (Ch4 p59, 63, 70–71) default on · scope new-code · verdict adopt
  profiles: lib = enforce on all exports; service/frontend = public HTTP/tool contracts only.
- **COM-3 · TODOs carry tickets and get swept.** A TODO is not an excuse to leave bad code; no
  bare TODOs — link an issue; sweep regularly. (Ch4 p58–59) default on · scope new-code · verdict adapt

## 5 · Formatting & file shape — Ch5 (mostly delegated to tooling)

- **FMT-1 · The formatter is the standard.** One committed prettier+eslint config per repo,
  enforced in CI; nobody argues style in review. This IS the book's "team rules / encode them in
  the formatter," fully mechanized. (Ch5 p76, 90; G24 p299)
  default on · scope everywhere · verdict adopt
- **FMT-2 · Small files.** Book: ~200 lines typical, ~500 upper. Judged by responsibility first
  (MOD-2), lines second. (Ch5 p76–77) default ask · scope new-code · verdict adapt
  params: warn >400, finding >800 (frontend components often warrant tighter).
- **FMT-3 · Newspaper order + vertical grouping.** High-level first, detail increasing downward
  (FUN-3); related lines vertically dense, concepts separated by blank lines; declare variables at
  first use; caller above callee. Human judgment prettier can't make. (Ch5 p77–85)
  default on · scope new-code · verdict adopt
- **FMT-4 · Line width.** Delegated to the formatter. (Ch5 p85–86: 80 traditional, author's limit
  120.) default on · scope everywhere · verdict adopt · params: printWidth per repo config.
- *Rejected as standards (formatter territory or dead practice):* horizontal alignment (the book
  itself rejects), indentation mechanics, dummy-scope visibility, Java member-ordering convention.

## 6 · Data, abstraction & coupling — Ch6 + G6–G8, G13, G14, G17, G18, G22, G26, G27, G32, G36

- **G36 · Demeter, with the data exemption.** Talk to friends, not strangers — no reaching through
  a collaborator's returns (`a.getB().getC().do()`); **but** the book itself exempts data
  structures: dotting into DTOs, event payloads, config, API responses is fine. The rule bites
  only on behavioral objects/services. (Ch6 p97–100; G36 p306)
  default on · scope new-code · verdict adopt
- **DAT-1 · Data+functions or polymorphic types — chosen, not mixed.** "Everything is an object is
  a myth." Plain typed records flowing through pure functions is legitimate design (easy to add
  functions); discriminated unions/classes when you expect new variants. Pick per axis of change;
  no hybrids (mutable public fields + business methods on one class). (Ch6 p95–99, 101)
  default on · scope new-code · verdict adopt
- **DAT-2 · Tell, don't ask (behavioral objects only).** Expose `repo.saveSnapshot(x)`, don't hand
  callers the client + table name to compose. (Ch6 p99–100) default on · scope new-code · verdict adopt
- **G6 · Right level of abstraction.** No transport/AWS specifics leaking into domain interfaces;
  lower-level detail lives in lower-level modules, completely. (G6 p290)
  default on · scope new-code · verdict adopt
- **G8 · Small interfaces / minimal exports.** Hide data, utilities, constants, temporaries;
  export the minimum per module; re-export-everything barrels are this smell in npm form.
  (G8 p291; Ch10 p136) default on · scope new-code · verdict adopt
- **G7 · Dependency direction is one-way.** A shared lib/base package never imports from (or knows
  the names of) its consumers. (G7 p291) default on · scope everywhere · verdict adopt
- **G13 · No artificial coupling.** Shared types/constants don't live in one handler's module and
  get imported cross-service; put them where they belong. (G13 p293)
  default on · scope new-code · verdict adopt
- **G14 · Feature envy.** A function that mostly manipulates another module's data belongs there
  (formatters/serializers exempt, as the book allows). (G14 p293)
  default on · scope new-code · verdict adopt
- **G17 · Least-surprise placement.** Code lives where a reader would look first — indicator math
  in the indicators lib, not inlined in a scheduled job. (G17 p295)
  default on · scope new-code · verdict adopt
- **G18 · Inject behavior you may want to vary.** The static/hard-bound free function is fine for
  `Math.max`-class utilities; where variants are plausible, take the behavior as a parameter.
  (G18 p296) default on · scope new-code · verdict adapt
- **G22 · Logical dependencies made physical.** Don't assume another module's page size/batch
  limit/schema — ask its exported constant/config/API. (G22 p298)
  default on · scope new-code · verdict adopt
- **G26 · Be precise.** Handle the possible null, never float money (integer cents), conditional
  writes where concurrent update is possible, multi-row results handled explicitly. "Ambiguities
  and imprecision are disagreements or laziness." (G26 p301)
  default on · scope new-code · verdict adopt
- **G27 · Structure over convention.** Let the type system enforce decisions: required members,
  exhaustive `never` checks, branded types — better than naming conventions. (G27 p301)
  default on · scope new-code · verdict adopt
- **G32 · Don't be arbitrary.** Structure communicates reasons; arbitrary-looking layout invites
  arbitrary change (monorepo folder drift). (G32 p303) default on · scope new-code · verdict adopt

## 7 · Error handling — Ch7 + G3 (tests), G4→§13

- **ERR-1 · Errors must not obscure logic.** Error handling is one thing: centralize in
  wrappers/middleware; `try` first word of a function that handles errors, nothing after
  catch/finally; extract try/catch bodies. (Ch7 p103–112; Ch3 p46–47)
  default on · scope new-code · verdict adopt
- **ERR-2 · Thrown errors or typed Results — one strategy, no sentinels.** Book: exceptions over
  return codes. **Adapted for TS:** either thrown errors handled at a boundary or an explicit
  Result type used consistently; never ad-hoc `{ok:false}`/magic-value returns scattered per
  function. (Ch7 p104–107; Ch3 p46) default on · scope new-code · verdict adapt
- **ERR-3 · Errors carry context and are classified by caller's needs.** Operation, identifiers,
  `cause` chain; a small taxonomy keyed to handling decisions (Retryable vs UserInput vs Fatal →
  retries/4xx/5xx), not a mirror of upstream error types. (Ch7 p107–109)
  default on · scope new-code · verdict adopt
- **ERR-4 · Special case over exceptional control flow.** Expected absences return neutral
  objects/empty collections, not thrown-and-caught NotFound. (Ch7 p109–110)
  default on · scope new-code · verdict adopt
- **ERR-5 · Absence is typed; collections are never nullish.** `T | undefined` under
  `strictNullChecks`, `[]` never `undefined`/`null` for lists; normalize SDK optionality at the
  adapter. (Ch7 p110–111) default on · scope new-code · verdict adopt
- **ERR-6 · Don't pass null.** Non-optional parameter types by default; validate payloads at the
  edge so interior functions never see nullish. (Ch7 p111–112)
  default on · scope new-code · verdict adopt

## 8 · Boundaries — Ch8

- **BND-1 · Wrap third-party code; few touch points.** SDK clients, raw command/response shapes,
  vendor error zoos stay inside a small adapters layer translating to types you own; never in
  public signatures. Vendor churn touches one place. (Ch8 p114–115, 120; Ch7 p108–109)
  default on · scope new-code · verdict adopt
- **BND-2 · Learning/boundary tests.** Explore a new dependency with tests, keep them, rerun on
  bumps — a behavior change fails a test, not production. (Ch8 p116–118)
  default on · scope new-code · verdict adopt · profiles: service repos with vendor deps;
  off by default for frontend.
- **BND-3 · Wish-driven interfaces + adapter seam.** Define the interface you wish you had, code
  against it, adapt the vendor behind it; the seam takes in-memory fakes in tests. (Ch8 p118–119)
  default on · scope new-code · verdict adopt

## 9 · Tests — Ch9 + T1–T9, G3

- **TST-1 · Test code is first-class.** Same cleanliness/lint/review standards as production
  (efficiency may differ — the book's "dual standard"); rotting tests rot the code. (Ch9 p123–130)
  default on · scope new-code · verdict adopt
- **TST-2 · Tests read as intent.** Arrange/act/operate/check structure; setup noise behind a
  grown-by-refactoring helper DSL (`makeCandles()`, `invokeHandler()`); table-driven where the
  pattern of cases carries meaning (T7). (Ch9 p124–127; T7 p314)
  default on · scope new-code · verdict adopt
- **TST-3 · One concept per test; minimal asserts.** The book itself softens one-assert to a
  guideline — the enforceable rule is single concept, and one `toEqual` on a whole object
  satisfies it. (Ch9 p130–132) default on · scope new-code · verdict adapt
- **F.I.R.S.T. (TST-4).** Fast (in-memory default suite; slow live checks in a separate stage —
  also T9), Independent (no shared state/order), Repeatable (offline; injected clocks; no live
  AWS), Self-validating (assert values, never eyeballed logs), Timely (spec before or with the
  code, forcing testable shape). (Ch9 p132–133; T9 p314)
  default on · scope new-code · verdict adopt
- **TST-5 · TDD's three laws.** Strict red-green micro-cycle. As a *review-enforceable standard*
  this is unverifiable post-hoc; keep as practice guidance, not findings. (The Ousterhout–Martin
  debate left test-FIRST explicitly unresolved — Ousterhout's "bundling" conceded as defensible;
  tests themselves are non-negotiable, META-5.) (Ch9 p122–123)
  default off · scope n/a · verdict adapt (fold the value into F.I.R.S.T.-Timely)
- **T1/T5/G3 · Test what could break, especially boundaries.** "Seems like enough" is not a
  metric; every boundary condition gets a test — empty series, off-by-one lookbacks, DST/epoch
  edges, pagination seams; validate calculations against known real data, not just shapes.
  (T1 p313; T5 p314; G3 p289) default on · scope new-code · verdict adopt
- **T2 · Coverage as gap-finder.** Run coverage in CI to find untested branches (uncovered `catch`
  bodies especially); a diagnostic, not a vanity target. (T2 p313)
  default on · scope everywhere · verdict adopt · params: no numeric gate by default.
- **T3 · Don't skip trivial tests.** Documentary value exceeds cost (serializers, mappers, config
  parsing). (T3 p313) default on · scope new-code · verdict adopt
- **T4 · A skipped test is a question, not a silencer.** `test.skip`/`test.todo` encode open
  requirement questions with a reason; skipping a *failing* test is G4 (overridden safety).
  (T4 p313) default on · scope everywhere · verdict adopt
- **T6 · Bugs congregate.** A found bug triggers an exhaustive test battery around that function
  before the one-line fix ships. (T6 p314) default on · scope new-code · verdict adopt
- **T8 · Read coverage patterns when diagnosing.** (T8 p314) default off (diagnostic technique,
  not a standard) · verdict adapt

## 10 · Modules & cohesion — Ch10 translated from classes

- **MOD-1 · Single responsibility.** A module/handler/class has one reason to change. The book's
  own phrasing is already "class or module." (Ch10 p138–140)
  default on · scope new-code · verdict adopt
- **MOD-2 · Size = responsibilities, and the name is the test.** Small measured in
  responsibilities, not lines; if you can't name it concisely — or its ~25-word description needs
  an "and" — split it. `utils.ts`/`manager.ts`/`helpers.ts` are the smell wearing a filename.
  (Ch10 p136–138) default on · scope new-code · verdict adopt
- **MOD-3 · Cohesion splits.** When a cluster of functions shares state/params the rest doesn't
  touch, extract it; exports of a module hang together or leave. (Ch10 p140–141)
  default on · scope new-code · verdict adopt
- **MOD-4 · Granularity has two failure modes.** Many-small-single-responsibility modules (Ch10)
  *and* the book's own brake: minimal classes/methods, no interface-per-class dogma, no one-line
  module shards (Ch12 rule 4, lowest priority). Judgment call the review argues from both sides;
  see §14 (deep modules). (Ch10 p139–140; Ch12 p176)
  default ask · scope new-code · verdict adapt
  contested: Ousterhout — shallow-module proliferation ("classitis") is the WORSE failure mode;
  Beck's rule 4 (fewest elements) and Fowler's Lazy Element / Shotgun Surgery agree from the
  other side. XP-1 (deep modules) is the counterweight standard to run alongside MOD-1..3.
- **MOD-5 · Open for extension.** New variants extend (union member + registry entry + new file),
  not edit every existing switch body — the TS form of OCP; reopening a module for every variant
  is the design telling you something. (Ch10 p147–149) default on · scope new-code · verdict adapt
- **MOD-6 · Depend on abstractions at seams.** Narrow interface types for external services,
  injected (parameter/factory), stubbed in tests — DIP without a framework. (Ch10 p149–150)
  default on · scope new-code · verdict adopt
- **MOD-7 · Export only the API; loosening is last resort.** Don't export internals just for
  tests — test through the public surface or extract a module. (Ch10 p136)
  default on · scope new-code · verdict adopt

## 11 · Design & change — Ch11/12 durable subset

- **DSN-1 · Four rules of simple design, in priority order.** Passes all tests > no duplication >
  expresses intent > minimal entities. The review's tie-breaker hierarchy. (Ch12 p171–176; Ch1 p10)
  default on · scope new-code · verdict adopt
- **DSN-2 · Composition root.** Construction/wiring separated from use: module-scope or explicit
  root builds the graph (SDK clients at cold start), handler logic receives it; no `new`/lookup
  scattered through runtime paths. (Ch11 p154–157) default on · scope new-code · verdict adopt
- **DSN-3 · Framework-free domain core.** Domain modules import zero AWS SDK/platform; adapters at
  the edge translate. Unit-testable without platform mocks. (Ch11 p161–166)
  default on · scope new-code · verdict adopt · profiles: the lib is this by construction;
  services enforce at the domain/adapter line.
- **DSN-4 · Simplest thing that works; grow incrementally.** Today's stories, decoupled enough to
  restructure; no speculative scaffolding (YAGNI). (Ch11 p157–158, 169)
  default on · scope new-code · verdict adopt
- **DSN-5 · Postpone decisions; standards need demonstrable value.** Architecture-altitude twins —
  these live more naturally in ARCHITECTURE.md standing decisions; the standards review cites them
  only when a diff forecloses options for free. (Ch11 p167–168)
  default off (arch altitude owns it) · verdict adapt
- **G5 · DRY, for knowledge not lines.** Duplication of *algorithms/policy* is the enemy; identical
  clumps → helpers, cross-repo repetition → the shared lib. **Adapted:** incidental similarity is
  not duplication — deduplicating it manufactures false coupling; when unsure apply the Rule of
  Three. (Ch3 p48; Ch12 p173–174; G5 p289)
  default ask · scope new-code · verdict adapt
  contested: Fowler/Beck (Rule of Three), Sandi Metz ("duplication is far cheaper than the wrong
  abstraction"), Muratori (semantic compression — no abstraction before 2+ occurrences).
  Knowledge-duplication is the target; incidental similarity is not.

## 12 · Concurrency & async — Ch13 translated to serverless/Node

- **CON-1 · Concurrency code is separated.** Batching, locking, idempotency, retry orchestration
  live in dedicated modules with their own tests; business logic stays pure and single-threaded.
  (Ch13 p181, 190–191) default on · scope new-code · verdict adapt
- **CON-2 · Compound operations on shared state are atomic.** Read-then-write on DynamoDB is the
  synchronized-methods trap: conditional expressions/TransactWriteItems, never two calls; one
  module owns mutation of a given item ("single writer"). (Ch13 p181, 185)
  default on · scope new-code · verdict adopt
- **CON-3 · Prefer copies and independence.** Immutable data, per-invocation state, partition work
  by key so invocations never contend; narrow any genuinely shared state aggressively.
  (Ch13 p181–182) default on · scope new-code · verdict adopt
- **CON-4 · One-offs don't exist.** Intermittent CI flakes and sporadic prod anomalies (duplicate
  events, out-of-order writes) are real defects to chase, never retries to shrug off.
  (Ch13 p187) default on · scope everywhere · verdict adopt
- **CON-5 · Force the interleavings in tests.** Boundary cases (timeouts, partial batch failures,
  draining) are first-class test targets; jitter/fuzz message order and clock skew where races are
  plausible. (Ch13 p186–190) default on · scope new-code · verdict adapt

## 13 · General hygiene — remaining G/E codes

- **G4 · No overridden safeties.** `@ts-ignore`, `any`-casts, disabled lint rules, `.skip`ped
  failing tests, force-merging red CI — each is a finding unless justified in place. (G4 p289)
  default on · scope everywhere · verdict adopt
- **G25 · No magic numbers *or strings*.** Named constants for numbers AND the TS-dominant form:
  table names, event-type strings, ARN fragments, fixture IDs. (G25 p300)
  default on · scope new-code · verdict adopt
- **G11 · Consistency.** Same shape for similar things: handler naming, response envelopes, error
  patterns — identical across endpoints and repos. (G11 p292)
  default on · scope new-code · verdict adopt
- **G12 · No clutter.** Unused imports/params/vars, empty scaffolds — lint automates; review
  catches the rest. (G12 p293) default on · scope everywhere · verdict adopt
- **G1 · One language per file (minimize embeds).** Watch inline SQL/CFN-JSON/HTML in TS handlers.
  (G1 p288) default on · scope new-code · verdict adapt
- **G2 · Obvious behavior is implemented.** A `parseSymbol`/`toDate` helper handles the variants
  callers will assume (least surprise). (G2 p288) default on · scope new-code · verdict adopt
- **G21 · Understand the algorithm.** Passing tests ≠ understanding; be able to explain why the
  logic is right, validated against real data — sharpened, not dulled, by AI-written code.
  (G21 p297) default on · scope new-code · verdict adopt
- **E1/E2 · One-command build and test.** Clone → install → build, and one `npm test` runs the
  suite; manual token choreography counts as a build-step smell (the `GH_PACKAGES_TOKEN` dance is
  accepted-debt to note in STANDARDS.md, not silently normal). (E1/E2 p287)
  default on · scope everywhere · verdict adopt
- *Rejected — Java-mechanics with no TS meaning:* **J1** wildcard imports (inverted: explicit
  named imports win), **J2** constants-via-inheritance (moot), **J3** enums-over-ints (translate:
  string-literal unions / `as const`, already idiom). Recorded so the review never cites them.

## 14 · Counterpoints & additions — principles from other sources earning catalog entries

**The debate record (context for every contested flag above):** in the written Ousterhout–Martin
dialogue (Sep 2024–Feb 2025, github.com/johnousterhout/aposd-vs-clean-code), argued over Martin's
own `PrimeGenerator` example, Martin conceded that (a) Clean Code 1st ed lacks guidance on
recognizing over-decomposition, (b) his exemplar's structure confused even him 18 years later,
and (c) his live re-refactor shipped a 3–4x performance regression from splitting a loop — while
Ousterhout conceded his account of TDD was inaccurate and dismissive. Neither moved on the default
(decompose vs consolidate). qntm's critique (qntm.org/clean) works by showing the book's exemplar
code violating the book's own stated principles — and explicitly *endorses* G34 (abstraction
levels, "the strongest single piece of advice"), naming discipline, CQS, no-flag-args, and the
test F.I.R.S.T. properties. The community's verdict is curation, not rejection — which is what
this catalog is.

### From Ousterhout — *A Philosophy of Software Design*

- **XP-1 · Deep modules.** Prefer simple interfaces hiding substantial implementation; flag
  shallow modules — pass-throughs, one-call wrappers whose interface is as complex as their body,
  adjacent layers with near-identical interfaces. The counterweight to MOD-1..3/FUN-1.
  default on · scope new-code · verdict adopt
- **XP-2 · No information leakage.** One design decision reflected in multiple modules is
  leakage; encapsulate it in one place (sharper test than G8). default on · scope new-code
- **XP-3 · No temporal decomposition.** Structure modules by knowledge, not by execution order
  (no read/process/write class triads). default on · scope new-code
- **XP-4 · Pull complexity downwards.** Handle awkward cases inside the module rather than
  exporting config/flags/preconditions to every caller. Tension with G35 noted: G35 governs
  *values* (env/config ownership); XP-4 governs *behavioral* complexity. default on · scope new-code
- **XP-5 · Define errors out of existence.** Design APIs so error cases can't occur (clamping,
  idempotent deletes); minimize exception-handling surface. Refines ERR-4. default on · scope new-code

### From Fowler — *Refactoring* 2nd ed (JS examples; nearest rival taxonomy)

- **XP-6 · Divergent change / shotgun surgery.** The change-axis pair: one module changing for
  many unrelated reasons → split it; one conceptual change forcing edits across many files →
  consolidate. A more testable operationalization of MOD-1. default on · scope everywhere
- **XP-7 · Data clumps.** The same 3+ values traveling together become a typed value object —
  the *mechanism* behind F1. default on · scope new-code
- **XP-8 · Primitive obsession.** Domain concepts (money, symbol ids, timeframes, percentages)
  get types — branded/opaque types in TS — not bare strings and numbers. default on · scope new-code
- **XP-9 · Speculative generality.** Hooks, params, and abstractions for imagined futures are a
  smell; remove them (Google's anti-over-engineering rule is the same standard). Pairs with DSN-4.
  default on · scope new-code
- **XP-10 · Global & mutable shared data.** Module-level mutable singletons and shared mutable
  state are smells at any dose — in Lambda, warm-invocation module state is exactly this (ties
  FUN-5/CON-3). default on · scope new-code

### From Beck — *Tidy First?* + the four rules

- **XP-11 · One Pile.** When code has been split into pieces too small to understand, inline it
  back together, comprehend it, then re-chunk — the sanctioned inverse of extraction, and the
  named cure for FUN-1 overshoot. default on · scope new-code · verdict adopt
- **XP-12 · Tidy first, separately.** Structural tidyings ship as separate, trivially-reviewable
  commits *before* the behavior change; tidy only where you're about to work. Refines META-1 with
  a stopping rule and Google's ratchet ("don't accept changes that degrade code health; better,
  not perfect"). default on · scope new-code

### From Boswell & Foucher — *The Art of Readable Code*

- **XP-13 · Time-till-understanding is the metric.** The measurable definition "clean" never had:
  minimize a reader's time-to-comprehension — shorter is not automatically faster to understand.
  Rationale entry backing FUN-1/MOD-4 judgments. default on · scope n/a
- **XP-14 · Units and qualifiers in names.** `delayMs`, `maxRetries`, `unsafeUrl`, `priceGbp` —
  attribute suffixes are GOOD encodings; softens N6, which bans only type/scope encodings.
  default on · scope new-code
- **XP-15 · Extract by topic, not size.** The correct extraction trigger: code solving a
  *different problem* than the function's stated goal — never line count alone. Sequential
  "paragraphs" inside one function are fine (with G34 still governing levels). Replaces the
  book's size-triggered extraction. default on · scope new-code · verdict adopt

### From Google eng-practices / TS style guide + linter practice

- **XP-16 · Complexity caps over length caps.** Cognitive complexity ≤15 per function (Sonar
  S3776) as the primary mechanical gate — it penalizes nesting, leaves guard clauses free, and
  tolerates moderate length; cyclomatic ≤10–20 as secondary. The modern resolution of the
  function-size war. default on · scope new-code · params: cognitive 15, cyclomatic 20.
- **XP-17 · Only throw `Error`; empty catch justifies itself.** Never throw/reject non-Error
  values; a swallowing catch carries an explanatory comment or it's a finding (ties HR-2).
  default on · scope everywhere · verdict adopt
- **XP-18 · No `any`; `unknown` at boundaries.** `any` is an overridden safety (G4) in type
  form; `unknown` + narrowing at edges. Simplest type construct that works — no clever mapped
  types where an interface suffices. default on · scope new-code · verdict adopt
- **XP-19 · Functions and plain data over class ceremony.** No container classes for
  namespacing; file scope + named exports; interfaces for data. (Google TS; confirms DAT-1.)
  default on · scope new-code

## 15 · House rules — the mechanism, with earned DWLF seeds

Repo standards files may add rules no book wrote. Three candidates already earned by production
wounds (from the second brain, style-level only — domain rules belong in the charter):

- **HR-1 · No hand-written field whitelists without a completeness guard.** Three documented
  instances of a whitelist silently dropping fields (notification metadata extraction, persisted
  result `Item`, `getRecentEvents` projection). A whitelist needs a test asserting parity with its
  source shape, or generation from it.
- **HR-2 · Fail loud, not open.** Swallowing errors into a plausible zero (`[]`, `null`, skip)
  hid every bug in one 6-Aug class; a degraded read renders DEGRADED, not "0 results."
- **HR-3 · Every list read paginates.** A 2,502-of-3,017 truncation ran silently in production;
  any query/scan-shaped read handles its pagination token or asserts single-page.

## 16 · Interview design notes

- **Profile question first** (lib / service / frontend) — sets defaults and thresholds.
- **The `ask` list** (the only toggles the interview raises): FUN-1 function-size params ·
  COM-1 comment posture · G5 DRY aggressiveness · FMT-2 file-size params · MOD-4 granularity
  stance · plus any params the repo scan (below) suggests overriding.
- **Scan before asking** (the `arch init` trick): measure the repo — median/p95 function length,
  arg counts, file sizes, existing violation counts per candidate standard — so every question is
  "your p95 is 80; propose 80?" and every adoption states its existing-violation cost, which
  drives the `new-code` vs `everywhere` scope choice.
- **Threshold reference for the scan** (industry brackets; ESLint ships all size rules OFF in
  `recommended` — teams opt in per repo, which is exactly this catalog's toggle model):

  | Metric | ESLint default | Sonar default | Common strict |
  |---|---|---|---|
  | Cyclomatic complexity / fn | 20 | 10 (S1541) | 10 |
  | Cognitive complexity / fn | — | 15 (S3776) | 15 |
  | Lines / function | 50 | 200 (S138) | 50–80 |
  | Lines / file | 300 | 1000 (S104) | 300–500 |
  | Parameters | 3 | 7 (S107) | 3–4 |
  | Nesting depth | 4 | (in S3776) | 3–4 |

  Both ends of each bracket sit an order of magnitude above the book's 2–4 lines / 0 args.
- **Selection doc format:** each selected entry gets `adopted | adapted (delta) | rejected (why)`,
  a date, and — where adapted — its params. Rejected entries stay listed so the review never
  re-litigates them.
