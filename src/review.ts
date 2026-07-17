import { execSync } from 'child_process';
import { jsonrepair } from 'jsonrepair';
import type { Harshness, ReviewResult, ReviewComment, Severity, ExistingComment, RecheckResponse, RecheckResult, CommentStatus, QuizResult, QuizQuestion, DecidedFinding } from './types.js';

export type AIProvider = 'claude' | 'codex';

const HARSHNESS_PROMPTS: Record<Harshness, string> = {
  chill: `Only flag issues that are:
- Definite bugs that will cause runtime errors
- Security vulnerabilities
- Breaking changes to public APIs
- Critical missing error handling

Do NOT comment on: style, naming, suggestions, minor improvements, "consider" statements.
If the code works correctly and is safe, return an empty comments array.
Be very conservative — only flag things that are clearly wrong.`,

  medium: `Flag issues including:
- Bugs and potential runtime errors
- Security concerns
- Missing null/undefined checks that could cause issues
- Confusing or error-prone code patterns
- Missing error handling for likely failure cases
- Performance issues that are obvious

Do NOT comment on: minor style preferences, optional improvements.
Focus on things that are likely to cause problems.`,

  pedantic: `Review thoroughly and flag:
- All potential bugs and edge cases
- Security concerns
- Code smells and antipatterns
- Naming that could be clearer
- Missing documentation for complex logic
- Style inconsistencies within the PR
- Performance concerns
- "Consider" suggestions for better approaches
- Missing test coverage for complex logic

Be thorough but constructive. Every comment should be actionable.`,
};

const SYSTEM_PROMPT = `You are a senior code reviewer. Review the provided PR diff and give specific, actionable feedback.

IMPORTANT RULES:
- Only comment on lines that are ADDED (start with + in the diff)
- Use the line number shown after @@ in the diff hunk header for context
- Be specific about what's wrong and how to fix it
- Don't repeat yourself

HUMAN READABILITY:
Beyond correctness, consider whether a human can easily read and understand the added code. Flag readability problems such as:
- Naming clarity: vague, misleading, or abbreviated names for variables, functions, or types
- Function complexity: functions that are too long, deeply nested, or do too many things and should be broken up
- Comments & intent: non-obvious logic that lacks a "why" comment, or code that fails to explain itself
- Control flow clarity: convoluted conditionals, overly clever one-liners, or non-obvious flow that could be expressed more plainly
When raising a readability issue, suggest the clearer alternative and use severity "SUGGESTION" (or "NITPICK" for trivial polish), never "BUG" or "SECURITY". Respect the harshness level below — at lower harshness these are suppressed.

CLAIMS & CONVENTIONS — do not invent rules:
You are reviewing from the diff and the provided context ONLY; you cannot browse the repository. So do NOT assert that a "project convention", "standard", "the codebase always does X", or similar exists unless it is directly evidenced in what you were given. If a finding depends on a convention you cannot see, phrase it conditionally ("if the project's convention is X, then…"), cap its severity at "SUGGESTION", and never state the convention as established fact. When unsure, under-claim rather than fabricate a rule — a confidently-wrong finding is worse than a missing one.`;

/**
 * Check if Claude CLI is available
 */
export function checkClaudeCli(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Codex CLI is available
 */
export function checkCodexCli(): boolean {
  try {
    execSync('codex --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check which AI providers are available
 */
export function getAvailableProviders(): AIProvider[] {
  const providers: AIProvider[] = [];
  if (checkClaudeCli()) providers.push('claude');
  if (checkCodexCli()) providers.push('codex');
  return providers;
}

/**
 * Review a PR diff using specified AI CLI
 */
export async function reviewPR(
  diff: string,
  prTitle: string,
  prBody: string,
  harshness: Harshness,
  ai: AIProvider = 'claude',
  fileContents?: Record<string, string>,
  usageContext?: string,
  expandedContext?: string,
  handbookContext?: string,
  extra?: { scope?: string; decided?: DecidedFinding[] }
): Promise<ReviewResult> {
  // Build file context section if provided
  let fileContextSection = '';
  if (fileContents && Object.keys(fileContents).length > 0) {
    fileContextSection = `\n## Full File Contents (for pattern analysis)
Look at how similar code is structured in these files. If the PR adds new code that doesn't follow existing patterns (e.g., missing integration with existing systems, missing registration in arrays/maps where similar items are registered), flag it.

${Object.entries(fileContents).map(([path, content]) => 
  `### ${path}\n\`\`\`\n${content}\n\`\`\``
).join('\n\n')}

IMPORTANT: Compare the PR changes against the existing patterns in the full files above. Flag any inconsistencies where new code doesn't follow established patterns.
`;
  }

  // Add usage context if provided
  let usageContextSection = '';
  if (usageContext) {
    usageContextSection = usageContext;
  }

  // Add expanded context if provided
  let expandedContextSection = '';
  if (expandedContext) {
    expandedContextSection = expandedContext;
  }

  // Add second-brain handbook (domain) context if provided
  let handbookContextSection = '';
  if (handbookContext) {
    handbookContextSection = handbookContext;
  }

  // Scope of the change (--scope): out-of-scope *quality* issues become follow-ups — but never
  // downgrade a genuine bug/security risk just because it's out of scope, and defer to harshness.
  let scopeSection = '';
  if (extra?.scope) {
    scopeSection = `\n## Scope of this change
${extra.scope}

For issues OUTSIDE this scope (pre-existing problems in the files you're touching, or unrelated concerns), prefix the title "(out of scope)". Treat out-of-scope *quality / style / improvement* issues as follow-ups at severity "SUGGESTION". But do NOT downgrade to hide risk — a genuine bug, crash, or security problem keeps "BUG"/"SECURITY" even when it is out of scope (just note it looks pre-existing). Focus your attention on the change itself, and still obey the harshness rules above: if they say not to emit suggestions, don't (that includes these out-of-scope follow-ups).
`;
  }

  // Previously-dismissed findings (--decided): don't re-litigate settled points across a fix loop.
  let decidedSection = '';
  if (extra?.decided && extra.decided.length > 0) {
    const items = extra.decided
      .map((d) => `- ${d.file ? `${d.file}${d.line ? `:${d.line}` : ''} — ` : ''}"${d.title}" — dismissed because: ${d.reason}`)
      .join('\n');
    decidedSection = `\n## Already reviewed and dismissed — do NOT raise these again
The following were raised in an earlier review round and deliberately dismissed for the stated reasons. Do NOT report them again unless the code has since changed in a way that clearly invalidates the reason:
${items}
`;
  }

  const userPrompt = `${HARSHNESS_PROMPTS[harshness]}

## PR Title
${prTitle}

## PR Description
${prBody || '(no description)'}

## Diff
\`\`\`diff
${diff}
\`\`\`
${handbookContextSection}${fileContextSection}${usageContextSection}${expandedContextSection}${scopeSection}${decidedSection}
OUTPUT FORMAT: You must respond with ONLY a valid JSON object, no other text before or after.
For each issue found, include in the comments array:
- "file": the file path
- "line": the line number in the new version (from diff lines starting with +)
- "severity": one of "BUG", "SECURITY", "SUGGESTION", "NITPICK"
- "title": a brief title (max 50 chars)
- "body": detailed explanation
- "suggestion": optional code fix

Respond with this exact JSON structure:
{"summary": "Brief overall assessment", "comments": [...]}

If no issues found, respond with:
{"summary": "LGTM — no issues found", "comments": []}`;

  const fullPrompt = `${SYSTEM_PROMPT}\n\n${userPrompt}`;

  // Write prompt to temp file to avoid shell escaping issues
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  
  const tempFile = path.join(os.tmpdir(), `lgtm-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tempFile, fullPrompt);

  try {
    let output: string;
    
    if (ai === 'codex') {
      // Use codex exec with stdin input (-), output last message to temp file
      const outputFile = tempFile + '.out';
      try {
        execSync(`codex exec -o "${outputFile}" - < "${tempFile}"`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
        output = fs.readFileSync(outputFile, 'utf-8');
      } finally {
        try { fs.unlinkSync(outputFile); } catch {}
      }
    } else {
      // Use claude CLI with --print flag to get output directly
      output = execSync(`claude --print < "${tempFile}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
    }

    // Clean up temp file
    fs.unlinkSync(tempFile);

    // Parse JSON from response
    return parseAIResponse(output);
  } catch (error: any) {
    // Clean up temp file on error
    try {
      const fs = await import('fs');
      fs.unlinkSync(tempFile);
    } catch {}

    if (error.message?.includes('not found') || error.code === 'ENOENT') {
      const cliName = ai === 'codex' ? 'Codex' : 'Claude';
      const installCmd = ai === 'codex' 
        ? 'npm install -g @openai/codex' 
        : 'npm install -g @anthropic-ai/claude-code';
      throw new Error(`${cliName} CLI not found. Install it: ${installCmd}`);
    }
    throw error;
  }
}

/**
 * Slice the first brace-balanced JSON object out of a string, tracking string
 * state so braces inside strings don't count. Returns the exact object, or — if
 * it's truncated (no matching close) — the tail from the first '{' for repair.
 */
function sliceBalancedObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let inStr = false;
  let esc = false;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start); // truncated — no matching close; caller repairs
}

/**
 * Turn a model's free-text output into a JSON object, robustly. Extracts the
 * JSON (a fenced ```json block if present, else the first balanced object) then
 * tries a strict parse, falling back to jsonrepair — which fixes the truncated /
 * malformed JSON (unclosed strings, missing braces, trailing commas) that a raw
 * JSON.parse rejects and that used to fail the WHOLE review. Returns null only
 * if even repair can't recover an object.
 */
export function extractJsonObject(output: string): any | null {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = sliceBalancedObject(fenced ? fenced[1] : output) ?? sliceBalancedObject(output);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      const recovered = JSON.parse(jsonrepair(candidate));
      console.warn('lgtm: model JSON was malformed — recovered via jsonrepair (review may be partial).');
      return recovered;
    } catch {
      return null;
    }
  }
}

/** Last-ditch salvage: pull the summary string out of an unparseable response. */
function salvageSummary(output: string): string | null {
  const m = output.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : null;
}

/**
 * Parse AI response into ReviewResult
 */
function parseAIResponse(output: string): ReviewResult {
  const parsed = extractJsonObject(output);
  if (!parsed) {
    const summary = salvageSummary(output);
    console.error('Failed to parse AI response as JSON (even after repair)');
    console.error('Raw response:', output.slice(0, 500));
    throw new Error(`Failed to parse review response from AI${summary ? ` — model summary was: ${summary.slice(0, 200)}` : ''}`);
  }
  const result = parsed as ReviewResult;
  // Validate and normalize comments
  result.comments = (result.comments || []).map(normalizeComment);
  return result;
}

/**
 * Re-check existing PR comments against the current diff to see if they're still valid
 */
export async function recheckComments(
  diff: string,
  prTitle: string,
  comments: ExistingComment[],
  ai: AIProvider = 'claude'
): Promise<RecheckResponse> {
  const commentsSection = comments.map((c, i) =>
    `### Comment ${c.id}
- **File:** ${c.file}${c.line ? `:${c.line}` : ''}
- **Author:** ${c.author}
- **Body:** ${c.body}`
  ).join('\n\n');

  const prompt = `You are a code review assistant. Your job is to check whether existing review comments on a pull request are still relevant given the current state of the diff.

For each comment, determine if:
- "still_valid": The issue the comment raises is still present in the current diff
- "resolved": The code has been updated and the comment's concern has been addressed
- "outdated": The code the comment refers to no longer exists or has changed so much the comment no longer applies

## PR Title
${prTitle}

## Current Diff
\`\`\`diff
${diff}
\`\`\`

## Existing Review Comments
${commentsSection}

OUTPUT FORMAT: You must respond with ONLY a valid JSON object, no other text before or after.
{
  "summary": "Brief summary of the recheck results",
  "results": [
    {
      "commentId": <the comment id number>,
      "status": "still_valid" | "resolved" | "outdated",
      "reason": "Brief explanation of why this status was assigned"
    }
  ]
}

Include a result for every comment listed above.`;

  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');

  const tempFile = path.join(os.tmpdir(), `lgtm-recheck-${Date.now()}.txt`);
  fs.writeFileSync(tempFile, prompt);

  try {
    let output: string;

    if (ai === 'codex') {
      const outputFile = tempFile + '.out';
      try {
        execSync(`codex exec -o "${outputFile}" - < "${tempFile}"`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
        output = fs.readFileSync(outputFile, 'utf-8');
      } finally {
        try { fs.unlinkSync(outputFile); } catch {}
      }
    } else {
      output = execSync(`claude --print < "${tempFile}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
    }

    fs.unlinkSync(tempFile);
    return parseRecheckResponse(output, comments);
  } catch (error: any) {
    try { fs.unlinkSync(tempFile); } catch {}
    throw error;
  }
}

/**
 * Parse AI response for recheck results
 */
function parseRecheckResponse(output: string, comments: ExistingComment[]): RecheckResponse {
  const parsed = extractJsonObject(output);
  if (!parsed) {
    console.error('Failed to parse recheck response (even after repair)');
    console.error('Raw response:', output.slice(0, 500));
    throw new Error('Failed to parse recheck response from AI');
  }
  const result = parsed as RecheckResponse;
  const validStatuses: CommentStatus[] = ['still_valid', 'resolved', 'outdated'];
  const commentIds = new Set(comments.map(c => c.id));

  result.results = (result.results || [])
    .filter((r: RecheckResult) => commentIds.has(r.commentId))
    .map((r: RecheckResult) => ({
      commentId: r.commentId,
      status: validStatuses.includes(r.status) ? r.status : 'still_valid',
      reason: String(r.reason || ''),
    }));

  return result;
}

/**
 * Generate quiz questions about a PR to test the user's understanding
 */
export async function generateQuiz(
  diff: string,
  prTitle: string,
  prBody: string,
  ai: AIProvider = 'claude',
  questionCount: number = 5
): Promise<QuizResult> {
  const prompt = `You are a senior engineer creating a comprehension quiz about a pull request. Your goal is to test whether someone truly understands the PR — what it changes, why, and how.

Generate exactly ${questionCount} multiple-choice questions about this PR. Each question should have exactly 4 options (A–D) with exactly one correct answer.

Mix these question types:
- **What**: What does this PR change? What files/functions are affected?
- **Why**: What is the purpose or motivation behind the change?
- **How**: How does the implementation work? What approach was taken?
- **Impact**: What could break? What are the edge cases or risks?
- **Context**: How does this fit into the broader codebase?

Make the wrong answers plausible — they should be things someone who only skimmed the PR might pick. Avoid trivially obvious wrong answers.

IMPORTANT — answer length and detail balance:
- All four options for each question MUST be similar in length and level of detail. Do NOT make the correct answer longer or more specific than the wrong answers.
- Wrong answers should contain the same amount of technical detail, specificity, and elaboration as the correct answer.
- If the correct answer mentions specific file names, function names, or technical details, the wrong answers should too (just different/incorrect ones).
- Vary which position (A–D) the correct answer appears in across questions — do not default to always placing it first or last.

## PR Title
${prTitle}

## PR Description
${prBody || '(no description)'}

## Diff
\`\`\`diff
${diff}
\`\`\`

OUTPUT FORMAT: You must respond with ONLY a valid JSON object, no other text before or after.
{
  "questions": [
    {
      "question": "The question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 0,
      "explanation": "Brief explanation of why this is the correct answer"
    }
  ]
}

The "correctIndex" is 0-based (0 = first option, 3 = last option). Ensure exactly ${questionCount} questions.`;

  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');

  const tempFile = path.join(os.tmpdir(), `lgtm-quiz-${Date.now()}.txt`);
  fs.writeFileSync(tempFile, prompt);

  try {
    let output: string;

    if (ai === 'codex') {
      const outputFile = tempFile + '.out';
      try {
        execSync(`codex exec -o "${outputFile}" - < "${tempFile}"`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
        output = fs.readFileSync(outputFile, 'utf-8');
      } finally {
        try { fs.unlinkSync(outputFile); } catch {}
      }
    } else {
      output = execSync(`claude --print < "${tempFile}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
    }

    fs.unlinkSync(tempFile);
    return parseQuizResponse(output);
  } catch (error: any) {
    try { (await import('fs')).unlinkSync(tempFile); } catch {}
    if (error.message?.includes('not found') || error.code === 'ENOENT') {
      const cliName = ai === 'codex' ? 'Codex' : 'Claude';
      const installCmd = ai === 'codex'
        ? 'npm install -g @openai/codex'
        : 'npm install -g @anthropic-ai/claude-code';
      throw new Error(`${cliName} CLI not found. Install it: ${installCmd}`);
    }
    throw error;
  }
}

/**
 * Parse AI response into QuizResult
 */
function parseQuizResponse(output: string): QuizResult {
  const parsed = extractJsonObject(output);
  if (!parsed) {
    console.error('Failed to parse quiz response as JSON (even after repair)');
    console.error('Raw response:', output.slice(0, 500));
    throw new Error('Failed to parse quiz response from AI');
  }
  const result = parsed as QuizResult;
  result.questions = (result.questions || []).map(normalizeQuestion);
  return result;
}

function normalizeQuestion(q: any): QuizQuestion {
  const options = Array.isArray(q.options) ? q.options.map(String) : ['A', 'B', 'C', 'D'];
  while (options.length < 4) options.push(`Option ${options.length + 1}`);
  const originalCorrectIndex = Number(q.correctIndex);
  const safeCorrectIndex = originalCorrectIndex >= 0 && originalCorrectIndex <= 3 ? originalCorrectIndex : 0;

  // Shuffle options to prevent the correct answer from being predictable by position
  const indices = [0, 1, 2, 3];
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const shuffledOptions = indices.map(i => options[i]);
  const newCorrectIndex = indices.indexOf(safeCorrectIndex);

  return {
    question: String(q.question || ''),
    options: [shuffledOptions[0], shuffledOptions[1], shuffledOptions[2], shuffledOptions[3]] as [string, string, string, string],
    correctIndex: newCorrectIndex,
    explanation: String(q.explanation || ''),
  };
}

function normalizeComment(comment: any): ReviewComment {
  const validSeverities: Severity[] = ['BUG', 'SECURITY', 'SUGGESTION', 'NITPICK'];
  return {
    file: String(comment.file || ''),
    line: Number(comment.line) || 1,
    severity: validSeverities.includes(comment.severity) ? comment.severity : 'SUGGESTION',
    title: String(comment.title || 'Review comment'),
    body: String(comment.body || ''),
    suggestion: comment.suggestion ? String(comment.suggestion) : undefined,
  };
}
