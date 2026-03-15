# LGTM as a GitHub App — Architecture Decision Doc

**Date:** 2026-03-08  
**Status:** Draft  
**Author:** Jenna (AI Agent)

## Executive Summary

This document outlines the architecture for transforming lgtm from a CLI tool into a hosted GitHub App product. Users install the app once, select repos, and lgtm automatically reviews every PR — no workflow files, no API keys, just reviews.

**Recommendation: GO** — The economics work out ($0.01-0.05/review with $9-19/month subscriptions), the infrastructure fits the existing serverless stack, and there's clear product differentiation from Cursor Bugbot.

## 1. Current State

lgtm is a CLI tool that:
- Uses `gh` CLI for GitHub access (user's auth)
- Uses `claude --print` or `codex exec` for AI (user's auth)
- Runs locally, user reviews suggestions interactively
- No persistence, no billing, no dashboard

## 2. Target State

lgtm becomes a hosted GitHub App that:
- Automatically reviews PRs on push (no user action needed)
- Uses installation tokens for GitHub access
- Uses direct Claude/OpenRouter API for AI
- Posts reviews as PR comments (like Bugbot)
- Subscription billing via Stripe
- Simple dashboard for repo management

## 3. Architecture Decisions

### 3.1 GitHub App Registration

**Decision:** Register a new GitHub App on github.com (not github.com/apps/lgtm — separate from the CLI repo).

**Permissions required:**
- `pull_requests: write` — post review comments
- `contents: read` — fetch file contents for context expansion

**Webhook events:**
- `pull_request` (opened, synchronize, reopened)
- `pull_request_review` (for recheck feature later)

**Installation flow:**
1. User clicks "Install lgtm" on landing page
2. GitHub OAuth flow → lgtm gets installation ID
3. User selects repos during installation
4. GitHub sends webhooks to our endpoint

### 3.2 Infrastructure

**Decision:** Lambda + API Gateway + DynamoDB (same stack as serverless-portfolio-tracker)

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ GitHub Webhooks │────▶│ API Gateway      │────▶│ Lambda Handler  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                         │
                        ┌────────────────────────────────┼────────────────────────────────┐
                        │                                │                                │
                        ▼                                ▼                                ▼
                ┌───────────────┐              ┌─────────────────┐              ┌─────────────────┐
                │ DynamoDB      │              │ Claude API      │              │ GitHub API      │
                │ (users/repos) │              │ (via OpenRouter)│              │ (review posts)  │
                └───────────────┘              └─────────────────┘              └─────────────────┘
```

**Why Lambda:**
- Already used in dwlf stack — familiar
- Pay-per-invocation matches per-review billing
- No cold start concerns (webhook can wait 1-2s)
- Easy to add more endpoints (dashboard API, Stripe webhooks)

**Why DynamoDB:**
- Already used in dwlf stack
- Fast, cheap, scalable
- Simple key-value access for user/repo config

### 3.3 AI Provider

**Decision:** Use OpenRouter with Claude 4 Sonnet

**Why OpenRouter:**
- Single API, multiple models
- Already used in dwlf for other features
- Easy to A/B test models (Sonnet vs Haiku for cost optimization)

**Cost estimate:**
- Average diff: ~2000 tokens
- Claude response: ~500 tokens
- Cost per review: $0.01-0.03 (Sonnet), $0.002-0.005 (Haiku)

**Harshness mapping:**
- `chill` → Haiku (fast, cheap, catches obvious issues)
- `medium` → Sonnet (default, catches most issues)
- `pedantic` → Opus (thorough, expensive — premium tier?)

### 3.4 Billing

**Decision:** Stripe subscriptions with per-repo pricing

**Pricing tiers:**

| Tier | Price | Repos | Reviews | Users |
|------|-------|-------|---------|-------|
| Free | £0/mo | 1 | 10/mo | 1 |
| Pro | £9/mo | 5 | Unlimited | 1 |
| Team | £19/mo | Unlimited | Unlimited | 10 |

**Unit economics (Pro tier):**
- £9/month = ~£0.30/day
- If user reviews 50 PRs/month: £9 ÷ 50 = £0.18/review
- Our cost: ~£0.02/review (Sonnet)
- Margin: ~£0.16/review = 89% gross margin ✓

**Implementation:**
- Stripe Checkout for subscription
- Webhook to update DynamoDB on subscription change
- Check subscription status before every review
- Free tier: rate limit enforcement

### 3.5 Dashboard

**Decision:** Minimal Next.js app, reuse portfolio-frontend patterns

**Must-have pages:**
1. `/login` — GitHub OAuth
2. `/repos` — Enable/disable repos, set harshness per repo
3. `/reviews` — View recent reviews, stats
4. `/billing` — Manage subscription, usage

**Nice-to-have (v2):**
- Custom rules per repo
- Team management
- Slack/email notifications

### 3.6 Database Schema

```typescript
// USERS table
{
  PK: `USER#${githubUserId}`,
  SK: 'PROFILE',
  installationId: string,
  email: string,
  stripeCustomerId: string,
  subscriptionTier: 'free' | 'pro' | 'team',
  subscriptionStatus: 'active' | 'canceled' | 'past_due',
  createdAt: string,
}

// REPOS table
{
  PK: `INSTALLATION#${installationId}`,
  SK: `REPO#${owner}#${repoName}`,
  enabled: boolean,
  harshness: 'chill' | 'medium' | 'pedantic',
  lastReviewAt: string,
}

// REVIEWS table
{
  PK: `REPO#${owner}#${repoName}`,
  SK: `REVIEW#${timestamp}`,
  prNumber: number,
  commitSha: string,
  commentsPosted: number,
  modelUsed: string,
  tokenCount: number,
  costUsd: number,
  durationMs: number,
}
```

### 3.7 Webhook Handler Logic

```typescript
async function handlePREvent(event) {
  const { action, pull_request, installation, repository } = event;
  
  // Only process relevant actions
  if (!['opened', 'synchronize', 'reopened'].includes(action)) {
    return { statusCode: 200, body: 'Ignored action' };
  }
  
  // Check repo is enabled
  const repo = await getRepo(installation.id, repository.full_name);
  if (!repo?.enabled) {
    return { statusCode: 200, body: 'Repo not enabled' };
  }
  
  // Check subscription
  const user = await getUserByInstallation(installation.id);
  if (!canReview(user)) {
    return { statusCode: 200, body: 'Rate limited or no subscription' };
  }
  
  // Get installation token
  const token = await getInstallationToken(installation.id);
  
  // Fetch PR diff
  const diff = await fetchPRDiff(token, repository, pull_request.number);
  
  // Run review
  const result = await reviewWithClaude(diff, repo.harshness);
  
  // Post review
  if (result.comments.length > 0) {
    await postReview(token, repository, pull_request, result);
  }
  
  // Log for billing/analytics
  await logReview(repository, pull_request, result);
  
  return { statusCode: 200, body: 'Review posted' };
}
```

## 4. Migration Path

### Phase 1: Core Webhook (MVP)
1. Register GitHub App
2. Deploy webhook handler (Lambda)
3. Adapt review.ts to use Claude API directly
4. Post reviews to PRs
5. Manual user onboarding (no dashboard)

### Phase 2: Self-Serve
6. GitHub OAuth flow
7. Dashboard: repo management
8. Stripe billing integration
9. Free tier rate limiting

### Phase 3: Polish
10. Review history/analytics
11. Custom rules per repo
12. Team billing
13. Notifications (Slack, email)

## 5. Differentiation from Bugbot

| Feature | Bugbot | lgtm |
|---------|--------|------|
| Harshness levels | No | Yes (chill/medium/pedantic) |
| Context expansion | No | Yes (full-context, usage-context) |
| Recheck stale comments | No | Yes |
| Pricing | ? | Transparent (£9-19/mo) |
| Self-hosted option | No | Yes (CLI still works) |

**Key differentiator:** lgtm catches more subtle issues with context expansion. The README example shows lgtm catching a useEffect dependency issue that Bugbot missed.

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude API cost spike | High | Rate limits, Haiku for chill mode |
| GitHub rate limits | Medium | Queue reviews, backoff |
| Webhook failures | Medium | Dead letter queue, retry logic |
| Bugbot dominance | High | Focus on context expansion as differentiator |

## 7. Open Questions

1. **Harshness default:** Should we default to `chill` (fewer comments, better UX) or `medium` (more value)?
2. **Incremental reviews:** Should we only review new commits (like Bugbot) or full diff each time?
3. **Branding:** Keep "lgtm" or rename? (lgtm.dev, reviewbot, etc.)
4. **Monorepo or new repo:** Add to existing lgtm repo or create lgtm-app?

## 8. Recommendation

**GO** — Build it.

The MVP is achievable in 5-10 focused tickets. The economics are favorable. The differentiation is real (context expansion catches issues Bugbot misses). Start with Phase 1, validate with 5-10 beta users, then build self-serve.

---

## Appendix: Implementation Tickets

See `/docs/IMPLEMENTATION-TICKETS.md` for the broken-down tasks.
