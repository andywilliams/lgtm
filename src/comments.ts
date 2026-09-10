import type { ReviewComment, ExistingReviewComment } from './types.js';

export function formatReviewCommentBody(comment: ReviewComment): string {
  let body = `**${comment.title}**`;
  // What kind of problem and how sure the reviewer is, before the prose — a "missing"
  // finding at low confidence reads very differently from a demonstrated bug.
  const kind = comment.kind && comment.kind !== 'added' ? comment.kind : null;
  const tags = [kind ? `_${kind}_` : null, comment.confidence ? `confidence: ${comment.confidence}` : null].filter(Boolean);
  if (tags.length > 0) body += `\n\n${tags.join(' · ')}`;
  body += `\n\n${comment.body}`;
  if (comment.evidence && comment.evidence.length > 0) {
    body += `\n\n**Evidence:**\n${comment.evidence.map((e) => `> ${e.replace(/\n/g, '\n> ')}`).join('\n>\n')}`;
  }
  if (comment.how_to_verify) body += `\n\n**How to check:** ${comment.how_to_verify}`;
  if (comment.suggestion) {
    body += `\n\n**Suggested fix:**\n\`\`\`suggestion\n${comment.suggestion}\n\`\`\``;
  }
  return body;
}

function normalizeFingerprintText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isDuplicateComment(candidate: ReviewComment, existing: ExistingReviewComment[]): boolean {
  const candidateKey = `${candidate.file}:${candidate.line}`;
  // The TITLE only. The thing this is matched against is an existing comment's rendered
  // body, and the renderer's header (kind, confidence, evidence) sits between the title
  // and the body — so any fingerprint spanning both stops matching the moment the
  // rendering changes. file:line + title is the part that survives a re-render.
  const fingerprint = normalizeFingerprintText(`**${candidate.title}**`).slice(0, 50);
  if (!fingerprint) return false;

  return existing.some((comment) => {
    if (comment.line == null) return false;
    const existingKey = `${comment.path}:${comment.line}`;
    if (existingKey !== candidateKey) return false;
    return normalizeFingerprintText(comment.body).includes(fingerprint);
  });
}
