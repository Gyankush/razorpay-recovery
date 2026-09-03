# PayRescue AI Roadmap — from copilot to autonomous winner

## Where we are (shipped)

- **L1 — Deterministic diagnosis:** rule engine maps gateway evidence to
  `customer_action / risk_block / transient / merchant_config / unknown`
  with confidence, facts, do-not-do guardrails and stopping rules.
- **L2 — Bounded autonomy (new):** the Autopilot agent (`/api/agent/run`,
  Vercel Cron every 15 min) auto-recovers allowlisted, under-cap,
  high-confidence cases per merchant policy, auto-resolves late captures,
  runs reconciliation, and files skip-reasons + run reports in audit.
- **L3 — Oversight:** copilot brief (`/api/agent/brief` + `/autopilot`
  page) surfaces 24h activity, 7d recovery rate and anomaly flags
  (failure spikes, risk elevation, backlog growth).

Autonomy is deliberately **policy-gated**: risk/config/unknown can never
auto-execute, amounts are capped, and everything is audited. That safety
story is the moat — merchants trust automation they can bound.

## Next features, ranked

### 1. LLM diagnosis with citations (impact: highest)
Pipe the diagnosed facts + gateway payload into an LLM (e.g. GPT-4o-mini)
that returns `category + explanation + citations[fact_ids]`. Hard rules:
output contract validated by Zod; any uncited claim → fall back to the
rule engine; temperature 0. This upgrades explanations from templated to
truly case-specific while the rule engine stays the safety floor.
*Needs: `LLM_API_KEY`, eval harness already exists (`/api/eval/run`).*

### 2. Smart send-time + rail selection (impact: high)
Learn per-merchant recovery-rate by hour/currency from `recovery_actions`
× `payment_links`, then schedule links at the best window and pick the
cheapest rail (card link vs UPI intent vs EMI). Fully offline-computable
from tables we already own.

### 3. Anomaly alerts to Slack/email (impact: high, effort: low)
Push the brief's `anomalies[]` to Slack webhook / SES on every agent run
that raises a `warn`. Turns the dashboard into a push product.

### 4. Self-tuning caps (impact: high)
Weekly job: if a merchant's auto-recovery success rate > 95% over 50+
actions, propose (not apply) a cap raise in the brief; operator one-click
approves. Closes the learning loop without surrendering control.

### 5. "Ask Copilot" case chat (impact: medium)
Read-only RAG over the case timeline + audit + gateway docs. Strictly
no tool access to money-moving endpoints — answers cite timeline events.

### 6. FX-aware recovery rails (impact: medium)
For cross-border cases, quote the link in the customer's currency with a
live FX estimate and disclose the markup — kills the #1 recon discrepancy
at the source instead of explaining it afterwards.

### 7. Win-back predictions (impact: medium, effort: high)
Score open cases by P(recover | category, amount, age, history) from
`payment_cases` × `recovery_actions` and sort the queue by expected
recovered value. Needs ~3 months of production data first.

## What NOT to build
Auto-retrying the same card, bypassing risk blocks, or letting any model
move money without a policy cap + idempotency key + audit row. The day the
agent surprises an operator is the day trust dies.
