# LGTM GitHub App — Implementation Tickets

Each ticket is scoped to ~5-10 minutes of focused work for an M2.5 coding agent.

## Phase 1: Core Webhook (MVP)

### P1-01: Register GitHub App
**Type:** Manual (not code)  
**Owner:** Human  
**Time:** 15 min  

- Go to github.com/settings/apps/new
- App name: `lgtm-review` (or available variant)
- Homepage URL: `https://lgtm.dev` (placeholder)
- Webhook URL: `https://api.lgtm.dev/webhook` (placeholder)
- Permissions: `pull_requests: write`, `contents: read`
- Events: `pull_request`
- Generate private key, save to SSM Parameter Store
- Note: App ID, Client ID, Client Secret

---

### P1-02: Create serverless project structure
**Type:** Code  
**Repo:** lgtm (or new lgtm-app repo)  
**Time:** 10 min

```
/app
  /src
    /handlers
      webhook.ts       # PR event handler
    /services
      github.ts        # GitHub API (installation tokens)
      claude.ts        # OpenRouter/Claude API
      review.ts        # Core review logic (adapted)
    /db
      users.ts
      repos.ts
      reviews.ts
  /lib
    types.ts
  serverless.yml
  package.json
  tsconfig.json
```

**Acceptance:**
- `npm install` works
- `serverless package` succeeds (even if handlers empty)

---

### P1-03: Implement GitHub installation token service
**Type:** Code  
**File:** `/app/src/services/github.ts`  
**Time:** 10 min

Implement:
```typescript
async function getInstallationToken(installationId: number): Promise<string>
```

- Read GitHub App private key from SSM Parameter Store
- Generate JWT signed with private key
- POST /app/installations/{id}/access_tokens
- Return the token

**Deps:** P1-02  
**Acceptance:** Unit test passes with mock

---

### P1-04: Implement PR diff fetcher
**Type:** Code  
**File:** `/app/src/services/github.ts`  
**Time:** 10 min

Implement:
```typescript
async function fetchPRDiff(
  token: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string>
```

- GET /repos/{owner}/{repo}/pulls/{number}
- Accept header: `application/vnd.github.v3.diff`
- Return raw diff string

**Deps:** P1-03  
**Acceptance:** Can fetch diff from real PR (integration test)

---

### P1-05: Adapt review logic for direct Claude API
**Type:** Code  
**File:** `/app/src/services/review.ts`  
**Time:** 10 min

Port `reviewPR()` from CLI to use OpenRouter API directly:
- Remove `execSync(claude --print ...)` 
- Replace with `fetch('https://openrouter.ai/api/v1/chat/completions', ...)`
- Use same prompts from HARSHNESS_PROMPTS
- Parse JSON response same as before

**Deps:** P1-02  
**Acceptance:** `reviewPR(diff, title, body, harshness)` returns ReviewResult

---

### P1-06: Implement review poster
**Type:** Code  
**File:** `/app/src/services/github.ts`  
**Time:** 10 min

Implement:
```typescript
async function postReview(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  comments: ReviewComment[]
): Promise<void>
```

- POST /repos/{owner}/{repo}/pulls/{number}/reviews
- body: `{ commit_id, event: 'COMMENT', comments: [...] }`

**Deps:** P1-03  
**Acceptance:** Can post review to test PR

---

### P1-07: Implement webhook handler
**Type:** Code  
**File:** `/app/src/handlers/webhook.ts`  
**Time:** 10 min

Lambda handler for GitHub webhooks:
```typescript
export async function handler(event: APIGatewayEvent) {
  // Verify webhook signature (X-Hub-Signature-256)
  // Parse event body
  // If action in ['opened', 'synchronize', 'reopened']:
  //   getInstallationToken()
  //   fetchPRDiff()
  //   reviewPR()
  //   postReview()
  // Return 200
}
```

**Deps:** P1-03, P1-04, P1-05, P1-06  
**Acceptance:** End-to-end: push to test repo → review posted

---

### P1-08: Add webhook signature verification
**Type:** Code  
**File:** `/app/src/handlers/webhook.ts`  
**Time:** 5 min

Implement signature verification:
```typescript
function verifySignature(payload: string, signature: string, secret: string): boolean
```

- Use `crypto.createHmac('sha256', secret).update(payload).digest('hex')`
- Compare with `sha256=...` from header
- Reject if invalid

**Deps:** P1-07  
**Acceptance:** Rejects requests with invalid signature

---

### P1-09: Deploy to AWS
**Type:** Code/Infra  
**File:** `serverless.yml`  
**Time:** 10 min

Configure serverless.yml:
- Region: eu-west-2
- Runtime: nodejs20.x
- Functions: webhook
- API Gateway: HTTP API
- Environment: APP_ID, SSM refs for secrets

Deploy:
```bash
serverless deploy --stage prod
```

**Deps:** P1-07, P1-08  
**Acceptance:** Webhook URL accessible, returns 200 on GET

---

### P1-10: Update GitHub App webhook URL
**Type:** Manual  
**Owner:** Human  
**Time:** 5 min

- Go to GitHub App settings
- Update Webhook URL to deployed Lambda endpoint
- Verify webhook delivery in GitHub UI

---

## Phase 2: Self-Serve

### P2-01: DynamoDB tables setup
**Type:** Code/Infra  
**File:** `serverless.yml` resources section  
**Time:** 10 min

Add DynamoDB tables:
- `lgtm-users` (PK: USER#{id}, SK: PROFILE)
- `lgtm-repos` (PK: INSTALLATION#{id}, SK: REPO#{owner}#{name})
- `lgtm-reviews` (PK: REPO#{owner}#{name}, SK: REVIEW#{ts})

**Acceptance:** Tables created on deploy

---

### P2-02: Implement user service
**Type:** Code  
**File:** `/app/src/db/users.ts`  
**Time:** 10 min

```typescript
async function createUser(githubUserId, installationId, email)
async function getUserByInstallation(installationId)
async function updateSubscription(githubUserId, tier, status)
```

**Deps:** P2-01

---

### P2-03: Implement repo service
**Type:** Code  
**File:** `/app/src/db/repos.ts`  
**Time:** 10 min

```typescript
async function enableRepo(installationId, owner, repo, harshness)
async function disableRepo(installationId, owner, repo)
async function getRepo(installationId, owner, repo)
async function listRepos(installationId)
```

**Deps:** P2-01

---

### P2-04: Add subscription check to webhook
**Type:** Code  
**File:** `/app/src/handlers/webhook.ts`  
**Time:** 5 min

Before running review:
```typescript
const user = await getUserByInstallation(installationId);
if (!user || user.subscriptionStatus !== 'active') {
  // Free tier: check review count this month
  if (monthlyReviews >= 10) {
    return { statusCode: 200, body: 'Rate limited' };
  }
}
```

**Deps:** P2-02

---

### P2-05: GitHub OAuth handler
**Type:** Code  
**File:** `/app/src/handlers/auth.ts`  
**Time:** 10 min

- GET /auth/github → redirect to GitHub OAuth
- GET /auth/callback → exchange code for token, create user

**Deps:** P2-02

---

### P2-06: Stripe checkout handler
**Type:** Code  
**File:** `/app/src/handlers/billing.ts`  
**Time:** 10 min

- POST /billing/checkout → create Stripe checkout session
- POST /billing/webhook → handle subscription.created, etc.

**Deps:** P2-02

---

### P2-07: Dashboard: repo management page
**Type:** Code  
**File:** `/dashboard/pages/repos.tsx`  
**Time:** 15 min

- List repos from installation
- Toggle enabled/disabled
- Select harshness per repo

**Deps:** P2-03, P2-05

---

### P2-08: Dashboard: billing page
**Type:** Code  
**File:** `/dashboard/pages/billing.tsx`  
**Time:** 10 min

- Show current tier
- Show usage this month
- Upgrade/downgrade buttons → Stripe checkout

**Deps:** P2-06

---

## Summary

| Phase | Tickets | Est. Time |
|-------|---------|-----------|
| Phase 1 (MVP) | 10 | ~2 hours |
| Phase 2 (Self-Serve) | 8 | ~2 hours |
| **Total** | 18 | ~4 hours |

MVP can be completed in a focused afternoon. Self-serve adds another afternoon. Ship Phase 1, get beta feedback, then build Phase 2.
