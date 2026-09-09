import { createHash, randomUUID } from 'node:crypto';
import type { AIProvider, RoundModelChoice } from './ai.js';
import type { LoopSession } from './db.js';

/**
 * What a round ASKED the CLI for, as a comparable string: 'full' (the operator's
 * default model), 'late:<id>' (the round policy's cheaper model) or 'explicit:<id>'
 * (--model). Compared instead of the CLI-reported id, because settings may name the
 * default as an alias ('opus', 'opusplan') and the envelope reports the real id.
 */
export function modelRoleOf(choice: RoundModelChoice): string {
  if (choice.source === 'explicit' && choice.model) return `explicit:${choice.model.replace(/\[.*\]$/, '')}`;
  if (choice.model) return `late:${choice.model.replace(/\[.*\]$/, '')}`;
  return 'full';
}

/** Pseudo-path under which the reviewer's own system prompt is fingerprinted; a change restarts the session. */
export const SYSTEM_PROMPT_KEY = '@system-prompt';

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
}): SessionPlan {
  const { prior, contents, ai, fresh, choice, newId = randomUUID } = input;
  const fileShas: Record<string, string> = {};
  for (const [path, content] of Object.entries(contents)) fileShas[path] = createHash('sha1').update(content).digest('hex');
  const sessionsOff = (process.env.LGTM_SESSIONS ?? '').toLowerCase() === 'off';
  if (sessionsOff || ai !== 'claude') return { fileShas, session: null, choice };

  const wanted = modelRoleOf(choice);
  const sessionRole = prior?.role ?? null;
  const sameRole = sessionRole === wanted;
  const fullBeatsCheaper = sessionRole === 'full' && wanted.startsWith('late:');
  // The reviewer's own rules changed (lgtm upgraded mid-loop): the session's earlier
  // instructions would contradict this round's — start over.
  const rulesChanged = Boolean(prior && SYSTEM_PROMPT_KEY in fileShas && prior.fileShas[SYSTEM_PROMPT_KEY] !== undefined && prior.fileShas[SYSTEM_PROMPT_KEY] !== fileShas[SYSTEM_PROMPT_KEY]);
  if (prior && !fresh && !rulesChanged && (sameRole || fullBeatsCheaper)) {
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
  const note = prior && !fresh
    ? (rulesChanged
        ? `⟳  session: not continuing ${prior.id.slice(0, 8)} (the reviewer's system prompt changed since it opened) — opening a new one`
        : `⟳  session: not continuing ${prior.id.slice(0, 8)} (it ran as ${sessionRole ?? 'unknown'}, this round needs ${wanted}) — opening a new one`)
    : undefined;
  return { fileShas, session: { id: newId(), resume: false, changedSinceLast: {}, unchangedFiles: [] }, choice, note };
}
