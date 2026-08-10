import { execSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Shared AI-CLI invocation. Every lgtm feature that talks to a model goes through
 * runAIPrompt: prompt → temp file (no shell-escaping issues) → `claude --print` or
 * `codex exec` → raw text back. Parsing stays with the caller.
 */

export type AIProvider = 'claude' | 'codex';

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

/**
 * Run a one-shot prompt through the AI CLI and return its raw text output.
 * `label` only names the temp file, to keep concurrent invocations distinct.
 */
export function runAIPrompt(prompt: string, ai: AIProvider, label = 'prompt'): string {
  const tempFile = join(tmpdir(), `lgtm-${label}-${Date.now()}-${process.pid}.txt`);
  writeFileSync(tempFile, prompt);

  try {
    if (ai === 'codex') {
      // codex exec reads the prompt from stdin (-) and writes the last message to a file
      const outputFile = tempFile + '.out';
      try {
        execSync(`codex exec -o "${outputFile}" - < "${tempFile}"`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
        return readFileSync(outputFile, 'utf-8');
      } finally {
        try { unlinkSync(outputFile); } catch { /* ignore */ }
      }
    }
    return execSync(`claude --print < "${tempFile}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
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
  } finally {
    try { unlinkSync(tempFile); } catch { /* ignore */ }
  }
}
