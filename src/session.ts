import { createHash, randomUUID } from 'node:crypto';
import { resolveModel, type AIProvider, type RoundModelChoice } from './ai.js';
import type { LoopSession } from './db.js';

/**
 * What a round ASKED the CLI for, as a comparable string: 'full:<id>' (the operator's
 * default model, named), 'late:<id>' (the round policy's cheaper model) or
 * 'explicit:<id>' (--model). Compared instead of the CLI-reported id, because settings
 * may name the default as an alias ('opus', 'opusplan') and the envelope reports the
 * real id. The full model is NAMED rather than left implicit so that changing the
 * operator's default mid-loop restarts the session: the prompt cache is model-scoped,
 * and a resumed session on another model would replay its whole context uncached.
 */
export function modelRoleOf(choice: RoundModelChoice, fullModel: string | undefined = resolveModel()): string {
  const bare = (id: string) => id.replace(/\[.*\]$/, '');
  if (choice.source === 'explicit' && choice.model) return `explicit:${bare(choice.model)}`;
  if (choice.model) return `late:${bare(choice.model)}`;
  return `full:${fullModel ? bare(fullModel) : 'cli-default'}`;
}

/** Pseudo-path under which the reviewer's own system prompt is fingerprinted; a change restarts the session. */
export const SYSTEM_PROMPT_KEY = '@system-prompt';

/**
 * Tokens of context a session may hold before the next round starts a fresh one, against
 * the CLI's 1M window. Measured in the same unit the log records: the prompt text lgtm
 * SENT (chars/4) plus the replies — NOT the envelope's billed prompt_tokens, which sums
 * the CLI's internal turns and read 1.2M for a 250k prompt. The CLI compacts a
 * conversation that nears the window (measured: an 883k-token session plus a 150k
 * message came back as 228k with the whole cache lost) and a compacted session reviews
 * from a summary instead of the files, so a fresh full prompt is cheaper and better.
 */
export const SESSION_CONTEXT_BUDGET = 700_000;
const CHARS_PER_TOKEN = 4;

export interface SessionPlan {
  /** sha1 of every file's contents as sent this round (changed files and related files). */
  fileShas: Record<string, string>;
  /** The session to run in, or null when sessions are off / the provider is not claude. */
  session: { id: string; resume: boolean; changedSinceLast: Record<string, string>; unchangedFiles: string[] } | null;
  /** The round's model choice after the session decision (a continued session may keep its model). */
  choice: RoundModelChoice;
  note?: string;
}

/**
 * Decide whether this round continues the loop's session or opens one. Continue when a
 * session exists, --fresh was not given, and the session's model ROLE fits the round:
 * the same role, or the session is on the full model and the round would merely go
 * cheaper — a cached full-model turn beats an uncached cheaper one. A session on the
 * cheaper model does not carry a round the policy says needs the full one (an open
 * BUG/SECURITY, a non-chill round), and an explicit --model is honoured exactly.
 * Otherwise a new session with the full prompt. Files the session has seen are compared
 * by sha1 so a resumed round sends only what moved — related files included.
 */
export function planSession(input: {
  prior: LoopSession | null;
  contents: Record<string, string>;
  ai: AIProvider;
  fresh?: boolean;
  choice: RoundModelChoice;
  newId?: () => string;
  /** The operator's default model; defaults to the resolved one. */
  fullModel?: string;
}): SessionPlan {
  const { prior, contents, ai, fresh, choice, newId = randomUUID } = input;
  const fileShas: Record<string, string> = {};
  for (const [path, content] of Object.entries(contents)) fileShas[path] = createHash('sha1').update(content).digest('hex');
  const sessionsOff = (process.env.LGTM_SESSIONS ?? '').toLowerCase() === 'off';
  if (sessionsOff || ai !== 'claude') return { fileShas, session: null, choice };

  const fullModel = 'fullModel' in input ? input.fullModel : undefined;
  const wanted = modelRoleOf(choice, fullModel);
  // The role this round would have used had the policy not gone cheaper.
  const fullRole = modelRoleOf({ model: undefined, source: 'policy', reason: '' }, fullModel);
  const sessionRole = prior?.role ?? null;
  const sameRole = sessionRole === wanted;
  // A full-model session carries a round that would merely have gone cheaper — but only
  // while it is the SAME full model; a changed default is a different cache.
  const fullBeatsCheaper = sessionRole === fullRole && wanted.startsWith('late:');
  // The reviewer's own rules changed (lgtm upgraded mid-loop): the session's earlier
  // instructions would contradict this round's — start over.
  const rulesChanged = Boolean(prior && SYSTEM_PROMPT_KEY in fileShas && prior.fileShas[SYSTEM_PROMPT_KEY] !== undefined && prior.fileShas[SYSTEM_PROMPT_KEY] !== fileShas[SYSTEM_PROMPT_KEY]);
  // What this round would add to the session: the files that moved (the diff and the
  // per-round tail are small next to them). Over budget ⇒ a fresh session, not a compaction.
  let changedChars = 0;
  if (prior) for (const [path, content] of Object.entries(contents)) if (prior.fileShas[path] !== fileShas[path]) changedChars += content.length;
  const wouldHold = (prior?.lastPromptTokens ?? 0) + Math.ceil(changedChars / CHARS_PER_TOKEN);
  const overBudget = Boolean(prior && prior.lastPromptTokens !== null && wouldHold > SESSION_CONTEXT_BUDGET);
  if (prior && !fresh && !rulesChanged && !overBudget && (sameRole || fullBeatsCheaper)) {
    const changedSinceLast: Record<string, string> = {};
    const unchangedFiles: string[] = [];
    for (const [path, content] of Object.entries(contents)) {
      if (prior.fileShas[path] === fileShas[path]) unchangedFiles.push(path); else changedSinceLast[path] = content;
    }
    const kept: RoundModelChoice = fullBeatsCheaper
      ? { model: undefined, source: 'policy', reason: `continuing the loop's session on the full model (prompt cache beats ${choice.model}; ${Object.keys(changedSinceLast).length} file(s) changed since last round)` }
      : { ...choice, reason: `continuing the loop's session (${choice.reason}; ${Object.keys(changedSinceLast).length} file(s) changed since last round)` };
    return { fileShas, session: { id: prior.id, resume: true, changedSinceLast, unchangedFiles: unchangedFiles.sort() }, choice: kept };
  }
  const why = rulesChanged ? "the reviewer's system prompt changed since it opened"
    : overBudget ? `it holds ~${Math.round((prior!.lastPromptTokens ?? 0) / 1000)}k tokens and this round would add ~${Math.round(changedChars / CHARS_PER_TOKEN / 1000)}k, past the ${SESSION_CONTEXT_BUDGET / 1000}k budget where the CLI would compact it`
    : `it ran as ${sessionRole ?? 'unknown'}, this round needs ${wanted}`;
  const note = prior && !fresh ? `⟳  session: not continuing ${prior.id.slice(0, 8)} (${why}) — opening a new one` : undefined;
  return { fileShas, session: { id: newId(), resume: false, changedSinceLast: {}, unchangedFiles: [] }, choice, note };
}
