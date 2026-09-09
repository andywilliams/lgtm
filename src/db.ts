import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { promptTokens, type AIUsage } from './ai.js';
import type { ReviewComment, DecidedFinding, Severity } from './types.js';

// Store in ~/.lgtm/reviews.db (LGTM_DB_PATH overrides — used by tests, and by anyone
// who wants the log somewhere else).
const DB_PATH = process.env.LGTM_DB_PATH || path.join(os.homedir(), '.lgtm', 'reviews.db');

export type ReviewMode = 'pr' | 'local';

export interface ReviewLog {
  id?: number;
  repo: string;
  prNumber: number;
  reviewedAt: string;
  filesReviewed: number;
  contextFilesAdded: number;
  contextReasons: string; // JSON array
  tokenCount: number;
  model: string;
  usedContextExpansion: boolean;
  falseNegative: boolean;
  /**
   * Measured usage from the provider's envelope. `tokenCount` above is the historical
   * diff-length estimate and stays in its own unit; these columns hold what was billed.
   */
  usage?: AIUsage;
  /** 'pr' (GitHub PR, prNumber set) or 'local' (working tree, prNumber 0). */
  mode?: ReviewMode;
  /** What the round counter is keyed on: `pr:<n>` or `local:<branch>`. */
  roundKey?: string;
  /** 1-based ordinal of this review within its roundKey. */
  round?: number;
  harshness?: string;
  /** sha1 of the diff text — lets two rounds on identical code be told apart from a changed one. */
  diffSha?: string;
  branch?: string;
  scope?: string;
  overrideReason?: string;
  recovered?: boolean;
  diffLines?: number;
  modelReason?: string;
  failed?: boolean;
  sessionId?: string;
  /** path → sha1 of the full contents sent this round. */
  fileShas?: Record<string, string>;
  modelRole?: string;
}

// Columns added after the table was first created. Each is applied once, by name,
// so an existing ~/.lgtm/reviews.db upgrades in place and old rows read as NULL.
const REVIEW_COLUMNS: [string, string][] = [
  ['prompt_tokens', 'INTEGER'],
  ['cache_read_tokens', 'INTEGER'],
  ['cache_creation_tokens', 'INTEGER'],
  ['output_tokens', 'INTEGER'],
  ['cost_usd', 'REAL'],
  ['duration_ms', 'INTEGER'],
  ['model_id', 'TEXT'],
  // 'measured' when every model call reported usage; 'estimate' otherwise (codex, or a
  // provider reply with no envelope) — so a query never mixes the two silently.
  ['usage_source', 'TEXT'],
  ['mode', 'TEXT'],
  ['round_key', 'TEXT'],
  ['round', 'INTEGER'],
  ['harshness', 'TEXT'],
  ['diff_sha', 'TEXT'],
  // The branch under review: the checkout's for --local, the PR's head for PR mode —
  // the one identity a pre-PR loop and its PR share.
  ['branch', 'TEXT'],
  // The --scope statement, kept so later rounds inherit it instead of the agent
  // having to restate (or forget) it; and the reason a round past the budget ran.
  ['scope', 'TEXT'],
  ['override_reason', 'TEXT'],
  // 1 when the model's JSON was salvaged — such a round judges nothing and is not a
  // "clean" round for the stopping rule either.
  ['recovered', 'INTEGER'],
  // Size of the reviewed diff (added + removed lines): the round policy re-escalates
  // to the full model when it jumps.
  ['diff_lines', 'INTEGER'],
  // Why the round ran on the model it did (policy reason, or "--model").
  ['model_reason', 'TEXT'],
  // 1 when the round produced no review (the model call or its parse failed) — the
  // spend is real, the round judges nothing.
  ['failed', 'INTEGER'],
  // The Claude session this round ran in (one per loop; later rounds resume it) and the
  // sha1 of each changed file's contents as sent — so the next round sends only what moved.
  ['session_id', 'TEXT'],
  ['file_shas', 'TEXT'],
  // What lgtm ASKED for, independent of how the CLI names it back: 'full' (the operator's
  // default), 'late:<id>' (the policy's cheaper model) or 'explicit:<id>' (--model).
  ['model_role', 'TEXT'],
];

/** Rounds a loop may run before the tool asks for a reason to continue. */
export const ROUND_BUDGET = 8;
/**
 * What ends a loop: a gap of this many days between rounds. PR numbers are never
 * reused, but branch names are and PRs reopen months later — rounds after the last
 * gap are "the loop" for scope, budget and the stopping rule. Dismissals never age
 * out: they are decisions about the code, not about the loop.
 */
export const LOOP_GAP_DAYS = 7;
/** Consecutive rounds without a BUG/SECURITY finding after which the tool says stop. */
export const CLEAN_ROUNDS_TO_STOP = 2;

/**
 * How a finding from an earlier round fared once a later round ran (written onto the
 * earlier row): re-raised ⇒ carried; absent and named in --decided ⇒ dismissed; absent
 * because the later round ran at a lower harshness that would not raise that severity
 * ⇒ suppressed (not evidence of a fix); absent otherwise ⇒ fixed.
 */
export type Disposition = 'fixed' | 'dismissed' | 'carried' | 'suppressed';

const HARSHNESS_RANK: Record<string, number> = { chill: 0, medium: 1, pedantic: 2 };

function migrate(db: Database.Database): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(reviews)').all() as { name: string }[]).map((c) => c.name)
  );
  for (const [name, type] of REVIEW_COLUMNS) {
    if (!existing.has(name)) db.exec(`ALTER TABLE reviews ADD COLUMN ${name} ${type}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL REFERENCES reviews(id),
      repo TEXT NOT NULL,
      round_key TEXT NOT NULL,
      round INTEGER NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      disposition TEXT,
      disposed_at_round INTEGER,
      dismissed_reason TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS findings_loop ON findings(repo, round_key, round)');
}

export function initDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      reviewed_at TEXT NOT NULL,
      files_reviewed INTEGER NOT NULL,
      context_files_added INTEGER DEFAULT 0,
      context_reasons TEXT DEFAULT '[]',
      token_count INTEGER DEFAULT 0,
      model TEXT NOT NULL,
      used_context_expansion INTEGER DEFAULT 0,
      false_negative INTEGER DEFAULT 0
    )
  `);
  migrate(db);
  return db;
}

/**
 * What the loop already knows before a round runs: the ordinal it will get, the scope
 * the last round stated, and every finding dismissed so far (with its reason) — so the
 * caller can inherit the scope and hand the reviewer its own dismissals without a file.
 * The ordinal is a preview; the insert allocates the real one.
 */
export interface LoopSession {
  id: string;
  /** The model the session has been running on, as the CLI reported it. */
  model: string | null;
  /** What lgtm asked for on the session's latest round: 'full' | 'late:<id>' | 'explicit:<id>' — the comparable thing. */
  role: string | null;
  /** path → sha1 of the file contents the session has already seen (latest version of each). */
  fileShas: Record<string, string>;
  /** Billed prompt tokens of the session's latest turn — the context a resumed turn starts from. */
  lastPromptTokens: number | null;
}

export function loopContext(repo: string, roundKey: string, branch?: string): { nextRound: number; lastScope: string | null; scopeFrom: string | null; dismissed: DecidedFinding[]; session: LoopSession | null } {
  const db = initDb();
  const nextRound = nextRoundIn(db, repo, roundKey);
  // A PR loop continues the branch's local loop: its scope and dismissals carry over.
  // The PR's own rounds win where both have spoken.
  const keys = roundKey.startsWith('pr:') && branch ? [roundKey, `local:${branch}`] : [roundKey];
  // Scope comes from the current run only — a loop restarted after a gap states its own.
  const run = currentRun(db, repo, keys);
  const scoped = [...run].reverse().find((r) => r.scope);
  // The loop's session: the latest round that ran in one (failed rounds included — the
  // session exists even if that turn produced nothing). File shas accumulate across the
  // session's rounds so "what changed since" is judged against what it last saw.
  const sessionRow = [...run].reverse().find((r) => r.session_id);
  let session: LoopSession | null = null;
  if (sessionRow?.session_id) {
    const fileShas: Record<string, string> = {};
    for (const r of run) {
      if (r.session_id !== sessionRow.session_id || !r.file_shas) continue;
      try { Object.assign(fileShas, JSON.parse(r.file_shas)); } catch { /* ignore a bad row */ }
    }
    const modelRow = [...run].reverse().find((r) => r.session_id === sessionRow.session_id && r.model_id);
    const roleRow = [...run].reverse().find((r) => r.session_id === sessionRow.session_id && r.model_role);
    // No role recorded (a row from before the column existed) ⇒ null; planSession then
    // opens a new session rather than guess from the reported id's family name.
    session = { id: sessionRow.session_id, model: modelRow?.model_id ?? null, role: roleRow?.model_role ?? null, fileShas, lastPromptTokens: sessionRow.prompt_tokens };
  }
  const marks = keys.map(() => '?').join(', ');
  const dismissedRows = db.prepare(
    `SELECT file, line, title, dismissed_reason FROM findings WHERE repo = ? AND round_key IN (${marks}) AND disposition = 'dismissed' ORDER BY id`
  ).all(repo, ...keys) as { file: string; line: number; title: string; dismissed_reason: string | null }[];
  db.close();
  const seen = new Set<string>();
  const dismissed: DecidedFinding[] = [];
  for (const r of dismissedRows) {
    const k = `${r.file}#${normTitle(r.title)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dismissed.push({ file: r.file, line: r.line, title: r.title, reason: r.dismissed_reason ?? 'dismissed in an earlier round' });
  }
  return {
    nextRound,
    lastScope: scoped?.scope ?? null,
    // Where the scope came from: "pr:34 round 2" or "local:feat/x round 5" — so the
    // inherit message can say so instead of "round 0" on a PR's first round.
    scopeFrom: scoped ? `${scoped.round_key} round ${scoped.round}` : null,
    dismissed,
    session,
  };
}

/**
 * Dismiss open findings by id, now, with a reason — the operator's (or agent's) verdict,
 * recorded where the next round will read it. Returns the ids actually changed; an id
 * that is unknown or already disposed is reported back rather than silently skipped.
 */
export function dismissFindings(ids: number[], reason: string): { dismissed: number[]; skipped: number[] } {
  const db = initDb();
  const sel = db.prepare('SELECT id, repo, round_key FROM findings WHERE id = ? AND disposition IS NULL');
  const upd = db.prepare(
    "UPDATE findings SET disposition = 'dismissed', disposed_at_round = (SELECT COALESCE(MAX(round), 0) FROM reviews WHERE repo = ? AND round_key = ?), dismissed_reason = ? WHERE id = ?"
  );
  const out = { dismissed: [] as number[], skipped: [] as number[] };
  const tx = db.transaction(() => {
    for (const id of ids) {
      const row = sel.get(id) as { id: number; repo: string; round_key: string } | undefined;
      if (!row) { out.skipped.push(id); continue; }
      upd.run(row.repo, row.round_key, reason, id);
      out.dismissed.push(id);
    }
  });
  tx();
  db.close();
  return out;
}

interface RunRow {
  id: number;
  round_key: string;
  round: number;
  reviewed_at: string;
  harshness: string | null;
  cost_usd: number | null;
  prompt_tokens: number | null;
  diff_sha: string | null;
  recovered: number | null;
  scope: string | null;
  diff_lines: number | null;
  model_id: string | null;
  failed: number | null;
  session_id: string | null;
  file_shas: string | null;
  model_role: string | null;
}

/** Every round under the keys, oldest first. */
function roundsFor(db: Database.Database, repo: string, keys: string[]): RunRow[] {
  const marks = keys.map(() => '?').join(', ');
  return db.prepare(
    `SELECT id, round_key, round, reviewed_at, harshness, cost_usd, prompt_tokens, diff_sha, recovered, scope, diff_lines, model_id, failed, session_id, file_shas, model_role FROM reviews WHERE repo = ? AND round_key IN (${marks}) AND round IS NOT NULL ORDER BY reviewed_at, id`
  ).all(repo, ...keys) as RunRow[];
}

/** The rounds after the last LOOP_GAP_DAYS gap — the loop as it currently stands. */
export function runOf<T extends { reviewed_at: string }>(rows: T[], gapDays = LOOP_GAP_DAYS): T[] {
  const gapMs = gapDays * 86_400_000;
  let start = 0;
  for (let i = 1; i < rows.length; i++) {
    if (Date.parse(rows[i].reviewed_at) - Date.parse(rows[i - 1].reviewed_at) > gapMs) start = i;
  }
  return rows.slice(start);
}

function currentRun(db: Database.Database, repo: string, keys: string[]): RunRow[] {
  return runOf(roundsFor(db, repo, keys));
}

/** The round ordinal the next review under this key will get (1 for the first). */
function nextRoundIn(db: Database.Database, repo: string, roundKey: string): number {
  const row = db.prepare('SELECT MAX(round) AS r FROM reviews WHERE repo = ? AND round_key = ?').get(repo, roundKey) as { r: number | null };
  return (row?.r ?? 0) + 1;
}

/**
 * Insert a review row; returns its id (so findings can reference it) and the round it
 * was given. When `roundKey` is set and `round` is not, the round is allocated INSIDE
 * the insert's transaction — two reviews of the same key started together cannot
 * both claim the same ordinal.
 */
export function logReview(data: ReviewLog): { id: number; round: number | null } {
  const db = initDb();
  const u = data.usage;
  // Only a fully-measured window is stored as numbers; a partial one would read as a low bill.
  const m = u && u.measured && u.calls > 0 ? u : null;
  const insert = db.prepare(`
    INSERT INTO reviews (
      repo, pr_number, reviewed_at, files_reviewed, context_files_added, context_reasons,
      token_count, model, used_context_expansion, false_negative,
      prompt_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, cost_usd, duration_ms, model_id, usage_source,
      mode, round_key, round, harshness, diff_sha, branch, scope, override_reason, recovered, diff_lines, model_reason, failed, session_id, file_shas, model_role
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const write = db.transaction((): { id: number; round: number | null } => {
    const round = data.round ?? (data.roundKey ? nextRoundIn(db, data.repo, data.roundKey) : null);
    const result = insert.run(
    data.repo,
    data.prNumber,
    data.reviewedAt,
    data.filesReviewed,
    data.contextFilesAdded,
    data.contextReasons,
    data.tokenCount,
    data.model,
    data.usedContextExpansion ? 1 : 0,
    data.falseNegative ? 1 : 0,
    m ? promptTokens(m) : null,
    m?.cacheReadTokens ?? null,
    m?.cacheCreationTokens ?? null,
    m?.outputTokens ?? null,
    m?.costUsd ?? null,
    m?.durationMs ?? null,
    // The primary model, not the helper: the CLI lists a small model alongside it.
    m && m.models.length > 0 ? primaryModel(m.models) : null,
    m ? 'measured' : 'estimate',
    data.mode ?? null,
    data.roundKey ?? null,
    round,
    data.harshness ?? null,
    data.diffSha ?? null,
    data.branch ?? null,
    data.scope ?? null,
    data.overrideReason ?? null,
    data.recovered ? 1 : 0,
    data.diffLines ?? null,
    data.modelReason ?? null,
    data.failed ? 1 : 0,
    data.sessionId ?? null,
    data.fileShas ? JSON.stringify(data.fileShas) : null,
    data.modelRole ?? null
    );
    return { id: Number(result.lastInsertRowid), round };
  });
  // IMMEDIATE takes the write lock up front, so the MAX(round) read and the insert are one unit.
  const out = write.immediate();
  db.close();
  return out;
}

/** The model that did the work — the CLI also lists its small helper model. */
export function primaryModel(models: string[]): string {
  const main = models.filter((m) => !/haiku/i.test(m));
  return (main.length > 0 ? main : models).sort().join('+');
}

/**
 * Identity of a finding across rounds. Line numbers move as fixes land, so the key
 * is file + a normalised title; the same complaint about the same file re-raised at
 * a different line is the same finding. (A model-supplied fingerprint would be
 * sharper — that is the prompt-v2 work; this is the matching the log has today.)
 */
export function fingerprintOf(c: Pick<ReviewComment, 'file' | 'title'>): string {
  return `${c.file}#${normTitle(c.title)}`;
}

/** Title identity: case-, punctuation- and tag-insensitive, so `(out of scope) Foo!` is `foo`. */
const normTitle = (t: string) =>
  t.toLowerCase().replace(/^\((?:out of scope|charter|standard [^)]*|ticket)\)\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Store this round's findings against its review row; returns their ids, in input order. */
export function logFindings(reviewId: number, repo: string, roundKey: string, round: number, comments: ReviewComment[]): number[] {
  if (comments.length === 0) return [];
  const db = initDb();
  const ins = db.prepare(`
    INSERT INTO findings (review_id, repo, round_key, round, severity, title, file, line, fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows: ReviewComment[]) =>
    rows.map((c) => Number(ins.run(reviewId, repo, roundKey, round, c.severity, c.title, c.file, c.line, fingerprintOf(c)).lastInsertRowid))
  );
  const ids = tx(comments);
  db.close();
  return ids;
}

export interface StopAdvice {
  /** True when the loop's own data says to stop: CLEAN_ROUNDS_TO_STOP consecutive rounds without BUG/SECURITY. */
  stop: boolean;
  reason: string;
}

/**
 * The stopping rule, from data. Stop when CLEAN_ROUNDS_TO_STOP consecutive JUDGING
 * rounds found no BUG/SECURITY (LoopSummary.cleanRounds), OR when the latest judging
 * round raised nothing at all — there is nothing to fix, so nothing a further round
 * could verify (and a re-run on the same diff would not count as a round anyway).
 * A re-run on the same diff or a salvaged round is never a clean round.
 */
export function stopAdvice(round: number, lastBugRound: number | null, clean: number, lastRoundEmpty = false): StopAdvice {
  if (lastRoundEmpty && clean >= 1) {
    return { stop: true, reason: `round ${round} found nothing — stop; there is nothing left to verify` };
  }
  if (clean >= CLEAN_ROUNDS_TO_STOP) {
    return {
      stop: true,
      reason: lastBugRound === null
        ? `round ${round}, no BUG/SECURITY in any round — stop; file what is left`
        : `round ${round}, last BUG/SECURITY round ${lastBugRound} — ${clean} clean rounds, stop; file what is left`,
    };
  }
  const need = CLEAN_ROUNDS_TO_STOP - clean;
  const more = need === 1 ? 'one more clean round' : `${need} more clean rounds`;
  return {
    stop: false,
    reason: lastBugRound === null
      ? `round ${round}, no BUG/SECURITY yet (${clean} clean) — ${more} and stop`
      : `round ${round}, last BUG/SECURITY round ${lastBugRound} (${clean} clean since) — fix, then ${more}`,
  };
}

export interface DispositionSummary {
  fixed: number;
  dismissed: number;
  carried: number;
  suppressed: number;
}

export interface DisposeOptions {
  decided?: DecidedFinding[];
  harshness?: string;
  /** This round's diff sha; when it equals the last round's, the code did not change and absence proves nothing. */
  diffSha?: string;
  /** This round's list was salvaged from truncated JSON — it may be missing findings, so nothing is disposed. */
  recovered?: boolean;
  /**
   * The branch behind a PR round: its `local:<branch>` findings are the first half of
   * this loop and are disposed by the PR's rounds too — otherwise a BUG raised in the
   * last local round could never be settled and the PR loop would never read as clean.
   */
  branch?: string;
}

/**
 * Write dispositions onto every EARLIER round's still-open findings now that this
 * round has run (see Disposition). Earlier, not just previous: a round that disposes
 * nothing (salvaged output, unchanged code) leaves its predecessors open for the next
 * round that can. Returns null when this round could not judge. Idempotent — rows
 * already disposed are left alone. The rules for WHETHER to dispose live here, with
 * the rules for WHICH disposition, so no caller has to remember them.
 */
export function disposePreviousRound(
  repo: string,
  roundKey: string,
  round: number,
  current: ReviewComment[],
  options: DisposeOptions = {}
): DispositionSummary | null {
  const { decided = [], harshness: currentHarshness, diffSha, recovered, branch } = options;
  const keys = roundKey.startsWith('pr:') && branch ? [roundKey, `local:${branch}`] : [roundKey];
  // A PR's first round still judges the branch's local rounds; only a loop with nothing before it has nothing to judge.
  if (recovered || (round <= 1 && keys.length === 1)) return null;
  const db = initDb();
  // Same diff as the round before ⇒ nothing was fixed; only re-raised findings are
  // informative (carried). Absent ones stay open — a re-run is not a fix.
  // The predecessor is the last round that actually reviewed (across both keys) — a
  // failed row carries the same sha as the retry after it and would read as a re-run.
  const marks = keys.map(() => '?').join(', ');
  const last = db.prepare(
    `SELECT diff_sha FROM reviews WHERE repo = ? AND round_key IN (${marks}) AND NOT (round_key = ? AND round >= ?) AND (failed IS NULL OR failed = 0) ORDER BY reviewed_at DESC, id DESC LIMIT 1`
  ).get(repo, ...keys, roundKey, round) as { diff_sha: string | null } | undefined;
  const unchanged = Boolean(diffSha && last?.diff_sha && last.diff_sha === diffSha);
  const summary: DispositionSummary = { fixed: 0, dismissed: 0, carried: 0, suppressed: 0 };
  const prev = db.prepare(
    'SELECT f.id, f.fingerprint, f.title, f.file, f.severity, r.harshness FROM findings f ' +
    'JOIN reviews r ON r.id = f.review_id ' +
    `WHERE f.repo = ? AND f.round_key IN (${marks}) AND NOT (f.round_key = ? AND f.round >= ?) AND f.disposition IS NULL`
  ).all(repo, ...keys, roundKey, round) as { id: number; fingerprint: string; title: string; file: string; severity: Severity; harshness: string | null }[];
  if (prev.length === 0) {
    db.close();
    return summary;
  }
  const rank = (h: string | null | undefined) => HARSHNESS_RANK[h ?? ''] ?? 1;
  // A lower-harshness round does not raise SUGGESTION/NITPICK it would have before;
  // their absence is silence, not a fix. BUG/SECURITY are raised at every level.
  const suppressedBy = (severity: Severity, prevHarshness: string | null) =>
    currentHarshness !== undefined && rank(currentHarshness) < rank(prevHarshness) && (severity === 'SUGGESTION' || severity === 'NITPICK');
  const now = new Set(current.map(fingerprintOf));
  // A --decided entry with a file applies to that file only; without one it applies by title.
  const dismissedReason = new Map(decided.map((d) => [`${d.file ?? '*'}#${normTitle(d.title)}`, d.reason]));
  const reasonFor = (f: { file: string; title: string }) =>
    dismissedReason.get(`${f.file}#${normTitle(f.title)}`) ?? dismissedReason.get(`*#${normTitle(f.title)}`);
  const upd = db.prepare('UPDATE findings SET disposition = ?, disposed_at_round = ?, dismissed_reason = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const f of prev) {
      let disposition: Disposition;
      let reason: string | null = null;
      const dismissed = reasonFor(f);
      if (now.has(f.fingerprint)) disposition = 'carried';
      else if (dismissed !== undefined) {
        disposition = 'dismissed';
        reason = dismissed;
      } else if (unchanged) continue; // absent on identical code: still open
      else if (suppressedBy(f.severity, f.harshness)) disposition = 'suppressed';
      else disposition = 'fixed';
      upd.run(disposition, round, reason, f.id);
      summary[disposition] += 1;
    }
  });
  tx();
  db.close();
  return summary;
}

export interface RoundRow {
  round: number;
  /** Which loop this row belongs to — a PR's summary can carry the branch's local rounds ahead of its own. */
  key: string;
  reviewedAt: string;
  harshness: string | null;
  costUsd: number | null;
  promptTokens: number | null;
  model: string | null;
  failed: boolean;
  bySeverity: Record<Severity, number>;
  findings: number;
  fixed: number;
  dismissed: number;
  carried: number;
  suppressed: number;
}

export interface LoopSummary {
  roundKey: string;
  rounds: RoundRow[];
  /** Round of the most recent BUG or SECURITY finding, or null if none ever. */
  lastBugRound: number | null;
  /**
   * Consecutive trailing rounds of the current run — the branch's local rounds and the
   * PR's together — that found no BUG/SECURITY AND could judge; a salvaged round or one
   * on an unchanged diff neither counts nor resets.
   */
  cleanRounds: number;
  /** Rounds in the current run (both keys) — what the budget is measured against. */
  budgetUsed: number;
  /** True when the latest round could judge and raised nothing at all — there is nothing left to verify. */
  lastRoundEmpty: boolean;
  /** Size (added+removed lines) of the diff the latest round of the run reviewed, if recorded. */
  lastDiffLines: number | null;
  /** BUG/SECURITY findings in the run not yet disposed — fixes no later round has verified. */
  openBugs: number;
  totalCostUsd: number;
}

const SEVERITIES: Severity[] = ['BUG', 'SECURITY', 'SUGGESTION', 'NITPICK'];

/**
 * Everything the stopping rule needs, per repo + round key, from the log alone. Pass
 * `branch` when it is known (a PR's head): before the PR's first round is logged no row
 * carries it, and the branch's local rounds would otherwise be invisible to the budget.
 */
export function getLoopSummary(repo: string, roundKey: string, branch?: string): LoopSummary {
  const db = initDb();
  // A PR loop is the continuation of the branch's local loop: include those rounds
  // first (their own key and numbering) when the branch is known or a PR row names it.
  const keys = [roundKey];
  if (roundKey.startsWith('pr:')) {
    const b = branch
      ? { branch }
      : (db.prepare('SELECT branch FROM reviews WHERE repo = ? AND round_key = ? AND branch IS NOT NULL LIMIT 1').get(repo, roundKey) as { branch: string } | undefined);
    if (b?.branch) keys.unshift(`local:${b.branch}`);
  }
  const marks = keys.map(() => '?').join(', ');
  const reviews = roundsFor(db, repo, keys);
  const findings = db.prepare(
    `SELECT round_key, round, severity, disposition FROM findings WHERE repo = ? AND round_key IN (${marks})`
  ).all(repo, ...keys) as { round_key: string; round: number; severity: Severity; disposition: Disposition | null }[];
  const inRun = new Set<string>();
  db.close();

  const rounds: RoundRow[] = reviews.map((r) => ({
    round: r.round,
    key: r.round_key,
    reviewedAt: r.reviewed_at,
    harshness: r.harshness,
    costUsd: r.cost_usd,
    promptTokens: r.prompt_tokens,
    model: r.model_id,
    failed: Boolean(r.failed),
    bySeverity: { BUG: 0, SECURITY: 0, SUGGESTION: 0, NITPICK: 0 },
    findings: 0,
    fixed: 0,
    dismissed: 0,
    carried: 0,
    suppressed: 0,
  }));
  const byRound = new Map(rounds.map((r) => [`${r.key}#${r.round}`, r]));
  // lastBugRound is an ordinal within the requested key — the stopping rule's own loop.
  let lastBugRound: number | null = null;
  for (const f of findings) {
    const row = byRound.get(`${f.round_key}#${f.round}`);
    if (!row) continue;
    row.findings += 1;
    if (SEVERITIES.includes(f.severity)) row.bySeverity[f.severity] += 1;
    if (f.disposition) row[f.disposition] += 1;
    if (f.round_key === roundKey && (f.severity === 'BUG' || f.severity === 'SECURITY') && (lastBugRound === null || f.round > lastBugRound)) lastBugRound = f.round;
  }
  // The loop as it stands: the current run across both keys. Clean rounds walk it
  // backwards from the latest; a BUG/SECURITY ends the count; a round that could not
  // judge (salvaged, or the same diff as the round before) is skipped, not counted.
  const run = runOf(reviews);
  for (const r of run) inRun.add(`${r.round_key}#${r.round}`);
  const openBugs = findings.filter(
    (f) => inRun.has(`${f.round_key}#${f.round}`) && f.disposition === null && (f.severity === 'BUG' || f.severity === 'SECURITY')
  ).length;
  const judging = (i: number) => {
    const r = run[i];
    if (r.failed || r.recovered) return false;
    // Compare against the last round that reviewed, skipping failed rows (same sha, no verdict).
    let p = i - 1;
    while (p >= 0 && run[p].failed) p--;
    const prevSha = p >= 0 ? run[p].diff_sha : null;
    return !(r.diff_sha && prevSha && r.diff_sha === prevSha);
  };
  let cleanRounds = 0;
  for (let i = run.length - 1; i >= 0; i--) {
    const row = byRound.get(`${run[i].round_key}#${run[i].round}`)!;
    if (row.bySeverity.BUG > 0 || row.bySeverity.SECURITY > 0) break;
    if (judging(i)) cleanRounds += 1;
  }
  const lastIdx = run.length - 1;
  const lastRoundEmpty = lastIdx >= 0 && judging(lastIdx) && byRound.get(`${run[lastIdx].round_key}#${run[lastIdx].round}`)!.findings === 0;
  return {
    roundKey,
    rounds,
    lastBugRound,
    cleanRounds,
    budgetUsed: run.length,
    lastRoundEmpty,
    lastDiffLines: lastIdx >= 0 ? run[lastIdx].diff_lines : null,
    openBugs,
    totalCostUsd: rounds.reduce((s, r) => s + (r.costUsd ?? 0), 0),
  };
}

export function tagFalseNegative(repo: string, prNumber: number): boolean {
  const db = initDb();
  const result = db.prepare(`
    UPDATE reviews SET false_negative = 1 WHERE repo = ? AND pr_number = ?
  `).run(repo, prNumber);
  db.close();
  return result.changes > 0;
}

export function getMonthlyStats(year: number, month: number): {
  total: number;
  falseNegatives: number;
  withContextExpansion: number;
  measured: number;
  promptTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  const db = initDb();
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(false_negative) as false_negatives,
      SUM(used_context_expansion) as with_context,
      SUM(CASE WHEN usage_source = 'measured' THEN 1 ELSE 0 END) as measured,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(output_tokens) as output_tokens,
      SUM(cost_usd) as cost_usd
    FROM reviews
    WHERE reviewed_at >= ? AND reviewed_at < ?
  `).get(startDate, endDate) as {
    total: number; false_negatives: number; with_context: number;
    measured: number; prompt_tokens: number; output_tokens: number; cost_usd: number;
  };
  db.close();
  return {
    total: stats.total || 0,
    falseNegatives: stats.false_negatives || 0,
    withContextExpansion: stats.with_context || 0,
    measured: stats.measured || 0,
    promptTokens: stats.prompt_tokens || 0,
    outputTokens: stats.output_tokens || 0,
    costUsd: stats.cost_usd || 0,
  };
}
