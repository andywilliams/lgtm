/**
 * The clean-code standards CATALOG — every candidate standard a repo might adopt,
 * distilled from Clean Code (Martin, 2008) and its strongest counterpoint sources
 * (Ousterhout, Fowler, Beck, Boswell & Foucher, Google eng-practices, linter
 * conventions). Full per-entry rationale, page refs and the contested-positions
 * record live in docs/clean-code-catalog.md — this module is the operational
 * subset: the one-line ENFORCEABLE form of each rule, its default, and the few
 * genuinely contested toggles the `standards init` interview asks about.
 *
 * Catalog ≠ selection: a repo's STANDARDS.md records the *choices* (adopted /
 * adapted / rejected, dated). The catalog seeds the interview; it does not bound
 * the doc — repos add house rules no book wrote.
 *
 * Ids reuse the book's Ch17 smell codes (G30, F3, N7…) so a `(standard G30)`
 * finding cites both the repo doc and the book; minted ids use theme prefixes
 * (FUN-, ERR-, XP- for counterpoint-source entries, …).
 */

export type StandardDefault = 'on' | 'off' | 'ask';
export type StandardScope = 'new-code' | 'everywhere';
export type RepoProfile = 'lib' | 'service' | 'frontend';

export interface AskOption {
  /** Stable answer value — what an --answers file supplies. */
  value: string;
  label: string;
  /** The rule line written into STANDARDS.md when this stance is chosen ('' = record as not-enforced). */
  rule: string;
}

export interface CatalogEntry {
  id: string;
  group: string;
  title: string;
  /** The enforceable one-line rule as adapted for modern TypeScript — this line lands in STANDARDS.md. */
  rule: string;
  default: StandardDefault;
  scope: StandardScope;
  /** default:'off' entries worth recording in the doc so reviews never raise them. */
  offReason?: string;
  /** Interview question for default:'ask' entries. options[0] is the recommended stance. */
  ask?: { question: string; options: AskOption[] };
  /** Per-profile default overrides (e.g. boundary learning-tests off for frontend). */
  profiles?: Partial<Record<RepoProfile, 'on' | 'off'>>;
}

/** Ordered groups as they appear in a generated STANDARDS.md. */
export const GROUPS: { key: string; title: string; note?: string }[] = [
  { key: 'posture', title: 'Posture', note: 'Working culture — context for reviews, rarely findings in themselves.' },
  { key: 'naming', title: 'Naming' },
  { key: 'functions', title: 'Functions' },
  { key: 'comments', title: 'Comments' },
  { key: 'formatting', title: 'Formatting & file shape' },
  { key: 'data', title: 'Data, abstraction & coupling' },
  { key: 'errors', title: 'Error handling' },
  { key: 'boundaries', title: 'Boundaries (third-party code)' },
  { key: 'tests', title: 'Tests' },
  { key: 'modules', title: 'Modules & cohesion' },
  { key: 'design', title: 'Design & change' },
  { key: 'concurrency', title: 'Concurrency & async' },
  { key: 'hygiene', title: 'General hygiene' },
];

// Threshold placeholders substituted at doc-generation time: {fnWarn} {fnMax} {fileWarn} {fileMax}
export const CATALOG: CatalogEntry[] = [
  // --- Posture ---------------------------------------------------------------
  { id: 'META-1', group: 'posture', title: 'Boy Scout Rule, tidied first', rule: 'Leave every touched module a little cleaner; ship structural tidyings as separate commits before the behavior change, and only where you are already working.', default: 'on', scope: 'new-code' },
  { id: 'META-2', group: 'posture', title: 'Later equals never', rule: 'Do not merge a working mess with a promised follow-up — clean it in this PR.', default: 'on', scope: 'new-code' },
  { id: 'META-5', group: 'posture', title: 'Code without tests is not clean', rule: 'Untested code fails the definition of done regardless of elegance.', default: 'on', scope: 'new-code' },

  // --- Naming ----------------------------------------------------------------
  { id: 'N1', group: 'naming', title: 'Intention-revealing names', rule: 'A name says why it exists, what it does, how it is used; if it needs a comment to explain it, the name failed. Re-evaluate names as meaning drifts.', default: 'on', scope: 'new-code' },
  { id: 'N2', group: 'naming', title: 'Name at the right abstraction level', rule: 'Do not name after the implementation (DynamoStore, fetchFromS3) when the abstraction is the store/loader the caller thinks in.', default: 'on', scope: 'new-code' },
  { id: 'N3', group: 'naming', title: 'Standard nomenclature', rule: 'Use ecosystem idiom (handler, reducer, toJSON) and the project domain vocabulary, consistently across the estate.', default: 'on', scope: 'new-code' },
  { id: 'N4', group: 'naming', title: 'Unambiguous over short', rule: 'A long precise name beats a vague short one; actively ask what else a name could be misread to mean.', default: 'on', scope: 'new-code' },
  { id: 'N5', group: 'naming', title: 'Name length matches scope', rule: '`i` in a five-line loop is fine; exports and shared APIs get full, searchable words.', default: 'on', scope: 'new-code' },
  { id: 'N6', group: 'naming', title: 'No type/scope encodings — but units are welcome', rule: 'No Hungarian, no m_/IFoo/TFoo prefixes (the type system carries the type). Attribute qualifiers ARE good names: delayMs, maxRetries, priceGbp, unsafeHtml.', default: 'on', scope: 'new-code' },
  { id: 'N7', group: 'naming', title: 'Names describe side effects', rule: 'getOrCreateClient, not getClient, when it lazily creates, caches, or writes.', default: 'on', scope: 'new-code' },
  { id: 'G20', group: 'naming', title: 'Function names say what they do', rule: 'If you must read the body to know what a call does (units? mutation?), the name failed.', default: 'on', scope: 'new-code' },
  { id: 'NAM-1', group: 'naming', title: 'No disinformation', rule: 'No false clues: no container types baked into names, no near-identical names for different things, never lone l or O.', default: 'on', scope: 'new-code' },
  { id: 'NAM-2', group: 'naming', title: 'Meaningful distinctions', rule: 'Different names must mean different things — no Product/ProductInfo/ProductData, no noise suffixes.', default: 'on', scope: 'new-code' },
  { id: 'NAM-3', group: 'naming', title: 'One word per concept; no puns', rule: 'Pick one of fetch/get/retrieve per concept estate-wide; never reuse one word for two ideas.', default: 'on', scope: 'new-code' },
  { id: 'NAM-4', group: 'naming', title: 'Context via structure, not prefixes', rule: 'Group related names in modules/types (Address.firstName), never prefix-encode (addrFirstName); no app-initial prefixes.', default: 'on', scope: 'new-code' },
  { id: 'NAM-5', group: 'naming', title: 'Pronounceable, not cute', rule: 'No genymdhms; no joke names; say what you mean.', default: 'on', scope: 'new-code' },
  { id: 'NAM-6', group: 'naming', title: 'Nouns for things, verbs for actions', rule: 'Types/modules are noun phrases (Manager/Processor/utils names signal responsibility aggregation); functions are verb phrases; is/has for predicates.', default: 'on', scope: 'new-code' },

  // --- Functions -------------------------------------------------------------
  {
    id: 'FUN-1', group: 'functions', title: 'Function size', rule: 'Cognitive complexity ≤15 per function is the primary gate (nesting penalized, guard clauses free); length is a backstop: warn >{fnWarn} lines, finding >{fnMax}.',
    default: 'ask', scope: 'new-code',
    ask: {
      question: 'Function size: the book says 2–4 lines; modern practice gates on cognitive complexity instead. Which stance?',
      options: [
        { value: 'balanced', label: 'Balanced (recommended) — cognitive complexity ≤15 primary, length backstop', rule: 'Cognitive complexity ≤15 per function is the primary gate (nesting penalized, guard clauses free); length is a backstop: warn >{fnWarn} lines, finding >{fnMax}.' },
        { value: 'strict', label: 'Book-strict — small functions aggressively', rule: 'Functions stay small and single-purpose — flag anything over ~20 lines that can be decomposed without scattering its logic; cognitive complexity ≤10.' },
        { value: 'off', label: 'No size standard — judge by G30/G34 only', rule: '' },
      ],
    },
  },
  { id: 'FUN-2', group: 'functions', title: 'Shallow nesting', rule: 'Prefer guard clauses and early returns; nesting deeper than 3 levels (async try/catch counts) is a finding.', default: 'on', scope: 'new-code' },
  { id: 'G30', group: 'functions', title: 'Do one thing', rule: 'A function whose body is a series of sections does several things — delegate each; handlers orchestrate only. Test: if you can extract a function whose name is not a restatement, it was doing too much.', default: 'on', scope: 'new-code' },
  { id: 'G34', group: 'functions', title: 'One level of abstraction per function', rule: 'Statements sit one level below the function name — no business intent mixed with wire formatting.', default: 'on', scope: 'new-code' },
  { id: 'FUN-3', group: 'functions', title: 'Stepdown order', rule: 'Entry points/exports first, helpers after, caller above callee — but order for the reader, never contort code for narrative flow.', default: 'on', scope: 'new-code' },
  { id: 'XP-15', group: 'functions', title: 'Extract by topic, not size', rule: 'Extract when code solves a DIFFERENT problem than the function\'s stated goal — never on line count alone; sequential paragraphs inside one function are fine.', default: 'on', scope: 'new-code' },
  { id: 'XP-11', group: 'functions', title: 'One Pile', rule: 'When logic is fragmented across pieces too small to understand, inlining them back together and re-chunking is the correct refactoring, not a regression.', default: 'on', scope: 'new-code' },
  { id: 'F1', group: 'functions', title: 'Few arguments', rule: 'Max 3 positional args; past 2–3, a typed options object or a value object for the travelling clump. Few EXPLICIT args beat zero args fed by hidden state.', default: 'on', scope: 'new-code' },
  { id: 'XP-7', group: 'functions', title: 'Data clumps', rule: 'The same 3+ values travelling together become a typed value object.', default: 'on', scope: 'new-code' },
  { id: 'F2', group: 'functions', title: 'No output arguments', rule: 'Do not mutate parameters — return new values.', default: 'on', scope: 'new-code' },
  { id: 'F3', group: 'functions', title: 'No flag or selector arguments', rule: 'A bare boolean/mode argument declares the function does N things — split it (named option objects like {dryRun:true} acceptable at API edges).', default: 'on', scope: 'new-code' },
  { id: 'FUN-4', group: 'functions', title: 'Command–query separation', rule: 'A function does something or answers something, never both.', default: 'on', scope: 'new-code' },
  { id: 'FUN-5', group: 'functions', title: 'No hidden side effects', rule: 'No sneaky state mutation (module state across warm invocations included); if temporal coupling exists, the name admits it.', default: 'on', scope: 'new-code' },
  { id: 'G23', group: 'functions', title: 'One switch per selection', rule: 'Exhaustive discriminated-union switch with a never guard is idiomatic and preferred; the same type-dispatch must not repeat across modules — one switch/registry per selection.', default: 'on', scope: 'new-code' },
  { id: 'G19', group: 'functions', title: 'Explanatory variables', rule: 'Break calculations into named intermediates — hard to overdo.', default: 'on', scope: 'new-code' },
  { id: 'G28', group: 'functions', title: 'Encapsulate conditionals', rule: 'if (shouldBeDeleted(timer)) over inline compound boolean logic.', default: 'on', scope: 'new-code' },
  { id: 'G29', group: 'functions', title: 'Positive conditionals', rule: 'isEnabled over !isDisabled; double-negative flags are a config-bug factory.', default: 'on', scope: 'new-code' },
  { id: 'G31', group: 'functions', title: 'No hidden temporal coupling', rule: 'Make call-order structural — thread results through returns, not shared mutable state across sequential awaits.', default: 'on', scope: 'new-code' },
  { id: 'G33', group: 'functions', title: 'Encapsulate boundary arithmetic', rule: 'Name the ±1s once (lookbackStart) instead of scattering them through expressions.', default: 'on', scope: 'new-code' },
  { id: 'XP-16', group: 'functions', title: 'Complexity caps over length caps', rule: 'Cognitive complexity ≤15 / cyclomatic ≤20 per function; the caps that reward guard clauses and punish nesting.', default: 'on', scope: 'new-code' },

  // --- Comments --------------------------------------------------------------
  {
    id: 'COM-1', group: 'comments', title: 'Comment posture', rule: 'First try to express it in code (names, types, extraction); but WHY-comments — intent, rationale, warnings, links to incidents/decisions — are encouraged, not failures.',
    default: 'ask', scope: 'new-code',
    ask: {
      question: 'Comment posture: the book says comments are failures; Ousterhout/Google want rationale and interface comments. Which stance?',
      options: [
        { value: 'why', label: 'Why-comments encouraged (recommended) — code first, rationale welcome', rule: 'First try to express it in code (names, types, extraction); but WHY-comments — intent, rationale, warnings, links to incidents/decisions — are encouraged, not failures.' },
        { value: 'strict', label: 'Book-strict — minimize comments, prefer expressive code', rule: 'Comments are a last resort: every comment is a failure to express it in code — extract and rename first; only rationale that code cannot carry survives.' },
        { value: 'docs-heavy', label: 'Docs-heavy — interface comments required on every non-trivial export', rule: 'Every non-trivial exported function/type carries an interface comment (what callers must know beyond the signature); implementation comments record the non-obvious.' },
      ],
    },
  },
  { id: 'C2', group: 'comments', title: 'No obsolete or misleading comments', rule: 'A comment that drifted from the code is worse than none (async: resolves WHEN vs IF); update or delete on touch.', default: 'on', scope: 'new-code' },
  { id: 'C3', group: 'comments', title: 'No redundant comments', rule: 'Nothing that restates the code or the type annotation; comments say what code cannot.', default: 'on', scope: 'new-code' },
  { id: 'C1', group: 'comments', title: 'No metadata in comments', rule: 'Change logs, authors, position banners, closing-brace markers: git and structure own these. A file needing section banners needs splitting.', default: 'on', scope: 'new-code' },
  { id: 'C5', group: 'comments', title: 'No commented-out code', rule: 'Delete it — everywhere, including IaC/config files. Version control remembers.', default: 'on', scope: 'everywhere' },
  { id: 'C4', group: 'comments', title: 'Comments worth writing are written well', rule: 'Brief, precise, next to the code they describe; systemwide facts (env defaults, infra values) are documented at their source, not in distant comments.', default: 'on', scope: 'new-code' },
  { id: 'COM-2', group: 'comments', title: 'Docs on the public surface only', rule: 'TSDoc on exported/published API; no mandated doc blocks on internals — enforced doc-everything propagates lies.', default: 'on', scope: 'new-code' },
  { id: 'COM-3', group: 'comments', title: 'TODOs carry tickets and get swept', rule: 'A TODO is not an excuse to leave bad code; no bare TODOs — link an issue; sweep regularly.', default: 'on', scope: 'new-code' },

  // --- Formatting ------------------------------------------------------------
  { id: 'FMT-1', group: 'formatting', title: 'The formatter is the standard', rule: 'One committed formatter+linter config per repo, enforced in CI; style (incl. line width) is never argued in review.', default: 'on', scope: 'everywhere' },
  {
    id: 'FMT-2', group: 'formatting', title: 'Small files', rule: 'Judged by responsibility first, lines second: warn >{fileWarn} lines, finding >{fileMax}.',
    default: 'ask', scope: 'new-code',
    ask: {
      question: 'File size: the book says ~200 lines typical / 500 upper. Enforce a line threshold?',
      options: [
        { value: 'threshold', label: 'Yes (recommended) — soft thresholds, responsibility judged first', rule: 'Judged by responsibility first, lines second: warn >{fileWarn} lines, finding >{fileMax}.' },
        { value: 'off', label: 'No line threshold — judge by MOD-2 responsibilities only', rule: '' },
      ],
    },
  },
  { id: 'FMT-3', group: 'formatting', title: 'Newspaper order and vertical grouping', rule: 'High-level first, detail downward; related lines vertically dense, concepts separated by blank lines; declare variables at first use.', default: 'on', scope: 'new-code' },

  // --- Data, abstraction & coupling -------------------------------------------
  { id: 'G36', group: 'data', title: 'Demeter, with the data exemption', rule: 'No reaching through a collaborator\'s returns (a.getB().getC().do()) — but dotting into plain DTOs, event payloads, config and API responses is exempt; the rule bites only on behavioral objects.', default: 'on', scope: 'new-code' },
  { id: 'DAT-1', group: 'data', title: 'Data + functions, or polymorphic types — chosen, not mixed', rule: 'Plain typed records through pure functions is legitimate design; discriminated unions/classes when new variants are expected. No hybrids (mutable public fields + business methods); no container classes for namespacing.', default: 'on', scope: 'new-code' },
  { id: 'DAT-2', group: 'data', title: 'Tell, don\'t ask (behavioral objects)', rule: 'Expose repo.saveSnapshot(x); don\'t hand callers a client + table name to compose operations.', default: 'on', scope: 'new-code' },
  { id: 'G6', group: 'data', title: 'Right level of abstraction', rule: 'No transport/SDK specifics leaking into domain interfaces; lower-level detail lives wholly in lower-level modules.', default: 'on', scope: 'new-code' },
  { id: 'G8', group: 'data', title: 'Small interfaces, no leakage', rule: 'Export the minimum per module; one design decision reflected in multiple modules is leakage — encapsulate it in one place.', default: 'on', scope: 'new-code' },
  { id: 'G7', group: 'data', title: 'Dependency direction is one-way', rule: 'A shared lib/base package never imports from, or knows the names of, its consumers.', default: 'on', scope: 'everywhere' },
  { id: 'G13', group: 'data', title: 'No artificial coupling', rule: 'Shared types/constants don\'t live in one handler\'s module and get imported cross-service; put them where they belong.', default: 'on', scope: 'new-code' },
  { id: 'G14', group: 'data', title: 'Feature envy', rule: 'A function that mostly manipulates another module\'s data belongs there (formatters/serializers exempt).', default: 'on', scope: 'new-code' },
  { id: 'G17', group: 'data', title: 'Least-surprise placement', rule: 'Code lives where a reader would look first.', default: 'on', scope: 'new-code' },
  { id: 'G18', group: 'data', title: 'Inject behavior you may want to vary', rule: 'Hard-bound free functions are fine for Math.max-class utilities; where variants are plausible, take the behavior as a parameter.', default: 'on', scope: 'new-code' },
  { id: 'G22', group: 'data', title: 'Logical dependencies made physical', rule: 'Don\'t assume another module\'s page size/batch limit/schema — read its exported constant/config or ask its API.', default: 'on', scope: 'new-code' },
  { id: 'G26', group: 'data', title: 'Be precise', rule: 'Handle the possible null; never float money (integer minor units); conditional writes where concurrent update is possible; multi-row results handled explicitly.', default: 'on', scope: 'new-code' },
  { id: 'G27', group: 'data', title: 'Structure over convention', rule: 'Let the type system enforce decisions: required members, exhaustive never-checks, branded types — better than naming conventions.', default: 'on', scope: 'new-code' },
  { id: 'G32', group: 'data', title: 'Don\'t be arbitrary', rule: 'Structure communicates reasons; arbitrary-looking layout invites arbitrary change.', default: 'on', scope: 'new-code' },
  { id: 'XP-3', group: 'data', title: 'No temporal decomposition', rule: 'Structure modules by knowledge, not execution order — no read/process/write module triads.', default: 'on', scope: 'new-code' },
  { id: 'XP-4', group: 'data', title: 'Pull complexity downwards', rule: 'Handle awkward cases inside the module rather than exporting config/flags/preconditions to every caller.', default: 'on', scope: 'new-code' },
  { id: 'XP-8', group: 'data', title: 'Primitive obsession', rule: 'Domain concepts (money, symbol ids, timeframes) get types — branded/opaque in TS — not bare strings and numbers.', default: 'on', scope: 'new-code' },
  { id: 'XP-10', group: 'data', title: 'No global or shared mutable data', rule: 'Module-level mutable singletons and shared mutable state are smells at any dose — warm-invocation module state included.', default: 'on', scope: 'new-code' },

  // --- Error handling ---------------------------------------------------------
  { id: 'ERR-1', group: 'errors', title: 'Errors must not obscure logic', rule: 'Error handling is one thing: centralize in wrappers/middleware; a function that handles errors does nothing else; extract try/catch bodies.', default: 'on', scope: 'new-code' },
  { id: 'ERR-2', group: 'errors', title: 'One error strategy, no sentinels', rule: 'Thrown errors handled at a boundary, or an explicit Result type used consistently — never ad-hoc {ok:false}/magic-value returns scattered per function.', default: 'on', scope: 'new-code' },
  { id: 'ERR-3', group: 'errors', title: 'Errors carry context, classified by caller\'s needs', rule: 'Operation, identifiers, cause chain; a small taxonomy keyed to handling decisions (retryable / user-input / fatal), not a mirror of upstream error types.', default: 'on', scope: 'new-code' },
  { id: 'ERR-4', group: 'errors', title: 'Design errors out; special case over exceptional flow', rule: 'Expected absences return neutral objects/empty collections, not thrown-and-caught NotFound; where API design can make the error case impossible (clamping, idempotent ops), prefer that.', default: 'on', scope: 'new-code' },
  { id: 'ERR-5', group: 'errors', title: 'Absence is typed; collections never nullish', rule: 'T | undefined under strictNullChecks; [] never undefined/null for lists; normalize SDK optionality at the adapter.', default: 'on', scope: 'new-code' },
  { id: 'ERR-6', group: 'errors', title: 'Don\'t pass null', rule: 'Non-optional parameter types by default; validate payloads at the edge so interior functions never see nullish.', default: 'on', scope: 'new-code' },
  { id: 'XP-17', group: 'errors', title: 'Only throw Error; empty catch justifies itself', rule: 'Never throw/reject non-Error values; a swallowing catch carries an explanatory comment or it is a finding.', default: 'on', scope: 'everywhere' },

  // --- Boundaries -------------------------------------------------------------
  { id: 'BND-1', group: 'boundaries', title: 'Wrap third-party code; few touch points', rule: 'SDK clients, raw command/response shapes and vendor error zoos stay inside a small adapter layer translating to types you own; never in public signatures.', default: 'on', scope: 'new-code' },
  { id: 'BND-2', group: 'boundaries', title: 'Learning and boundary tests', rule: 'Explore a new dependency with tests, keep them, rerun on version bumps — a behavior change fails a test, not production.', default: 'on', scope: 'new-code', profiles: { frontend: 'off' } },
  { id: 'BND-3', group: 'boundaries', title: 'Wish-driven interfaces + adapter seam', rule: 'Define the interface you wish you had, code against it, adapt the vendor behind it; the seam takes in-memory fakes in tests.', default: 'on', scope: 'new-code' },

  // --- Tests ------------------------------------------------------------------
  { id: 'TST-1', group: 'tests', title: 'Test code is first-class', rule: 'Same cleanliness/lint/review standards as production (efficiency may differ); rotting tests rot the code.', default: 'on', scope: 'new-code' },
  { id: 'TST-2', group: 'tests', title: 'Tests read as intent', rule: 'Arrange/act/assert; setup noise behind grown-by-refactoring helpers; table-driven where the pattern of cases carries meaning.', default: 'on', scope: 'new-code' },
  { id: 'TST-3', group: 'tests', title: 'One concept per test', rule: 'Minimal asserts per concept — one toEqual on a whole object satisfies it; plain explicit tests beat clever DSL compression.', default: 'on', scope: 'new-code' },
  { id: 'TST-4', group: 'tests', title: 'F.I.R.S.T.', rule: 'Fast (in-memory default suite), Independent (no shared state/order), Repeatable (offline, injected clocks), Self-validating (assert values, never eyeballed logs), Timely (spec with the code, forcing testable shape).', default: 'on', scope: 'new-code' },
  { id: 'T1', group: 'tests', title: 'Test what could break — especially boundaries', rule: '"Seems like enough" is not a metric; every boundary condition gets a test (empty inputs, off-by-ones, time edges, pagination seams); validate calculations against known real data.', default: 'on', scope: 'new-code' },
  { id: 'T2', group: 'tests', title: 'Coverage as gap-finder', rule: 'Coverage runs in CI to find untested branches (uncovered catch bodies especially) — a diagnostic, not a vanity gate.', default: 'on', scope: 'everywhere' },
  { id: 'T3', group: 'tests', title: 'Don\'t skip trivial tests', rule: 'Documentary value exceeds cost (serializers, mappers, config parsing).', default: 'on', scope: 'new-code' },
  { id: 'T4', group: 'tests', title: 'A skipped test is a question, not a silencer', rule: 'test.skip/test.todo encode open requirement questions with a reason; skipping a FAILING test is an overridden safety (G4).', default: 'on', scope: 'everywhere' },
  { id: 'T6', group: 'tests', title: 'Bugs congregate', rule: 'A found bug triggers an exhaustive test battery around that function before the one-line fix ships.', default: 'on', scope: 'new-code' },
  { id: 'TST-5', group: 'tests', title: 'TDD three laws', rule: '', default: 'off', scope: 'new-code', offReason: 'Test-FIRST in strict 30-second cycles is unverifiable post-hoc and explicitly unresolved between Martin and Ousterhout; its value is folded into F.I.R.S.T. Timely. Tests themselves are non-negotiable (META-5).' },

  // --- Modules & cohesion ------------------------------------------------------
  { id: 'MOD-1', group: 'modules', title: 'Single responsibility, by change-axis', rule: 'A module/handler has one reason to change. Operational test: one module changing for many unrelated reasons splits; one conceptual change forcing edits across many files consolidates.', default: 'on', scope: 'new-code' },
  { id: 'MOD-2', group: 'modules', title: 'Size = responsibilities; the name is the test', rule: 'If you cannot name it concisely — or its one-sentence description needs an "and" — split it. utils.ts/manager.ts/helpers.ts are the smell wearing a filename.', default: 'on', scope: 'new-code' },
  { id: 'MOD-3', group: 'modules', title: 'Cohesion splits', rule: 'A cluster of functions sharing state/params the rest doesn\'t touch is its own module; exports hang together or leave.', default: 'on', scope: 'new-code' },
  { id: 'XP-1', group: 'modules', title: 'Deep modules', rule: 'Prefer simple interfaces hiding substantial implementation; flag shallow modules — pass-throughs, one-call wrappers whose interface is as complex as their body, adjacent layers with near-identical interfaces.', default: 'on', scope: 'new-code' },
  {
    id: 'MOD-4', group: 'modules', title: 'Granularity stance', rule: 'Both failure modes are findings: a module aggregating unrelated responsibilities AND a shard of one-line pass-through modules; fewest elements that tests, dedup and clarity demand.',
    default: 'ask', scope: 'new-code',
    ask: {
      question: 'Module granularity: many-small (the book) vs deep-few (Ousterhout). Which stance should reviews lean toward?',
      options: [
        { value: 'balanced', label: 'Balanced (recommended) — flag both over-aggregation and over-sharding', rule: 'Both failure modes are findings: a module aggregating unrelated responsibilities AND a shard of one-line pass-through modules; fewest elements that tests, dedup and clarity demand.' },
        { value: 'deep', label: 'Lean deep — bias to fewer, deeper modules', rule: 'Bias to fewer, deeper modules: over-sharding (shallow pass-through modules, interface-per-class ceremony) is the primary granularity finding; aggregation is flagged only when responsibilities visibly diverge.' },
        { value: 'small', label: 'Lean small — bias to many focused modules', rule: 'Bias to many small single-responsibility modules: aggregation is the primary granularity finding; consolidation is flagged only when fragmentation clearly obscures the logic.' },
      ],
    },
  },
  { id: 'MOD-5', group: 'modules', title: 'Open for extension', rule: 'New variants extend (union member + registry entry + new file), not edit every existing switch body; reopening a module for every variant is the design talking.', default: 'on', scope: 'new-code' },
  { id: 'MOD-6', group: 'modules', title: 'Depend on abstractions at seams', rule: 'Narrow interface types for external services, injected (parameter/factory), stubbed in tests — DIP without a framework.', default: 'on', scope: 'new-code' },
  { id: 'MOD-7', group: 'modules', title: 'Export only the API', rule: 'Loosening encapsulation is a last resort — don\'t export internals just for tests; test through the public surface or extract a module.', default: 'on', scope: 'new-code' },

  // --- Design & change ----------------------------------------------------------
  { id: 'DSN-1', group: 'design', title: 'Four rules of simple design, in order', rule: 'Passes all tests > no duplication > expresses intent > minimal entities — the review\'s tie-breaker hierarchy.', default: 'on', scope: 'new-code' },
  { id: 'DSN-2', group: 'design', title: 'Composition root', rule: 'Construction/wiring separated from use: module-scope or explicit root builds the graph (clients at cold start); no new/lookup scattered through runtime paths.', default: 'on', scope: 'new-code' },
  { id: 'DSN-3', group: 'design', title: 'Framework-free domain core', rule: 'Domain modules import zero SDK/platform; adapters at the edge translate; domain logic unit-tests without platform mocks.', default: 'on', scope: 'new-code' },
  { id: 'DSN-4', group: 'design', title: 'Simplest thing; no speculative generality', rule: 'Today\'s stories, decoupled enough to restructure; hooks/params/abstractions for imagined futures are a finding.', default: 'on', scope: 'new-code' },
  {
    id: 'G5', group: 'design', title: 'DRY, for knowledge not lines', rule: 'Duplicated algorithms/policy are the enemy — helpers, or the shared lib for cross-repo repetition. Incidental similarity is NOT duplication; when unsure, apply the Rule of Three.',
    default: 'ask', scope: 'new-code',
    ask: {
      question: 'DRY aggressiveness: strict dedup vs Rule of Three (tolerate twice, abstract on the third)?',
      options: [
        { value: 'rule-of-three', label: 'Rule of Three (recommended) — knowledge-dup only, abstraction must be real', rule: 'Duplicated algorithms/policy are the enemy — helpers, or the shared lib for cross-repo repetition. Incidental similarity is NOT duplication; when unsure, apply the Rule of Three.' },
        { value: 'strict', label: 'Strict DRY — flag duplication even in a few lines', rule: 'Eliminate duplication wherever seen, even a few lines — extract helpers immediately; cross-repo repetition goes to the shared lib.' },
        { value: 'relaxed', label: 'Relaxed — flag only large or thrice-repeated duplication', rule: 'Flag duplication only when substantial or on its third occurrence; prefer duplication over a speculative abstraction.' },
      ],
    },
  },
  { id: 'DSN-5', group: 'design', title: 'Postpone decisions / standards need demonstrable value', rule: '', default: 'off', scope: 'new-code', offReason: 'Architecture-altitude concerns — they live in ARCHITECTURE.md standing decisions and `lgtm arch`, not the standards review.' },

  // --- Concurrency & async -------------------------------------------------------
  { id: 'CON-1', group: 'concurrency', title: 'Concurrency code is separated', rule: 'Batching, locking, idempotency, retry orchestration live in dedicated modules with their own tests; business logic stays pure.', default: 'on', scope: 'new-code' },
  { id: 'CON-2', group: 'concurrency', title: 'Compound operations on shared state are atomic', rule: 'Read-then-write on a shared store is the classic trap: conditional expressions/transactions, never two calls; one module owns mutation of a given item.', default: 'on', scope: 'new-code' },
  { id: 'CON-3', group: 'concurrency', title: 'Prefer copies and independence', rule: 'Immutable data, per-invocation state, partition work by key so units never contend; narrow genuinely shared state aggressively.', default: 'on', scope: 'new-code' },
  { id: 'CON-4', group: 'concurrency', title: 'One-offs don\'t exist', rule: 'Intermittent CI flakes and sporadic prod anomalies (duplicate events, out-of-order writes) are real defects to chase, never retries to shrug off.', default: 'on', scope: 'everywhere' },
  { id: 'CON-5', group: 'concurrency', title: 'Force the interleavings in tests', rule: 'Timeouts, partial batch failures and draining are first-class test targets; jitter/fuzz ordering where races are plausible.', default: 'on', scope: 'new-code' },

  // --- General hygiene ------------------------------------------------------------
  { id: 'G4', group: 'hygiene', title: 'No overridden safeties', rule: '@ts-ignore, any-casts (unknown + narrowing instead), disabled lint rules, .skip-ed failing tests, force-merged red CI — each is a finding unless justified in place.', default: 'on', scope: 'everywhere' },
  { id: 'G25', group: 'hygiene', title: 'No magic numbers or strings', rule: 'Named constants for numbers AND the TS-dominant form: table names, event-type strings, ARN fragments, fixture IDs.', default: 'on', scope: 'new-code' },
  { id: 'G11', group: 'hygiene', title: 'Consistency', rule: 'Same shape for similar things: handler naming, response envelopes, error patterns — identical across endpoints and repos.', default: 'on', scope: 'new-code' },
  { id: 'G12', group: 'hygiene', title: 'No clutter', rule: 'Unused imports/params/vars, empty scaffolds — gone.', default: 'on', scope: 'everywhere' },
  { id: 'G9', group: 'hygiene', title: 'Dead code (incl. dead functions)', rule: 'Uncalled functions, impossible branches, retired-event handlers, never-fired flag branches: delete — git remembers.', default: 'on', scope: 'everywhere' },
  { id: 'G1', group: 'hygiene', title: 'One language per file (minimize embeds)', rule: 'Watch inline SQL/CFN-JSON/HTML inside TS files.', default: 'on', scope: 'new-code' },
  { id: 'G2', group: 'hygiene', title: 'Obvious behavior is implemented', rule: 'A parse/convert helper handles the input variants callers will reasonably assume (least surprise).', default: 'on', scope: 'new-code' },
  { id: 'G21', group: 'hygiene', title: 'Understand the algorithm', rule: 'Passing tests ≠ understanding; be able to explain why the logic is right, validated against real data — sharpened, not dulled, by AI-written code.', default: 'on', scope: 'new-code' },
  { id: 'E1', group: 'hygiene', title: 'One-command build and test', rule: 'Clone → install → build, and one test command runs the suite; manual token/setup choreography is a build-step smell (or recorded as accepted debt).', default: 'on', scope: 'everywhere' },
];

/** Book smells that do not translate to TypeScript — recorded so reviews never cite them. */
export const REJECTED: { id: string; title: string; reason: string }[] = [
  { id: 'J1', title: 'Wildcard imports', reason: 'Inverted in TS/ESM — explicit named imports win (tree-shaking, clarity).' },
  { id: 'J2', title: 'Constants via inheritance', reason: 'Java-mechanics; moot in TS — import constants from modules.' },
  { id: 'J3', title: 'Enums over int constants', reason: 'Already idiom in TS as string-literal unions / as-const objects; the Java form does not apply.' },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}

export function askEntries(): CatalogEntry[] {
  return CATALOG.filter((e) => e.default === 'ask');
}
