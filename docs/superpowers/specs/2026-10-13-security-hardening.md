# Order Flow security hardening specification

Status: proposed implementation policy; prepared on local `dev`, based on `master` d970cbdd822b29b18e144b375d301c1a71281a3b.

## Scope and evidence

Retain the modular monolith: Next.js web, Express API, Telegram bot, PostgreSQL outbox worker and Redis. Fix the reviewed code paths; do not convert to microservices. Findings are static-review evidence, not verified production exploitation. `npm test -- --reporter=dot` in backend/apps/api failed because Vitest is not installed. No dependency/CVE audit or production infrastructure inspection has been completed.

Confirmed code concerns: full Prisma User relations expose passwordHash; request-body actor IDs control authorization/audit attribution; staff can access arbitrary web orders and broad admin routes; webhook account/direction checks and exact matching are missing; settled payment state may be overwritten; webhook authentication and debug routes depend on NODE_ENV; runtime DB connections use the bootstrap account; remote pg TLS compatibility weakens verification; resource bounds and CI security gates are absent. Process-local sessions and separately committed status/history are resilience and integrity concerns.

## Required permission policy

This is the conservative target policy for implementation, not a claim that all existing staff capabilities were accidental. Existing tests intentionally allow staff overrides; update those expectations explicitly.

| Operation | OWNER | SERVICE_STAFF | BARISTA |
| --- | --- | --- | --- |
| Web login/session | Yes | Yes | No; Telegram operational flow |
| Dashboard, revenue/export, audit, bank transactions, reconciliation | Yes | No | No |
| Refund record, reconciliation resolution, status override | Yes, reason required | No | No |
| List/read/edit/cancel orders and view/init/confirm payments | All, subject to lifecycle | Own orders only, subject to lifecycle | No web access |
| Create order | Actor is owner | Actor is staff | No |
| Assign active barista through web | Yes; actor and assignee recorded separately | No | No |
| Mark READY | Owner override with reason | No | Assigned barista through Telegram |
| Deliver | Owner, reason for acting on another creator's order | Own READY order | No |
| Menu/employee administration | Yes | No | No |
| Public active menu read | Existing public behavior retained | Existing public behavior retained | Existing public behavior retained |

All actors come from verified req.auth or verified Telegram employee identity. Client IDs cannot select the acting principal. Ignore legacy actor fields during one compatibility release; never use them for access decisions, then remove them from published inputs. OWNER creation defaults to itself; creation on behalf of another user is outside scope. A forbidden object operation returns 403 (unknown UUID returns 404), writes nothing and does not expose object contents.

## Data and payment guarantees

- API user summaries allow only id, fullName, role. Employee management and auth/me retain their existing explicit public DTOs. Password hashes, session hashes and credentials never leave the server.
- Authenticate webhooks before parsing business fields. Missing webhook key disables webhook processing in every environment with 503; no implicit development bypass.
- Require configured SEPAY_BANK_ACCOUNT for bank matching; compare normalized account exactly. Accept incoming credit only. A structurally valid unrelated account/outgoing transaction returns 200 with ignored=true and changes no order/payment/history/outbox state; malformed payload returns 400.
- Normalize official webhook fields and trusted API v1/v2 results into one explicit transaction type. Confirm aliases against current official SePay documentation before coding. Preserve string transaction IDs, including legacy numeric IDs and UUIDs.
- Match a complete payment-code token exactly; no substring query or order-code-only fallback. Multiple complete known codes require review without selecting the first candidate.
- Enforce the existing 60-second timestamp tolerance relative to payment.createdAt, matching the existing active lookup baseline. Later transfers to settled/cancelled orders are review events, not permission to downgrade settled state or overwrite receivedAmount. Do not add automatic partial-payment aggregation in this scope.
- Unique external transaction identity plus guarded/serializable mutations keep payment/order/history/audit/outbox changes atomic. Handle P2002 and serialization retry explicitly; duplicate delivery is successful without replaying side effects.
- Web lifecycle state and history/audit commit together. Refund recording has a database-enforced one-record-per-payment idempotency guard, not only a pre-read; it does not send money.

## Operational limits and transport

- Order/audit/transaction/reconciliation lists: default page=1, limit=20; limit maximum 100; reject invalid integers. Catalog/employee maximum 1000 remains for current UI compatibility.
- Order input: maximum 100 lines, quantity 1..1000 safe integers, note/reason maximum 2000 characters. Money must be a nonnegative safe integer when accepted as a JS number; use canonical decimal strings for external bank amounts and reject values above signed bigint maximum 9223372036854775807.
- Revenue/export range maximum 366 days (inclusive calendar days); dashboard retains 1..90 days. Synchronous exports maximum 10000 orders, return 413 before building if exceeded. One export per user in flight, maximum 5 per 10 minutes.
- Redis-backed login limits: 10 attempts per normalized account/15 minutes and 100 per trusted client IP/15 minutes; refresh/Telegram session 60 per IP/minute; authenticated API 120 per user/minute. Return 429 with Retry-After, never key limits on attacker-supplied forwarding headers. Rate storage outage returns 503 for protected operations.
- Trusted proxy hop count defaults 0; deployment sets 1 only behind the included trusted ingress with direct access closed. Web BFF must pass a configured authenticated proxy client-IP header; strip client-supplied copies, and API accepts it only with a separate proxy credential. Do not reuse BOT_INTERNAL_SECRET.
- Web BFF upstream timeout 15 seconds; explicit report export timeout 60 seconds. Reject browser mutations whose Origin is absent or differs from the request's configured public origin. Server-to-server API callers use bearer authentication, not cookie CSRF rules.
- Production browser traffic uses HTTPS; host loopback bindings or private Docker networking prevent ingress bypass. Remote PostgreSQL uses verify-full and trusted CA. API and worker use different non-superuser DB roles; migrations/initialization alone use administrative credentials.
- Redis auth/ACLs separate API session/rate-limit access from worker queue access. Secrets stay out of logs, fixtures and git. Versions/digests are explicit in production; container processes remain non-root.

## Sessions and delivery assurance

Use Redis TTL-backed session storage with atomic hash rotation and shared revocation. Do not clear all sessions on process shutdown. Refresh token reuse invalidates the session. Frontend parallel requests must not rotate the same refresh token independently; implement distributed single-flight and short-lived protected result sharing, without accepting old refresh tokens at the API. Redis outage denies authentication with 503, not fallback to memory.

CI runs API Vitest AND node tests, bot tests, builds/typechecks, frontend lint/build, dependency and secret scans, container scanning and disposable PostgreSQL/Redis security integration tests. Skip disposable database tests unless TEST_DATABASE_URL is explicitly provided; never use DATABASE_URL as fallback. Document backup and verified restore with no live restore/publish/secret rotation in this work.

## Global constraints

Keep /api/v1 routes, Telegram revisions and numeric/UUID SePay idempotency. Preserve owner-only read-only Swift contract. Keep api-contract.md and openapi.yaml synchronized. Read installed Next.js guides before frontend changes. Agents may edit only assigned files; coordinator owns shared dependency manifests, app/env composition, contracts and AGENTS.md. No production DB changes, remote push, deployment, messages or secret rotation are authorized by these planning files.
