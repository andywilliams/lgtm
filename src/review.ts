import { execSync } from 'child_process';
import type { Harshness, ReviewResult, ReviewComment, Severity } from './types.js';

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
- Don't repeat yourself`;

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
  ai: AIProvider = 'claude'
): Promise<ReviewResult> {
  const userPrompt = `${HARSHNESS_PROMPTS[harshness]}

## PR Title
${prTitle}

## PR Description
${prBody || '(no description)'}

## Diff
\`\`\`diff
${diff}
\`\`\`

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
      // Use codex CLI with quiet flag to get output directly
      output = execSync(`codex -q "${fullPrompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
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
 * Parse AI response into ReviewResult
 */
function parseAIResponse(output: string): ReviewResult {
  let jsonStr = output.trim();

  // First, try to extract from markdown code blocks
  const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  // Try to find a JSON object that starts with {"summary" which is our expected format
  const summaryMatch = jsonStr.match(/\{"summary"[\s\S]*\}/);
  if (summaryMatch) {
    jsonStr = summaryMatch[0];
  } else {
    // Fallback: try to find any JSON object
    const jsonObjectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonObjectMatch) {
      jsonStr = jsonObjectMatch[0];
    }
  }

  try {
    const result = JSON.parse(jsonStr.trim()) as ReviewResult;
    // Validate and normalize comments
    result.comments = (result.comments || []).map(normalizeComment);
    return result;
  } catch (parseError) {
    console.error('Failed to parse AI response as JSON');
    console.error('Raw response:', output.slice(0, 500));
    throw new Error('Failed to parse review response from AI');
  }
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
