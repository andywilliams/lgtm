import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import prompts from 'prompts';
import chalk from 'chalk';
import { runAIPrompt, type AIProvider } from './ai.js';
import { extractJsonObject } from './review.js';
import { CHARTER_TEMPLATE, resolveSystemDoc, type SystemDoc } from './charter.js';
import { fetchBrainContext } from './brain.js';

/**
 * Charter authoring — the "before any code" half of `lgtm arch`.
 *
 *  - `arch new`  — interview the author about a repo that DOESN'T EXIST YET, one
 *    question at a time, then draft the charter, critique the draft (against the
 *    system doc when one resolves), fold the author's responses back in, and write
 *    ARCHITECTURE.md. Design review while the design is still cheap to change.
 *  - `arch init` — infer a draft charter for an EXISTING repo from its structure,
 *    manifest, README and recent merged PRs. Every inferred claim is marked with its
 *    evidence so a human can see what it leans on and delete what's wrong — an
 *    inferred charter that is silently wrong is worse than none, because it promotes
 *    `judgement` findings to `charter` authority.
 *
 * Charter evolution is deliberately manual: these commands WRITE a draft for the
 * author to own; nothing here (or in `arch review`) ever edits a charter behind the
 * author's back.
 */

const MAX_QUESTIONS = 9;

interface InterviewTurn {
  question: string;
  answer: string;
}

export interface ArchNewOptions {
  ai: AIProvider;
  /** Output path (default: ARCHITECTURE.md in cwd). */
  out?: string;
  /** Repo name for the charter title (default: basename of cwd). */
  name?: string;
  /** Path to the system doc/dir (falls back to LGTM_SYSTEM_DIR). */
  system?: string;
  /** JSON file with an array of pre-supplied answers (scripted/rehearsal runs). */
  answers?: string;
  force?: boolean;
}

export interface ArchInitOptions {
  ai: AIProvider;
  out?: string;
  system?: string;
  force?: boolean;
}

function interviewPreamble(repoName: string, system: SystemDoc | null): string {
  const systemSection = system
    ? `\n## System context (the wider system this repo will join)\nSource: ${system.path}\n\n${system.content.slice(0, 12000)}\n\nCheck the new repo against this: does its proposed responsibility overlap an existing repo's? Does it duplicate a capability? Which contracts (edges) will it add? Surface any tension as an interview question — this is the highest-value thing you can catch before code exists.\n`
    : '\n(No system doc provided — skip system-fit questions, and note in the charter that the repo is not yet declared in a system doc.)\n';

  return `You are a staff engineer helping an author design a NEW repo BEFORE any code exists. The end product is an architecture charter (ARCHITECTURE.md): the NORMATIVE record of what the repo is for, what must NOT live in it, its interfaces, invariants and initial standing decisions. Today's date is ${new Date().toISOString().slice(0, 10)}. The repo will be called "${repoName}".

You run a focused interview, ONE question per turn:
- Ask the question whose answer would most change the charter. Never ask two things at once.
- Over the interview, cover: purpose; scope boundary (especially what this repo is NOT for, and where that lives instead); where it sits in the wider system; interfaces exposed and who consumes them; dependencies and their contracts; invariants; operational posture (scale, failure modes, security); and any decision already made, with its rationale.
- Don't ask what you can infer from earlier answers — state the inference and ask the author to confirm or correct it.
- ${MAX_QUESTIONS} questions is the ceiling; 5–8 is typical. Stop as soon as another answer would no longer change the charter, and draft.

The charter must follow this template (small on purpose — a charter nobody maintains is worse than none):

${CHARTER_TEMPLATE}
${systemSection}`;
}

const INTERVIEW_TURN_FORMAT = `OUTPUT FORMAT: You must respond with ONLY a valid JSON object, no other text before or after. Either ask the next question:
{"status": "ask", "question": "…", "why": "one line on why this answer shapes the charter"}
or, when the interview is complete, draft the charter:
{"status": "draft", "charter": "<the complete ARCHITECTURE.md content, following the template, frontmatter included>", "system_addition": "<if system context was provided: a proposed addition to its Repos + Contracts sections declaring this repo and its edges; otherwise an empty string>"}`;

function transcriptSection(turns: InterviewTurn[]): string {
  if (turns.length === 0) return '\n## Interview so far\n(none yet — ask your first question)\n';
  return (
    '\n## Interview so far\n' +
    turns.map((t, i) => `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer}`).join('\n\n') +
    '\n'
  );
}

interface DraftResult {
  charter: string;
  systemAddition: string;
}

function parseTurn(output: string): { status: 'ask'; question: string; why: string } | ({ status: 'draft' } & DraftResult) {
  const { value } = extractJsonObject(output);
  if (!value) throw new Error('Failed to parse interview response from AI');
  if (value.status === 'draft' || typeof value.charter === 'string') {
    const charter = String(value.charter || '');
    if (!charter.trim()) throw new Error('AI returned an empty charter draft');
    return { status: 'draft', charter, systemAddition: String(value.system_addition || '') };
  }
  if (typeof value.question === 'string' && value.question.trim()) {
    return { status: 'ask', question: value.question, why: String(value.why || '') };
  }
  throw new Error('Interview response was neither a question nor a draft');
}

/** Answer source: pre-supplied answers first (scripted runs), then the terminal. */
class AnswerSource {
  private queue: string[];
  constructor(answersFile?: string) {
    this.queue = [];
    if (answersFile) {
      const parsed = JSON.parse(readFileSync(answersFile, 'utf-8'));
      if (!Array.isArray(parsed)) throw new Error('--answers file must contain a JSON array of strings');
      this.queue = parsed.map(String);
    }
  }

  /** Returns the answer, or null when the author wants to stop and draft. */
  async next(question: string, why: string): Promise<string | null> {
    console.log(chalk.white('─'.repeat(60)));
    console.log(chalk.bold(question));
    if (why) console.log(chalk.gray(`   (${why})`));

    if (this.queue.length > 0) {
      const answer = this.queue.shift()!;
      console.log(chalk.cyan(`   [scripted] ${answer}`));
      return answer === '/done' ? null : answer;
    }

    if (!process.stdin.isTTY) return null; // scripted answers exhausted — draft with what we have

    const response = await prompts({
      type: 'text',
      name: 'answer',
      message: 'Your answer (/done to finish and draft)',
    });
    if (response.answer === undefined) throw new Error('Interview cancelled');
    const answer = String(response.answer).trim();
    return answer === '/done' ? null : answer;
  }
}

interface CritiquePoint {
  point: string;
  question: string;
}

function critiqueDraft(draft: string, system: SystemDoc | null, ai: AIProvider): { summary: string; points: CritiquePoint[] } {
  const systemSection = system
    ? `\n## System context\nSource: ${system.path}\n\n${system.content.slice(0, 12000)}\n`
    : '';
  const prompt = `You are a principal engineer critiquing a DRAFT architecture charter for a repo that does not exist yet. The cheapest moment to catch a design problem is now.
${systemSection}
## Draft charter
${draft}

Critique the DESIGN the charter records, not its prose. Look for, in value order:
1. Overlap — a responsibility the system context already assigns to another repo.
2. A scope boundary with no teeth — a "Not for" section that excludes nothing anyone would actually try.
3. Missing contracts — a stated consumer or dependency with no mechanism/ownership recorded.
4. Untestable invariants — phrased so no reviewer could ever check a diff against them.
5. Decisions with no rationale — dogma that can never be safely challenged.
6. Omissions — an operational posture, failure mode, or migration story conspicuously absent.

You have no charter authority here — the charter IS the draft under review — so phrase every point as a question the author should be able to answer. At most 5 points, ranked. If the draft is genuinely sound, return an empty points array — do not manufacture significance.

OUTPUT FORMAT: ONLY a valid JSON object:
{"summary": "one-paragraph overall read", "points": [{"point": "the concern", "question": "the question to put to the author"}]}`;

  const { value } = extractJsonObject(runAIPrompt(prompt, ai, 'arch-critique'));
  if (!value) throw new Error('Failed to parse critique response from AI');
  const points = (Array.isArray(value.points) ? value.points : [])
    .map((p: any) => ({ point: String(p?.point || ''), question: String(p?.question || '') }))
    .filter((p: CritiquePoint) => p.point.trim())
    .slice(0, 5);
  return { summary: String(value.summary || ''), points };
}

function reviseDraft(
  draft: string,
  responses: { point: string; response: string }[],
  system: SystemDoc | null,
  ai: AIProvider
): DraftResult {
  const systemSection = system ? `\n## System context\nSource: ${system.path}\n\n${system.content.slice(0, 12000)}\n` : '';
  const prompt = `You are revising a draft architecture charter. A critique was put to the author; their responses are below. Fold them in: a response that resolves a concern may become an invariant, a "Not for" line, or a dated standing decision WITH its rationale. Do not invent anything the author didn't say, and do not pad — the charter should stay small.
${systemSection}
## Current draft
${draft}

## Critique points and the author's responses
${responses.map((r, i) => `${i + 1}. Concern: ${r.point}\n   Author: ${r.response}`).join('\n\n')}

OUTPUT FORMAT: ONLY a valid JSON object:
{"charter": "<the complete revised ARCHITECTURE.md content>", "system_addition": "<revised proposed system-doc addition, or empty string>"}`;

  const { value } = extractJsonObject(runAIPrompt(prompt, ai, 'arch-revise'));
  if (!value || typeof value.charter !== 'string' || !value.charter.trim()) {
    throw new Error('Failed to parse revised charter from AI');
  }
  return { charter: value.charter, systemAddition: String(value.system_addition || '') };
}

function writeCharterFile(outPath: string, content: string, force: boolean): void {
  if (existsSync(outPath) && !force) {
    throw new Error(`${outPath} already exists — pass --force to overwrite it.`);
  }
  writeFileSync(outPath, content.endsWith('\n') ? content : content + '\n');
}

/** `lgtm arch new` — design the charter through an interview, before any code. */
export async function runArchNew(options: ArchNewOptions): Promise<void> {
  const repoName = options.name || basename(process.cwd());
  const outPath = options.out || join(process.cwd(), 'ARCHITECTURE.md');

  if (existsSync(outPath) && !options.force) {
    throw new Error(`${outPath} already exists — use \`lgtm arch init\` to rebuild from the code, or pass --force.`);
  }
  if (!process.stdin.isTTY && !options.answers) {
    throw new Error('The charter interview needs an interactive terminal (or --answers <file> for a scripted run).');
  }

  const system = resolveSystemDoc(process.cwd(), options.system);
  console.log(chalk.blue(`\n🏛  Designing the architecture charter for "${repoName}" — before any code.`));
  console.log(
    system
      ? chalk.gray(`   System context: ${system.path}`)
      : chalk.gray('   No system doc resolved (pass --system <path> or set LGTM_SYSTEM_DIR to check system fit).')
  );
  console.log(chalk.gray('   One question at a time; /done to stop early and draft.\n'));

  const preamble = interviewPreamble(repoName, system);
  const answerSource = new AnswerSource(options.answers);
  const turns: InterviewTurn[] = [];
  let draft: DraftResult | null = null;
  let finishRequested = false;
  let forcedDraftAttempts = 0; // model asked again after being told to draft
  let parseFailures = 0; // consecutive unusable model turns

  // The human's typed answers are the expensive part of this loop — never let a bad
  // model turn discard them. Parse failures retry (bounded); if we give up, the
  // transcript is printed so the answers survive the error.
  const bail = (error: unknown): never => {
    if (turns.length > 0) {
      console.error(chalk.yellow('\nYour answers so far (so nothing is lost):'));
      for (const t of turns) console.error(chalk.yellow(`  Q: ${t.question}\n  A: ${t.answer}`));
    }
    throw error;
  };

  while (!draft) {
    const mustDraft = finishRequested || turns.length >= MAX_QUESTIONS;
    const instruction = mustDraft
      ? `\nThe interview is over. You MUST return status "draft" now${forcedDraftAttempts > 0 ? ` (attempt ${forcedDraftAttempts + 1} — a question is not an acceptable response)` : ''}. Draft the charter from the answers so far, marking genuinely unknown areas with "> ❓ TODO confirm: …" rather than inventing them.`
      : `\nAsk your next question, or draft if the interview is complete. (${turns.length}/${MAX_QUESTIONS} questions asked.)`;

    let turn: ReturnType<typeof parseTurn>;
    try {
      turn = parseTurn(runAIPrompt(preamble + transcriptSection(turns) + instruction + '\n\n' + INTERVIEW_TURN_FORMAT, options.ai, 'arch-interview'));
      parseFailures = 0;
    } catch (error) {
      parseFailures++;
      if (parseFailures > 2) bail(error);
      console.error(chalk.yellow(`⚠  Unusable model turn (${parseFailures}/3) — retrying...`));
      continue;
    }

    if (turn.status === 'draft') {
      draft = turn;
      break;
    }
    if (mustDraft) {
      // The model asked again despite being told to draft — bounded, or this loop
      // would re-send the same prompt (and spend an AI call) forever.
      forcedDraftAttempts++;
      if (forcedDraftAttempts >= 3) {
        bail(new Error('The model kept asking questions instead of drafting the charter. Re-run the interview.'));
      }
      finishRequested = true;
      continue;
    }
    const answer = await answerSource.next(turn.question, turn.why);
    if (answer === null) {
      finishRequested = true;
    } else {
      turns.push({ question: turn.question, answer });
    }
  }

  console.log(chalk.blue('\n📄 Draft charter:\n'));
  console.log(draft.charter);

  // Critique the draft while the design is still cheap to change.
  console.log(chalk.blue('\n🔎 Critiquing the draft (design review, not prose review)...\n'));
  const critique = critiqueDraft(draft.charter, system, options.ai);
  if (critique.summary) console.log(chalk.gray(critique.summary + '\n'));

  if (critique.points.length === 0) {
    console.log(chalk.green('✓ No design concerns raised.'));
  } else {
    const responses: { point: string; response: string }[] = [];
    for (let i = 0; i < critique.points.length; i++) {
      const p = critique.points[i];
      console.log(chalk.white('─'.repeat(60)));
      console.log(chalk.bold(`[${i + 1}/${critique.points.length}] ${p.point}`));
      console.log(chalk.yellow(`   ❓ ${p.question}`));
      const answer = await answerSource.next(p.question, '');
      if (answer !== null && answer.trim()) responses.push({ point: p.point, response: answer });
    }
    if (responses.length > 0) {
      console.log(chalk.blue('\n✍️  Folding your responses back into the charter...'));
      draft = reviseDraft(draft.charter, responses, system, options.ai);
      console.log(chalk.blue('\n📄 Revised charter:\n'));
      console.log(draft.charter);
    }
  }

  writeCharterFile(outPath, draft.charter, Boolean(options.force || !existsSync(outPath)));
  console.log(chalk.green(`\n✓ Wrote ${outPath}`));

  if (system && draft.systemAddition.trim()) {
    console.log(chalk.blue(`\n📌 Proposed addition to ${system.path} — a new repo IS a system change; apply it deliberately (ideally via a PR on the system repo):\n`));
    console.log(draft.systemAddition);
  }
}

// --- arch init: infer a draft charter from an existing repo -----------------

function tryExec(cmd: string, args: string[], maxBuffer = 10 * 1024 * 1024): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer });
  } catch {
    return '';
  }
}

function gatherRepoEvidence(repoRoot: string): string {
  const sections: string[] = [];

  const files = tryExec('git', ['-C', repoRoot, 'ls-files']).trim().split('\n').filter(Boolean);
  if (files.length) {
    const shown = files.slice(0, 400);
    sections.push(`### File tree (git ls-files${files.length > shown.length ? `, first ${shown.length} of ${files.length}` : ''})\n${shown.join('\n')}`);
  }

  for (const [label, rel, maxLines] of [
    ['package.json', 'package.json', 60],
    ['README (head)', 'README.md', 80],
    ['serverless.yml (head)', 'serverless.yml', 120],
  ] as const) {
    const p = join(repoRoot, rel);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, 'utf-8').split('\n').slice(0, maxLines).join('\n');
        sections.push(`### ${label}\n\`\`\`\n${content}\n\`\`\``);
      } catch { /* skip unreadable */ }
    }
  }

  // Recent merged PR titles — the recurring shapes of change are charter evidence.
  const prJson = (() => {
    try {
      return execSync('gh pr list --state merged --limit 30 --json number,title', {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return '';
    }
  })();
  if (prJson.trim()) {
    try {
      const prs = JSON.parse(prJson) as { number: number; title: string }[];
      if (prs.length) sections.push(`### Last ${prs.length} merged PRs\n${prs.map((p) => `#${p.number} ${p.title}`).join('\n')}`);
    } catch { /* skip */ }
  }

  return sections.join('\n\n');
}

/** `lgtm arch init` — infer a draft charter for an existing repo, marked with evidence. */
export async function runArchInit(options: ArchInitOptions): Promise<void> {
  const repoRoot = tryExec('git', ['rev-parse', '--show-toplevel']).trim() || process.cwd();
  const repoName = basename(repoRoot);
  const outPath = options.out || join(repoRoot, 'ARCHITECTURE.md');

  if (existsSync(outPath) && !options.force) {
    throw new Error(`${outPath} already exists — pass --force to overwrite it.`);
  }

  console.log(chalk.blue(`\n🏛  Inferring a draft architecture charter for "${repoName}"...`));
  console.log(chalk.gray('   Reading repo structure, manifest, README and recent merged PRs.'));

  const evidence = gatherRepoEvidence(repoRoot);
  const system = resolveSystemDoc(repoRoot, options.system);
  const handbook = await fetchBrainContext(repoName);

  const prompt = `You are a staff engineer inferring a DRAFT architecture charter for the existing repo "${repoName}" from the evidence below. Today's date is ${new Date().toISOString().slice(0, 10)}.

Nobody writes a charter from scratch — your draft exists to be CORRECTED, so it must show its working:
- Every inferred claim ends with an evidence marker: *(inferred from: <the evidence — a path, a manifest field, a PR title pattern>)*.
- Where the evidence is thin, do not guess — write a "> ❓ TODO confirm: <question>" line instead. A silently-wrong charter is worse than no charter, because reviews will later treat it as normative.
- Purpose and "Not for" matter most. Interfaces come from the manifest/exports/handlers you can see. Invariants only where the code visibly enforces one. Standing decisions only where a rationale is actually visible (e.g. a README statement) — never invent rationale.
- Keep it small, per the template.

The charter must follow this template:

${CHARTER_TEMPLATE}
${system ? `\n## System context (declare this repo's place in it via the frontmatter \`system:\` pointer)\nSource: ${system.path}\n\n${system.content.slice(0, 12000)}\n` : ''}${handbook || ''}
## Repo evidence
${evidence}

OUTPUT FORMAT: ONLY a valid JSON object:
{"charter": "<the complete draft ARCHITECTURE.md content, frontmatter included>", "open_questions": ["the TODO-confirm questions, repeated as a list", "…"]}`;

  console.log(chalk.blue('\n🤖 Drafting...'));
  const { value } = extractJsonObject(runAIPrompt(prompt, options.ai, 'arch-init'));
  if (!value || typeof value.charter !== 'string' || !value.charter.trim()) {
    throw new Error('Failed to parse inferred charter from AI');
  }

  writeCharterFile(outPath, value.charter, Boolean(options.force));
  console.log(chalk.green(`\n✓ Wrote draft to ${outPath}`));

  const openQuestions = (Array.isArray(value.open_questions) ? value.open_questions : []).map(String).filter(Boolean);
  if (openQuestions.length) {
    console.log(chalk.yellow(`\n❓ Open questions the draft could not answer — edit the file and resolve these before trusting \`charter\`-authority findings:`));
    for (const q of openQuestions) console.log(chalk.yellow(`   • ${q}`));
  }
  console.log(chalk.gray('\nThis is a DRAFT: review every *(inferred from: …)* marker, delete what is wrong, then commit it.'));
}
