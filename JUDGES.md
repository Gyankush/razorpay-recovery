# Judge Walkthrough — PayRescue live demo (5 minutes, no login)

**Live URL:** https://razorpay-recovery.vercel.app
**What you need:** nothing. No account, no keys, no real money.
**What it is:** an International Payment Recovery Copilot — when a
cross-border payment fails, PayRescue diagnoses the root cause, proposes one
bounded recovery step (approved by a human), and proves everything later in
an immutable audit trail. The sandbox gateway is simulated; every screen and
DB row is labeled demo.

## The 4-click loop

1. **Seed a failure** — on the Control Room, click **Seed 3DS Fail**.
   A realistic international 3-D Secure drop-off lands in the recovery queue
   with amount, gateway reason, failure category and confidence.
2. **Investigate** — click **Investigate**: AI diagnosis (category, facts,
   explanation), what-NOT-to-do guardrails, stopping rule, event timeline,
   and a one-click customer support packet.
3. **Approve & Generate Payment Link** — the single bounded recovery action
   (idempotent: approving twice creates exactly one link, 60-min expiry).
4. **Pay as the customer** — open the generated link, hit **Pay**:
   capture → link marked paid → case resolved → merchant notified.
   Then open **Audit Trail**: every step above is an immutable row.

## Also worth opening

- **Autopilot** (`/autopilot`): the autonomous AI — flip a merchant ON, seed a
  failure, hit **Run agent now**, and watch it auto-recover safe cases while
  skipping risky ones with reasons. No key needed in this sandbox. Per-merchant
  guardrails (caps, confidence floor, allowlisted categories; risk blocks can
  never auto-execute) plus the copilot brief with anomaly flags.
- **Audit Trail** (`/audit`): recovery actions + append-only system log.
- **API (all live):** `GET /api/dashboard/summary`,
  `GET /api/payment-cases`, `GET /api/demo/status`.

## What's real vs simulated here

- Real: Next.js 14 + Supabase Postgres, HMAC webhook spine, canonical
  payment state machine, idempotent recovery executor, reconciliation
  engine, audit trail, autopilot policy engine.
- Simulated in this deployment: the money movement itself (demo checkout
  instead of Razorpay live rails) — forced by `DEMO_MODE=true`, so this
  deployment can never touch real funds. Point the same codebase at live
  keys with `DEMO_MODE` off for production.
