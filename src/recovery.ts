import type { AIProvider, RoundModelChoice } from './ai.js';
import type { ReviewResult } from './types.js';

/**
 * Run the review with its recovery ladder. Every attempt that produces no review is
 * logged as a failed round — the spend is real and it judges nothing. Ladder: (1) an
 * unparsable reply is retried on the same model with the reply schema enforced (that is
 * what the schema fixes; other failures skip this rung); (2) if the policy had picked the
 * cheaper model, ANY failure then falls back to the full model with the schema — a
 * cheaper reviewer that cannot answer, for whatever reason, is not a saving. A failure
 * on the operator's own model (default or --model) rethrows: there is nothing cheaper
 * to have chosen wrongly.
 */
export async function reviewWithRecovery(opts: {
  review: (attempt: { enforceSchema?: boolean; model?: string; fresh?: boolean }) => Promise<ReviewResult>;
  ai: AIProvider;
  choice: RoundModelChoice;
  initialChoice: RoundModelChoice;
  /** True when the first attempt resumes a loop session — a failure there gets one fresh full round first. */
  resuming?: boolean;
  logFailedRound: (why: string, attempted: RoundModelChoice) => void;
  say: (line: string) => void;
}): Promise<{ result: ReviewResult; choice: RoundModelChoice; freshened?: boolean }> {
  const { review, ai, initialChoice, resuming, logFailedRound, say } = opts;
  let { choice } = opts;
  const isParseFailure = (e: any) => /parse review response/i.test(e?.message ?? '');
  const policyPickedCheaper = () => choice.source === 'policy' && choice.model !== undefined;
  let lastError: any;
  let freshened = false;
  try {
    return { result: await review({ model: choice.model }), choice };
  } catch (e: any) {
    logFailedRound(e?.message ?? String(e), choice);
    lastError = e;
    if (ai !== 'claude' || /^LGTM_NO_CALL/.test(e?.message ?? '')) throw e; // the debugging sentinel is never recovered
    // A resumed session can be gone (transcript deleted, another machine, CLI upgrade):
    // one fresh full round on the same model before any other rung.
    if (resuming && !isParseFailure(e)) {
      say(`↺  could not continue the loop's session (${e?.message?.split('\n')[0] ?? e}) — starting a fresh one`);
      try {
        freshened = true;
        return { result: await review({ model: choice.model, fresh: true }), choice, freshened };
      } catch (e2: any) {
        logFailedRound(`fresh session failed: ${e2?.message ?? String(e2)}`, choice);
        lastError = e2;
      }
    }
    // From here on, decisions and rethrows are about the LATEST failure, not the first.
    if (!isParseFailure(lastError) && !policyPickedCheaper()) throw lastError;
  }
  if (isParseFailure(lastError)) {
    try {
      say(`↺  reply was not valid JSON — retrying ${choice.model ?? 'the full model'} with the schema enforced`);
      return { result: await review({ enforceSchema: true, model: choice.model, ...(freshened ? { fresh: true } : {}) }), choice, freshened };
    } catch (e2: any) {
      logFailedRound(`schema retry failed: ${e2?.message ?? String(e2)}`, choice);
      lastError = e2;
      if (!policyPickedCheaper()) throw e2;
    }
  }
  choice = { model: undefined, source: 'policy', reason: `fell back to the full model after ${choice.model} produced no usable review (${lastError?.message ?? lastError}; ${initialChoice.reason})` };
  say(`↺  ${choice.reason}`);
  try {
    // A new session for the full model: the existing one's transcript was created under
    // the cheaper model, and the prompt cache is model-scoped.
    freshened = true;
    return { result: await review({ enforceSchema: true, model: undefined, fresh: true }), choice, freshened };
  } catch (e3: any) {
    logFailedRound(`full-model fallback failed: ${e3?.message ?? String(e3)}`, choice);
    throw e3;
  }
}
