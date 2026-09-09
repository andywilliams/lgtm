import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Shared AI-CLI invocation. Every lgtm feature that talks to a model goes through
 * runAIPrompt: prompt in on stdin → `claude --print` or `codex exec` → raw text back.
 * Parsing stays with the caller.
 *
 * The claude path is deliberately a STRIPPED session: `--strict-mcp-config` (no MCP
 * servers, so no tool schemas in the prompt), `--setting-sources ''` (no CLAUDE.md
 * memory files or settings from the cwd — a review must not inherit the operator's
 * chat preferences), `--no-session-persistence` (no transcript written under the
 * target repo's project dir), and `--output-format json` so the real usage and cost
 * come back with the text. Measured in a DWLF repo: the bare invocation cost ~27k
 * prompt tokens before the first diff line; the stripped one ~17k on the same model.
 *
 * Stripping settings also drops whatever the operator's ~/.claude/settings.json
 * configured — the default MODEL and EFFORT (the CLI would silently fall back to its
 * own defaults) and, on some setups, `apiKeyHelper` / `env` routing. Model and effort
 * are resolved here and passed explicitly; routing keys are warned about, and
 * LGTM_CLAUDE_SETTING_SOURCES=user restores the operator's settings for a setup that
 * needs them (at the cost of also loading ~/.claude/CLAUDE.md into every review).
 */

export type AIProvider = 'claude' | 'codex';

/** Token/cost accounting for one or more model calls. */
export interface AIUsage {
  /** Uncached prompt tokens. */
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  /** Distinct model ids the CLI reported (a print run may also use a small helper model). */
  models: string[];
  calls: number;
  /** False when any call in the window had no envelope to read (codex, or a non-JSON reply). */
  measured: boolean;
}

export function emptyUsage(): AIUsage {
  return {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 0,
    models: [],
    calls: 0,
    measured: true,
  };
}

/** All prompt tokens the call was billed for, cached or not. */
export function promptTokens(u: AIUsage): number {
  return u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}

// Usage accumulates here across every call in the process; a command that logs
// metrics drains it with takeUsage() once its model work is done. A ledger rather
// than a changed return type keeps runAIPrompt's string contract for its callers.
// It is correct because the CLI runs ONE command per process and has one logging
// site; a long-lived host would need per-call usage returned instead.
let ledger: AIUsage = emptyUsage();

/** Fold one call's usage into the ledger. Exported for tests only. */
export function addUsage(u: AIUsage | null): void {
  ledger.calls += 1;
  // An unmeasured call (no envelope, or an envelope with no usage block) taints the
  // whole window: its numbers are zeros, not a bill, and must not read as one.
  if (!u || !u.measured) {
    ledger.measured = false;
    return;
  }
  ledger.inputTokens += u.inputTokens;
  ledger.cacheCreationTokens += u.cacheCreationTokens;
  ledger.cacheReadTokens += u.cacheReadTokens;
  ledger.outputTokens += u.outputTokens;
  ledger.costUsd += u.costUsd;
  ledger.durationMs += u.durationMs;
  for (const m of u.models) if (!ledger.models.includes(m)) ledger.models.push(m);
}

/** Return the usage accumulated since the last take, and reset. */
export function takeUsage(): AIUsage {
  const out = ledger;
  ledger = emptyUsage();
  return out;
}

// Anthropic ids, the [1m] suffix, Vertex `@date` ids and Bedrock ARNs (`/`, `:`).
const MODEL_ID = /^[\w.:@\/\-\[\]]+$/;
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// Settings that change WHERE or HOW the CLI authenticates; stripping them can break
// or reroute a call, so their presence is worth one warning per process. `env` counts
// only for routing variables — a telemetry or editor toggle in there is harmless.
const ROUTING_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport'];
const ROUTING_ENV = /^(ANTHROPIC_|CLAUDE_CODE_USE_|AWS_|HTTPS?_PROXY$|NO_PROXY$)/i;

/** Names of the routing-relevant settings present, e.g. ["apiKeyHelper", "env.ANTHROPIC_BASE_URL"]. */
export function routingSettings(settings: Record<string, any> | null): string[] {
  if (!settings) return [];
  const found = ROUTING_KEYS.filter((k) => k in settings);
  const env = settings.env;
  if (env && typeof env === 'object') {
    for (const k of Object.keys(env)) if (ROUTING_ENV.test(k)) found.push(`env.${k}`);
  }
  return found;
}

let settingsCache: Record<string, any> | null | undefined;

/** The operator's ~/.claude/settings.json, read once; null when absent or unreadable. */
function userSettings(): Record<string, any> | null {
  if (settingsCache !== undefined) return settingsCache;
  let loaded: Record<string, any> | null = null;
  try {
    const p = join(homedir(), '.claude', 'settings.json');
    loaded = existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null;
  } catch {
    loaded = null;
  }
  settingsCache = loaded;
  return loaded;
}

/**
 * The model to pass to `claude --model`. LGTM_MODEL wins; otherwise the operator's
 * own default from settings, so stripping settings does not change which model
 * reviews the code. Undefined ⇒ the CLI chooses, and stderr says so.
 */
export function resolveModel(settings: Record<string, any> | null = userSettings()): string | undefined {
  const fromEnv = process.env.LGTM_MODEL?.trim();
  if (fromEnv) {
    if (MODEL_ID.test(fromEnv)) return fromEnv;
    process.stderr.write(`lgtm: ignoring LGTM_MODEL=${JSON.stringify(fromEnv)} (not a model id)\n`);
  }
  const model = settings?.model;
  if (typeof model === 'string' && !MODEL_ID.test(model)) {
    process.stderr.write(`lgtm: settings.json model ${JSON.stringify(model)} is not a model id lgtm can pass through — set LGTM_MODEL\n`);
    return undefined;
  }
  return typeof model === 'string' ? model : undefined;
}

/**
 * The effort to pass to `claude --effort`. LGTM_EFFORT wins; otherwise the operator's
 * per-model override (`modelSettings.<model>.effortLevel`), then the global
 * `effortLevel` — the same precedence the CLI applies when it reads settings itself.
 */
export function resolveEffort(
  model: string | undefined,
  settings: Record<string, any> | null = userSettings()
): string | undefined {
  const fromEnv = process.env.LGTM_EFFORT?.trim().toLowerCase();
  if (fromEnv) {
    if (EFFORT_LEVELS.has(fromEnv)) return fromEnv;
    process.stderr.write(`lgtm: ignoring LGTM_EFFORT=${JSON.stringify(fromEnv)} (expected low|medium|high|xhigh|max)\n`);
  }
  // modelSettings is keyed by the bare id; `--model` may carry a suffix such as [1m].
  const bare = model?.replace(/\[.*\]$/, '');
  const perModel = bare ? settings?.modelSettings?.[bare]?.effortLevel : undefined;
  const chosen = perModel ?? settings?.effortLevel;
  return typeof chosen === 'string' && EFFORT_LEVELS.has(chosen) ? chosen : undefined;
}

/** Which of the CLI's setting sources to load. Default none; see the header comment. */
function settingSources(): string {
  return process.env.LGTM_CLAUDE_SETTING_SOURCES ?? '';
}

let warnedRouting = false;

function warnIfSettingsRoute(settings: Record<string, any> | null): void {
  if (warnedRouting || settingSources() !== '') return;
  const present = routingSettings(settings);
  if (present.length === 0) return;
  warnedRouting = true;
  process.stderr.write(
    `lgtm: ~/.claude/settings.json sets ${present.join(', ')} — lgtm runs claude without settings, ` +
      `so that routing is NOT applied. If reviews fail to authenticate, set LGTM_CLAUDE_SETTING_SOURCES=user.\n`
  );
}

/**
 * Split a `claude --print --output-format json` reply into the model's text and its
 * usage. Anything that is not that envelope (an older CLI, a provider that writes
 * plain text) comes back as-is with usage null — never lost, just unmeasured.
 * Throws when the envelope itself reports a failed run with no result to parse.
 */
export function parsePrintEnvelope(raw: string): { text: string; usage: AIUsage | null } {
  let d: any;
  try {
    d = JSON.parse(raw);
  } catch {
    return { text: raw, usage: null };
  }
  if (!d || typeof d !== 'object' || Array.isArray(d) || !('result' in d || 'is_error' in d || 'usage' in d)) {
    return { text: raw, usage: null };
  }
  const text = typeof d.result === 'string' ? d.result : '';
  const failed = d.is_error === true || (d.terminal_reason && d.terminal_reason !== 'completed');
  // On failure the result is normally a human message — "Not logged in", or
  // "API Error: 529 {...}" with the server's JSON body inline — so surface it. Only a
  // result that IS a JSON document (starts with a brace) is kept, because that is a
  // model answer the caller's repair may still salvage, not an error string.
  if (failed && !text.trimStart().startsWith('{')) {
    const why = text.trim() || d.terminal_reason || 'unknown error';
    throw new Error(`claude --print did not complete: ${why}`);
  }
  // No usage block ⇒ nothing was measured; never record that as a $0 review.
  const hasUsage = d.usage && typeof d.usage === 'object';
  const u = hasUsage ? d.usage : {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const usage: AIUsage = {
    inputTokens: num(u.input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    outputTokens: num(u.output_tokens),
    costUsd: num(d.total_cost_usd),
    durationMs: num(d.duration_ms),
    models: d.modelUsage && typeof d.modelUsage === 'object' ? Object.keys(d.modelUsage) : [],
    calls: 1,
    measured: Boolean(hasUsage),
  };
  return { text, usage };
}

export function checkClaudeCli(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function checkCodexCli(): boolean {
  try {
    execSync('codex --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function getAvailableProviders(): AIProvider[] {
  const providers: AIProvider[] = [];
  if (checkClaudeCli()) providers.push('claude');
  if (checkCodexCli()) providers.push('codex');
  return providers;
}

/** The argv for a stripped, measured `claude --print` call (execFile form — no shell). */
export function claudePrintArgs(model: string | undefined, effort: string | undefined, sources = settingSources()): string[] {
  const args = [
    '--print',
    '--output-format', 'json',
    '--strict-mcp-config',
    '--setting-sources', sources,
    '--no-session-persistence',
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

let announcedModel = false;

function runClaude(prompt: string): string {
  const settings = userSettings();
  const model = resolveModel(settings);
  const effort = resolveEffort(model, settings);
  warnIfSettingsRoute(settings);
  if (!model && !announcedModel) {
    announcedModel = true;
    process.stderr.write('lgtm: no model configured (LGTM_MODEL or ~/.claude/settings.json) — the claude CLI will pick its default.\n');
  }
  const args = claudePrintArgs(model, effort);
  try {
    const raw = execFileSync('claude', args, {
      input: prompt,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    const { text, usage } = parsePrintEnvelope(raw);
    addUsage(usage);
    return text;
  } catch (error: any) {
    // A non-zero exit usually still carries the JSON envelope on stdout; surface its
    // reason instead of the bare "Command failed: claude …". Anything that is NOT an
    // envelope (usage text from an older CLI, a stray message) stays an error.
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    if (stdout.trim()) {
      const { text, usage } = parsePrintEnvelope(stdout); // throws with the envelope's reason
      if (usage && text.trim()) {
        addUsage(usage);
        return text;
      }
    }
    throw error;
  }
}

function runCodex(prompt: string, label: string): string {
  // codex exec reads the prompt from stdin (-) and writes the last message to a file.
  // It has no usage envelope, so its calls are recorded as unmeasured.
  const tempFile = join(tmpdir(), `lgtm-${label}-${Date.now()}-${process.pid}.txt`);
  const outputFile = tempFile + '.out';
  writeFileSync(tempFile, prompt);
  try {
    execSync(`codex exec -o "${outputFile}" - < "${tempFile}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    addUsage(null);
    return readFileSync(outputFile, 'utf-8');
  } finally {
    try { unlinkSync(outputFile); } catch { /* ignore */ }
    try { unlinkSync(tempFile); } catch { /* ignore */ }
  }
}

/**
 * Run a one-shot prompt through the AI CLI and return its raw text output.
 * `label` only names codex's temp file, to keep concurrent invocations distinct.
 * Usage for the call (when the provider reports it) lands in the ledger — see takeUsage.
 */
export function runAIPrompt(prompt: string, ai: AIProvider, label = 'prompt'): string {
  try {
    return ai === 'codex' ? runCodex(prompt, label) : runClaude(prompt);
  } catch (error: any) {
    // Only claim "CLI not found" when the binary genuinely isn't runnable NOW —
    // message-sniffing ('not found' / ENOENT) misdiagnoses unrelated failures
    // (e.g. codex exiting 0 without writing its output file) as a missing install.
    const installed = ai === 'codex' ? checkCodexCli() : checkClaudeCli();
    if (!installed) {
      const cliName = ai === 'codex' ? 'Codex' : 'Claude';
      const installCmd = ai === 'codex'
        ? 'npm install -g @openai/codex'
        : 'npm install -g @anthropic-ai/claude-code';
      throw new Error(`${cliName} CLI not found. Install it: ${installCmd}`);
    }
    throw error;
  }
}
