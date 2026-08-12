import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoProfile } from './standardsCatalog.js';
import type { StandardsSelections, StandardsThresholds } from './standards.js';

/**
 * The deterministic half of a repo's standards.
 *
 * Roughly a quarter of the catalog is mechanical — lengths, counts, nesting,
 * banned constructs — and none of it should ever cost an LLM a finding slot.
 * This module derives those rules from the SAME selections that produced
 * STANDARDS.md, so the two enforcement mechanisms cannot drift: change a stance
 * or a threshold in the interview and both the prose and the lint rules move.
 *
 * Emitted as a FRAGMENT to spread into the repo's existing config, never a
 * competing config file — a generator that clobbers hand-written work is one
 * people run once and then never again.
 */

/** Rules that change the SHAPE of code — a pending violation invalidates judgment findings about the same code. */
export const STRUCTURAL_RULES = new Set(['max-lines-per-function', 'max-lines', 'max-params', 'max-depth', 'complexity']);

export interface EmittedRule {
  /** ESLint rule name. */
  name: string;
  /** Config value, already severity-applied. */
  value: unknown;
  /** The catalog standard this derives from — printed as a comment so the link survives. */
  from: string;
}

export type LintSeverity = 'warn' | 'error';

/**
 * Derive the ESLint rules implied by a repo's standards selections. Only
 * BASE-ESLint rules are emitted: a fragment that needs a plugin the repo hasn't
 * installed is a broken config, so plugin-dependent equivalents (notably
 * cognitive complexity, which is FUN-1's *primary* gate) are surfaced as
 * commented suggestions instead.
 */
export function deriveRules(selections: StandardsSelections, severity: LintSeverity = 'warn'): EmittedRule[] {
  const rules: EmittedRule[] = [];
  const t: StandardsThresholds = selections.thresholds;
  const fun1 = selections.askChoices['FUN-1'] ?? 'balanced';
  const fmt2 = selections.askChoices['FMT-2'] ?? 'threshold';

  if (fun1 !== 'off') {
    // 'strict' takes the book's small-functions posture; 'balanced' uses the
    // repo's own chosen backstop with a cyclomatic cap alongside it.
    const maxLines = fun1 === 'strict' ? 20 : t.fnMax;
    const maxComplexity = fun1 === 'strict' ? 10 : 20;
    rules.push({
      name: 'max-lines-per-function',
      value: [severity, { max: maxLines, skipBlankLines: true, skipComments: true }],
      from: 'FUN-1 · Function size',
    });
    rules.push({ name: 'complexity', value: [severity, maxComplexity], from: 'XP-16 · Complexity caps over length caps (cyclomatic)' });
  }

  if (fmt2 !== 'off') {
    rules.push({
      name: 'max-lines',
      value: [severity, { max: t.fileMax, skipBlankLines: true, skipComments: true }],
      from: 'FMT-2 · Small files',
    });
  }

  rules.push({ name: 'max-depth', value: [severity, 3], from: 'FUN-2 · Shallow nesting' });
  rules.push({ name: 'max-params', value: [severity, 3], from: 'F1 · Few arguments' });
  rules.push({ name: 'no-unused-vars', value: [severity, { argsIgnorePattern: '^_' }], from: 'G12 · No clutter' });
  rules.push({ name: 'no-unreachable', value: severity, from: 'G9 · Dead code' });
  rules.push({ name: 'no-negated-condition', value: severity, from: 'G29 · Positive conditionals' });
  rules.push({ name: 'no-throw-literal', value: severity, from: 'XP-17 · Only throw Error' });

  return rules;
}

/** Plugin-dependent rules worth adopting — emitted as commented suggestions, never active. */
const SUGGESTED: { name: string; value: string; from: string; needs: string }[] = [
  { name: 'sonarjs/cognitive-complexity', value: "['warn', 15]", from: 'FUN-1 — the PRIMARY gate (nesting-aware; guard clauses free)', needs: 'eslint-plugin-sonarjs' },
  { name: '@typescript-eslint/no-explicit-any', value: "'warn'", from: 'XP-18 · No any; unknown at boundaries', needs: 'typescript-eslint (TS repos)' },
  { name: '@typescript-eslint/ban-ts-comment', value: "'warn'", from: 'G4 · No overridden safeties', needs: 'typescript-eslint (TS repos)' },
  { name: 'jest/no-disabled-tests', value: "'warn'", from: 'T4 · A skipped test is a question, not a silencer', needs: 'eslint-plugin-jest' },
];

/** True when the repo's package.json declares ESM, so the fragment matches its module system. */
export function usesEsm(repoRoot: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
    return pkg.type === 'module';
  } catch {
    return false; // no/unreadable manifest — CommonJS is the safer default
  }
}

function formatValue(v: unknown): string {
  return JSON.stringify(v).replace(/"([^"]+)":/g, '$1: ').replace(/,(?=\S)/g, ', ').replace(/"/g, "'");
}

/**
 * Render the fragment. `spreadHint` shows the user exactly how to wire it into
 * the config they already have — the step people otherwise skip.
 */
export function generateEslintFragment(opts: {
  repoName: string;
  profile: RepoProfile;
  selections: StandardsSelections;
  esm: boolean;
  severity?: LintSeverity;
  date?: string;
}): string {
  const severity = opts.severity ?? 'warn';
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const rules = deriveRules(opts.selections, severity);
  const exportLine = opts.esm ? 'export const standardsRules =' : 'const standardsRules =';
  const tail = opts.esm ? 'export default standardsRules;\n' : 'module.exports = { standardsRules };\n';

  const lines: string[] = [];
  lines.push('/**');
  lines.push(` * ${opts.repoName} — the mechanical half of STANDARDS.md, as ESLint rules.`);
  lines.push(' *');
  lines.push(` * GENERATED by \`lgtm standards init\` on ${date} — do not edit by hand.`);
  lines.push(' * Change a stance or threshold in STANDARDS.md and re-run init; both move together.');
  lines.push(' *');
  lines.push(` * Severity is "${severity}" on purpose: adopting thresholds on an existing codebase`);
  lines.push(' * lights up legacy that predates them. Standards are new-code scoped, so lint the');
  lines.push(' * diff rather than the world in CI:');
  lines.push(' *     npx eslint $(git diff --name-only origin/main... | grep -E "\\.[jt]sx?$")');
  lines.push(' *');
  lines.push(' * Wire it into your existing flat config:');
  lines.push(` *     ${opts.esm ? "import standardsRules from './.lgtm/standards.eslint.js';" : "const { standardsRules } = require('./.lgtm/standards.eslint.js');"}`);
  lines.push(' *     // then inside your config object:  rules: { ...standardsRules, ...yourOverrides }');
  lines.push(' */');
  lines.push('');
  lines.push(`${exportLine} {`);
  for (const r of rules) {
    lines.push(`  // ${r.from}`);
    lines.push(`  '${r.name}': ${formatValue(r.value)},`);
  }
  lines.push('};');
  lines.push('');
  lines.push('/* Worth adopting, but each needs a plugin this fragment cannot assume is installed:');
  for (const s of SUGGESTED) {
    lines.push(`     '${s.name}': ${s.value},   // ${s.from} — needs ${s.needs}`);
  }
  lines.push('*/');
  lines.push('');
  lines.push(tail);
  return lines.join('\n');
}

// --- Running ESLint over a target ------------------------------------------

export interface LintFinding {
  file: string;
  line: number;
  rule: string;
  message: string;
  severity: 'warning' | 'error';
}

/** True when the repo has a flat or legacy ESLint config we can run against. */
export function hasEslintConfig(repoRoot: string): boolean {
  return ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs'].some((f) =>
    existsSync(join(repoRoot, f))
  );
}

/** Parse `eslint --format json` output into findings. Never throws — lint is best-effort context. */
export function parseEslintJson(raw: string): LintFinding[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: LintFinding[] = [];
    for (const file of parsed) {
      for (const m of file.messages ?? []) {
        if (!m.ruleId) continue; // parse errors carry no rule — not a standards finding
        out.push({
          file: String(file.filePath ?? ''),
          line: Number(m.line) || 1,
          rule: String(m.ruleId),
          message: String(m.message ?? ''),
          severity: m.severity === 2 ? 'error' : 'warning',
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Split findings into the structural ones (which invalidate judgment) and the rest. */
export function partitionStructural(findings: LintFinding[]): { structural: LintFinding[]; other: LintFinding[] } {
  const structural: LintFinding[] = [];
  const other: LintFinding[] = [];
  for (const f of findings) (STRUCTURAL_RULES.has(f.rule) ? structural : other).push(f);
  return { structural, other };
}
