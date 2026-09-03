# PayRescue — Backend Audit (Real Problems Only)

**Date:** 2026-09-03
**Scope:** `C:\Users\gyank\OneDrive\Desktop\Razorpay project` — Next.js 14 + Supabase Postgres (Drizzle) + Razorpay
**Method:** Full code read of `app/api/**`, `lib/**`, `db/schema.ts`, `db/index.ts`, `drizzle/0000_fluffy_loki.sql`, `scripts/*`, `drizzle.config.ts`, `package.json`, `tsconfig.json`. Ran `npx tsc --noEmit` (passes, exit 0). Checked env var *presence only* (no secret values printed): `DATABASE_URL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` all PRESENT. Compared migration SQL vs current schema. Did not run live DB writes.
**Not in scope:** Frontend polish (handled separately), Razorpay dashboard config.

> Severity: **P0 Critical** = data loss / money movement / security hole / prod crash. **P1 High** = wrong money math / broken guarantee / DoS. **P2 Medium** = contract drift / operability. **P3 Low** = hardening.

---

## Executive summary — fix these 8 first

1. **Migration drift: DB will crash** — `drizzle/0000_fluffy_loki.sql` only creates 5 tables, code expects 13. Any settlement / recon / audit / eval / customer / diagnosis / payment-link query throws `relation does not exist`. Run `npm run db:generate && npm run db:push` and verify. (P0)
2. **Recovery links lie on SDK failure** — `lib/connectors/razorpay.ts:73-80` catches *all* Razorpay errors and returns `success:true` with a fake `https://rzp.io/i/plink_test_…` URL while still marking the case `resolved`. Operator thinks money is recoverable when nothing was created. Must return `success:false` / 502 and leave case open. (P0)
3. **Batch recovery can auto-charge risk blocks** — `app/api/recovery-runs/route.ts:18-32` fetches *all* `open` cases with no `recommendedAction` filter, so `risk_block` cases (which must never auto-retry) get payment links. No auth, no batch cap. Gate behind admin secret, filter to allowlisted actions, cap `max_batch_size` at e.g. 25. (P0)
4. **Connector test flips every merchant to test** — `app/api/connectors/razorpay/test/route.ts:44` runs `db.update(merchants).set({mode:"test"})` with **no WHERE**. One click in test mode converts live merchants. Add `where(eq(merchants.id, …))`. It also logs the raw `keyId` as `entityId` in audit — secret leak. (P0)
5. **Silent localhost DB fallback** — `db/index.ts:11-13` and `drizzle.config.ts:13-15` fall back to `postgresql://postgres:postgres@localhost:5432/payrescue` when `DATABASE_URL` is missing instead of failing fast. A misconfigured prod deploy silently reads/writes the wrong DB. Throw on missing env in production. (P0)
6. **Demo seed endpoints are open in production** — `app/api/demo/scenarios/[name]/route.ts` has no `NODE_ENV` guard and no auth. Anyone can POST/GET and flood prod with `ord_3ds_*`, `ord_risk_*` fake orders. Disable in production or require `ADMIN_SECRET`. (P0)
7. **`payment_links` table is never written** — schema defines it (`db/schema.ts:176-189`) but `createRecoveryPaymentLink` only inserts into `recoveryActions` and never persists `providerLinkId/url/amount/expiry/status`. Expiry is therefore unenforced and the support packet fabricates a URL. Insert into `paymentLinks` in the same transaction. (P0)
8. **No auth on any mutating API** — `payment-cases/[id]/actions`, `payment-link`, `recovery-runs`, `reconciliation/run`, `eval/run`, `demo/scenarios` accept anonymous calls with free-text `approved_by`/`operator`. Audit `actor` is spoofable. Add middleware (session or `ADMIN_SECRET`) before any public deploy. (P0)

`tsc` passing means none of these are type errors — they are logic / data / security bugs. That is why they survived.

---

## P0 Critical (detail)

### C1. Migration drift — 8 tables + columns missing in production
- **Files:** `drizzle/0000_fluffy_loki.sql` vs `db/schema.ts:56-248`
- **Evidence:** SQL creates only `merchants (4 cols)`, `orders`, `payment_attempts (6 cols)`, `payment_cases`, `recovery_actions`, `webhook_events`. Missing: `customers`, `diagnoses`, `payment_links`, `settlements`, `recon_items`, `audit_logs`, `eval_cases`. Also missing columns: `merchants.encrypted_key_ref/timezone/policy_id`, `payment_attempts.method/country`.
- **Impact:** Any code path touching those tables throws at runtime. Reconciliation, audit trail, eval, support packet all crash in a freshly migrated prod DB.
- **Fix:** `npm run db:generate` → review new SQL → `npm run db:push` against a staging Supabase project → verify `\dt` shows 13 tables → commit the new migration. Add CI check `drizzle-kit check`.

### C2. Fake-success recovery links (money-truth violation)
- **File:** `lib/connectors/razorpay.ts:53-80, 83-102`
- **Evidence:** `try { razorpay.paymentLink.create(...) } catch { mockId = plink_test_…; paymentLinkUrl = https://rzp.io/i/… }` then unconditionally inserts `status:"executed"` and sets `paymentCases.status:"resolved"` with message `Executed: Created Payment Link (…)`.
- **Impact:** Dashboard `recovered_amount` counts the full order value as recovered when no link exists. Customer gets a dead link. Financial misstatement.
- **Fix:** On SDK error, insert `status:"proposed"` (or a new `failed` state) with `resultJson` containing the error, return `{success:false}`, HTTP 502 from the route, and **do not** mark case resolved. Only mark resolved after a verified `payment.captured` webhook for the link. Add alerting on consecutive SDK failures.

### C3. Batch executor ignores safety taxonomy
- **File:** `app/api/recovery-runs/route.ts:18-32, 56-84`
- **Evidence:** `where(eq(paymentCases.status,"open"))` with no filter on `failureCategory`/`recommendedAction`. Loops and calls `createRecoveryPaymentLink` for each. `idempKey = batch_rec_${caseId}_${Date.now()}` is not stable across retries.
- **Impact:** `risk_block` / `merchant_config` / `unknown` cases get links against policy. `max_batch_size` is uncapped (`Number(...) || 10` — attacker sends 100000). Partial failures leave half the batch resolved.
- **Fix:** Allowlist: only `recommendedAction IN ('send_alternate_payment_link') AND failureCategory NOT IN ('risk_block')`. Clamp batch size `Math.min(...,25)`. Use deterministic keys (`batch_${runId}_${caseId}`). Wrap each item in try/catch (already does) **and** record failures in audit. Require admin auth + `mode:"execute"` confirmation token.

### C4. Connector test mass-updates merchants + leaks key
- **File:** `app/api/connectors/razorpay/test/route.ts:42-53`
- **Evidence:** `await db.update(merchants).set({mode:"test"})` — no WHERE. `logAuditEvent({entityId: keyId, …})` stores key prefix in plaintext audit.
- **Fix:** Update only the target merchant by id. Mask key (`rzp_test_…XXXX`) in logs. Never store secrets in `audit_logs`.

### C5. Silent wrong-DB fallback
- **Files:** `db/index.ts:11-13`, `drizzle.config.ts:13-15`
- **Fix:** `if (!process.env.DATABASE_URL && process.env.NODE_ENV==="production") throw new Error("DATABASE_URL missing")`. Keep localhost fallback for dev only with an explicit `ALLOW_LOCAL_DB=1` flag. Log the host (not the password) on boot.

### C6. Open demo seeding
- **File:** `app/api/demo/scenarios/[name]/route.ts:30-482`
- **Fix:** `if (process.env.NODE_ENV==="production" && !isAdmin(req)) return 403`. Better: move seeder to `scripts/` only, delete the route before launch, or gate with `ADMIN_SECRET` header.

### C7. `payment_links` orphaned
- **Files:** `db/schema.ts:176-189`, `lib/connectors/razorpay.ts:82-93`, `lib/ai/support-packet.ts:52`
- **Evidence:** No `import {paymentLinks}` anywhere in `lib/` or `app/api/`. Support packet fabricates `https://rzp.io/i/rec_${action.id.substring(0,8)}` instead of using a stored URL.
- **Fix:** In one transaction: insert `recoveryActions` → call Razorpay → insert `paymentLinks {caseId, providerLinkId, url, amount, currency, expiry, status}` → update case. Support packet must read from `paymentLinks`, not reconstruct.

### C8. Zero authZ on money-moving routes
- **Files:** all `app/api/payment-cases/[id]/actions/route.ts`, `payment-link/route.ts`, `recovery-runs/route.ts`, `reconciliation/run/route.ts`, `eval/run/route.ts`, `demo/scenarios/[name]/route.ts`
- **Evidence:** `approvedBy = body?.approved_by || "operator"`, `operator = body?.operator || "lead_operator"`. No `headers().get("authorization")`, no middleware.ts.
- **Fix:** Add `middleware.ts` requiring session or `x-admin-secret` for `/api/*` except `/api/webhooks/*` and read-only GETs (if public demo, still rate-limit). Propagate authenticated actor into `logAuditEvent` instead of trusting body.

---

## P1 High

### H1. Idempotency check-then-insert race (double charge / double link)
- **File:** `lib/connectors/razorpay.ts:27-45, 83-93`
- **Evidence:** `SELECT … WHERE idempotencyKey` then later `INSERT`. Two concurrent requests both see zero rows and both insert. The `unique` constraint on `idempotency_key` (`db/schema.ts:166`) will make one throw 23505, but the code does not catch it — user gets 500 instead of the existing action.
- **Fix:** `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING *` then if no row returned, SELECT existing. Or catch 23505 and return existing. Same pattern needed in `actions/route.ts:72-83, 100-112` and `diagnose/route.ts:48-57`.

### H2. Webhook `providerEventId` fallback destroys idempotency
- **File:** `app/api/webhooks/razorpay/route.ts:46-50`
- **Evidence:** `providerEventId = header || body.event_id || body.id || evt_${Date.now()}_${random}`.
- **Impact:** If Razorpay omits the header (or an attacker posts without it), every retry creates a new row — retry-storm protection is defeated.
- **Fix:** Require a stable id. If missing, derive deterministically e.g. `sha256(rawBody)` or return 400. Log and alert on missing header.

### H3. Non-payment webhooks stored but never processed
- **File:** `app/api/webhooks/razorpay/route.ts:95-147`
- **Evidence:** `if (paymentEntity) { …; update processed=true }`. `refund.processed`, `settlement.processed`, `payment.authorized/captured` without `payload.payment.entity` shape, subscription events → stored with `processed:false` forever. No worker ever picks them up.
- **Fix:** Handle `refund.*` (update attempt → `refunded`, open finance case), `settlement.*` (upsert `settlements`), mark processed after handling, add a `processed_at` column + cron to retry `processed=false AND received_at < now()-5m`.

### H4. No state-machine guard (terminal states can regress)
- **Files:** `lib/domain/normalizer.ts:69-109`, `app/api/webhooks/razorpay/route.ts:114-133`
- **Evidence:** `updatePaymentState` blindly overwrites `status`. A delayed `payment.failed` can overwrite `captured`; a duplicate `payment.created` can overwrite `settled`. The `out_of_order_webhooks` demo claims the state machine "preserved captured" but the real code has no such check.
- **Fix:** Define allowed transitions (`initiated→authorized→captured→settled`, `*→failed/refunded` only from non-terminal, never `captured→failed`). Ignore stale events and log `stale_event_ignored`.

### H5. Missing uniqueness + indexes (duplicates + full scans)
- **File:** `db/schema.ts:83-110`
- **Evidence:** `orders.externalOrderId` not unique, `paymentAttempts.providerPaymentId` not unique, `recon_items(sourceType,sourceId)` not unique, no indexes on `merchant_id/order_id/created_at/event_type/status`.
- **Impact:** `ensureOrderForWebhook` check-then-insert races create duplicate orders under concurrent webhooks. Dashboard `payment-cases/route.ts:10-34` + `dashboard/summary/route.ts:11-20` full-scan all rows. At 100k rows the control room times out.
- **Fix:** Add `unique` on `externalOrderId`, `providerPaymentId` (where not null), `(sourceType,sourceId)`. Add indexes on all FKs + `createdAt` + `status`. Add pagination (`?limit&cursor`) to list routes. Use SQL aggregation (`SUM`, `COUNT … GROUP BY`) instead of JS loops.

### H6. Dashboard money math is wrong
- **Files:** `app/api/dashboard/summary/route.ts:28-42`, `app/api/payment-cases/route.ts:48-55`
- **Evidence:** Sums `amount` across USD/EUR/INR/GBP into one `$` number. Divides everything by 100 (breaks JPY, KRW). Counts full order value as `recovered_amount` on `resolved` even if the link was never paid. `recoverable` heuristic is substring match on free-text `recommendedAction`.
- **Fix:** Group by currency, format with `Intl.NumberFormat`. Only count `recovered` after a `payment.captured` webhook references the link. Replace free-text check with `failureCategory/recommendedAction` enum.

### H7. `payment-cases` list N+1 / unbounded
- **File:** `app/api/payment-cases/route.ts:31-42`
- **Evidence:** Loads **all** attempts (`select().from(paymentAttempts).orderBy(...)` with no limit) then groups in JS.
- **Fix:** Paginate, or join lateral `SELECT DISTINCT ON (order_id) … ORDER BY created_at DESC`. Cap at 50 + cursor.

### H8. Eval benchmark pollutes prod + tests itself
- **File:** `lib/ai/evaluator.ts:217-228`, `app/api/eval/run/route.ts:7-19`
- **Evidence:** Every `POST /api/eval/run` inserts 50 rows into prod `eval_cases` with no cleanup. Expectations are hardcoded to match the same `diagnosePaymentFailure` rules — pass rate is tautological, not held-out. Route has no auth → anyone can spam 50-row writes.
- **Fix:** Write eval results to a separate schema/table or in-memory report, or delete previous run's rows in a transaction. Use a truly held-out fixture file reviewed by a human. Require admin auth + rate limit.

### H9. Audit logger lies on failure
- **File:** `lib/domain/audit.ts:19-50`
- **Evidence:** `catch { return {id:"error-log", …} }`. Caller (`reconciliation.ts:91-97`, `actions/route.ts:55-61`) assumes success. Compliance trail has silent holes.
- **Fix:** Re-throw or return `null` and let caller handle. Add DB-level append-only enforcement (revoke UPDATE/DELETE on `audit_logs` from app role, or add trigger). Propagate `x-request-id` from request instead of random `req_${Date.now()}`.

### H10. Reconciliation engine never uses its own index + miscounts
- **File:** `lib/domain/reconciliation.ts:30-140`
- **Evidence:** Builds `attemptsByProviderId` (line 33-38) then never reads it. For each settlement does a sequential `SELECT recon_items` (N+1). `pending++` only when inserting; on re-run existing pendings are not counted → `pending_count` flaps. `total_processed = settlements.length` ignores payments.
- **Fix:** Batch-load existing recon items into a Map. Count from DB after upserts. Add unique `(sourceType,sourceId)` + `ON CONFLICT DO UPDATE`. Add date-window param (`?since=`) instead of full rescan.

---

## P2 Medium

| # | Problem | File:line | Fix |
|---|---------|------------|-----|
| M1 | Two failure taxonomies diverge: `normalizer.openOrUpdateCase` emits `customer_action_required/issuer_decline/gateway_failure` (`normalizer.ts:149-166`) while `ai/diagnose.ts:3-10` emits `customer_action/transient/eligibility/merchant_config/finance_exception/unknown`. Filters and eval break. | `lib/domain/normalizer.ts:149-166`, `lib/ai/diagnose.ts:3-10` | Single shared `FailureCategory` enum imported by both. Backfill old rows. |
| M2 | Duplicate recovery routes: `payment-cases/[id]/actions` and `payment-cases/[id]/payment-link` both create links with different defaults (`operator` vs `merchant_operator`, `act_…` vs `case_…_rec_…`). | `app/api/payment-cases/[id]/actions/route.ts:21-24`, `payment-link/route.ts:27-29` | Keep one canonical route; make the other a thin wrapper. Standardize idempotency key format. |
| M3 | Default idempotency keys use `Date.now()` so client retries without a key create duplicates. | `actions/route.ts:23-24`, `payment-link/route.ts:28-29`, `recovery-runs/route.ts:58` | Require client-supplied UUID; if missing, return 400 with `idempotency_key required`. |
| M4 | `openOrUpdateCase` only dedupes `status:"open"`, ignores `action_required`, so a second failure creates a second case for the same order. | `lib/domain/normalizer.ts:128-137` | Dedupe on `status IN ('open','action_required')`. Add partial unique index. |
| M5 | Support packet fabricates link + hardcodes `$`. | `lib/ai/support-packet.ts:49-52` | Read real URL from `paymentLinks`, format with `Intl.NumberFormat(currency)`. |
| M6 | `audit/route.ts:21` does `JSON.parse(beforeJson)` without try/catch — one corrupt row 500s the whole audit page. | `app/api/audit/route.ts:18-22` | Safe-parse helper returning `null` on error. |
| M7 | `getAuditHistory` filters by entity **or** actor, never both; no date range or cursor. | `lib/domain/audit.ts:56-86` | Accept `{entity, actor, since, until, cursor, limit}` with `and(...)`. |
| M8 | No input validation anywhere (`req.json().catch(()=>({}))`, `Number(amount)||0`, `currency.toUpperCase()` unvalidated). Zero-amount orders and bad currencies reach Razorpay SDK. | `webhooks/route.ts:102-103`, `actions/route.ts:20-24` | Add Zod schemas, reject `amount<=0`, allowlist currencies `["INR","USD","EUR","GBP","CAD","AUD","SGD","AED"]`. |
| M9 | `diagnose/route.ts` inserts unbounded `diagnoses` rows on every click with no dedupe. | `app/api/payment-cases/[id]/diagnose/route.ts:48-57` | Upsert per `(caseId, category, model)` or keep latest-only + history limit. |
| M10 | `ensureOrderForWebhook` creates `status:"pending"` orders with `amount:0` when payload is malformed; `externalOrderId` falls back to `order_ext_${providerPaymentId}` — phantom orders pollute recon. | `lib/domain/normalizer.ts:201-246`, `webhooks/route.ts:97-100` | Validate amount/currency before creating order; return 400 on malformed payload instead of inventing an order. |
| M11 | Hardcoded timeline `step:1..4` with duplicates; sorting relies on insert order, not timestamp. | `app/api/payment-cases/[id]/route.ts:84-140` | Sort merged timeline by `timestamp`, use unique `step` ids or UUIDs. |
| M12 | `postgres` client uses `ssl:"require"` without Supabase pooler tuning; `drizzle.config.ts` + `db/index.ts` duplicate dotenv loading; `max:1` in dev can starve concurrent webhook + recon. | `db/index.ts:23-35` | For pooler (`:6543`): `prepare:false`. Centralize env loading in one module. Document `?pgbouncer=true`. |
| M13 | Eval `score` stored as `"1.00"/"0.50"` strings; `eval/summary/route.ts:17` does `Number(score)>=1.0` — half-credit rows count as failures but UI calls it accuracy. | `lib/ai/evaluator.ts:224`, `app/api/eval/summary/route.ts:16-18` | Store numeric + separate `category_ok/action_ok` booleans. |
| M14 | Secrets in error messages: `getRazorpayClient` throws with `.env.local` path hint; connector test echoes error text containing key fragments. | `lib/razorpay.ts:49-52`, `connectors/test/route.ts:38` | Generic messages to client, full error server-side only. |

---

## P3 Low (hardening before public launch)

- **No `middleware.ts`, security headers, CORS, or rate limits.** Add `next.config.mjs: headers()` for HSTS/CSP/X-Frame-Options, and per-IP throttling on `/api/webhooks/*` (generous) vs `/api/*/execute` (strict). (`next.config.mjs:1-6`)
- **Raw webhook bodies unbounded.** Add `export const config = { api: { bodyParser: { sizeLimit: "1mb" } } }` equivalent (route segment `maxDuration`, size check on `rawBody.length`) and a retention job deleting `webhook_events.raw_body` after 90 days (keep hash).
- **`requestId` not propagated.** Read `x-request-id` / `x-razorpay-event-id` in routes and pass to `logAuditEvent`. Correlate webhook → case → action → recon.
- **Structured logging.** Replace `console.log/error` with a JSON logger (pino) including `requestId/caseId/eventId`. Needed for the "immutable audit trail" claim.
- **`tsconfig.json:7` has `strict:true` (good) but `skipLibCheck:true` + no `noUncheckedIndexedAccess`.** Enable `noUncheckedIndexedAccess` and fix resulting index errors before launch.
- **README webhook table lists `payment.authorized/captured` but route only acts on `failed`.** Document actual behavior or implement authorized/captured handling. (`README.md:24-38`)
- **`.gitignore` correctly excludes `.env*.local` — keep it.** Verify `git status` never shows `.env.local` before first push. (Checked: `.gitignore:26`.)

---

## How to reproduce (safe, no secrets)

1. `npx tsc --noEmit` → passes (proves bugs are logic, not types).
2. `npx drizzle-kit check` / `npx drizzle-kit generate --dry-run` → shows new migration needed for 8 tables.
3. `grep -rn "ON CONFLICT" app lib` → zero results (confirms idempotency races).
4. `grep -rn "paymentLinks" lib app/api` → zero writes (confirms C7).
5. `grep -rn "db.update(merchants)" app` → hits the unscoped update (confirms C4).
6. `grep -rn "authorization\|ADMIN_SECRET\|getServerSession" app/api middleware.ts` → zero results (confirms C8).
7. Start dev, POST `/api/demo/scenarios/risk_block_do_not_bypass` then POST `/api/recovery-runs` `{"mode":"execute"}` → observe a link created for a risk block (confirms C3). Do this against a throwaway local DB only.

## Recommended fix order (smallest safe slices)

1. Fail fast on missing `DATABASE_URL` + generate/push migration (C1, C5) — 1 PR.
2. Stop fake-success links + persist `paymentLinks` transactionally (C2, C7) — 1 PR.
3. Scope merchant update + mask keys (C4) — 1 PR.
4. Auth gate + batch allowlist + cap (C3, C6, C8) — 1 PR.
5. Deterministic webhook ids + state-machine guard + unique constraints (H2, H4, H5) — 1 PR with migration.
6. Dashboard SQL aggregation + currency grouping + pagination (H6, H7) — 1 PR.
7. Audit append-only + safe JSON parse + propagated requestId (H9, M6-M7) — 1 PR.
8. Eval isolation + input validation (Zod) + logging/headers (H8, M8, P3) — final PR.

---

## Files reviewed

`app/api/webhooks/razorpay/route.ts`, `app/api/payment-cases/route.ts`, `app/api/payment-cases/[id]/route.ts`, `diagnose/route.ts`, `actions/route.ts`, `payment-link/route.ts`, `app/api/recovery-runs/route.ts`, `dashboard/summary/route.ts`, `audit/route.ts`, `reconciliation/{run,exceptions}/route.ts`, `support/[id]/route.ts`, `eval/{run,summary}/route.ts`, `connectors/razorpay/test/route.ts`, `demo/scenarios/[name]/route.ts`, `lib/razorpay.ts`, `lib/connectors/razorpay.ts`, `lib/domain/{normalizer,reconciliation,audit}.ts`, `lib/ai/{diagnose,evaluator,support-packet}.ts`, `db/schema.ts`, `db/index.ts`, `drizzle.config.ts`, `drizzle/0000_fluffy_loki.sql`, `scripts/*`, `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `README.md`.
