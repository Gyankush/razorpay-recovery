# Deploying PayRescue — Vercel + Supabase + Neon

## Architecture

| Layer | Prod | Dev / branches |
|---|---|---|
| Hosting + Cron | **Vercel** (Next.js, cron every 15 min → `/api/agent/run`) | `npm run dev` locally |
| Primary Postgres | **Supabase** (`DATABASE_URL`) | — |
| Branch / experiment Postgres | — | **Neon** (any `postgresql://` URL via `--db-url`) |

The app speaks vanilla Postgres (`postgres` driver + Drizzle), so Supabase and
Neon are interchangeable connection strings. Convention: **Supabase = prod
truth, Neon = disposable dev branches.**

## 1. Supabase (prod backend)

1. Create project at supabase.com → get the **pooled** connection string
   (port `6543`, ends with `?pgbouncer=true`).
2. Run `npm run db:check -- --db-url="<supabase-pooled-url>"` — expect all tables present.
3. First-time only: `npm run db:push` (or apply `drizzle/*.sql` in order).

## 2. Neon (dev backend)

1. Create project at neon.tech → **Branches** → create a branch per experiment.
2. Copy its pooled connection string.
3. Validate + migrate the branch:
   ```bash
   npm run db:check -- --db-url="<neon-branch-url>"
   DATABASE_URL="<neon-branch-url>" npm run db:push
   ```
4. Point local dev at it: `DATABASE_URL="<neon-branch-url>" npm run dev`.
5. Delete the branch when done — nothing disposable ever touches Supabase.

## 3. Vercel (hosting)

### Option A — dashboard (easiest)
1. Push to GitHub (already done: `Gyankush/razorpay-recovery`).
2. vercel.com → Add New Project → import that repo. Framework preset: Next.js.
3. Add **Environment Variables** (Production + Preview):

| Var | Value |
|---|---|
| `DATABASE_URL` | Supabase pooled URL |
| `RAZORPAY_KEY_ID` | `rzp_test_…` (or live key when ready) |
| `RAZORPAY_KEY_SECRET` | matching secret |
| `RAZORPAY_WEBHOOK_SECRET` | must match Razorpay dashboard webhook secret |
| `ADMIN_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CRON_SECRET` | another random 32-byte hex (≠ ADMIN_SECRET) |

4. Deploy. Cron (`vercel.json` → `/api/agent/run` daily at 03:00 UTC — the
   Hobby-plan maximum; tighten to `*/15 * * * *` on Pro for near-real-time
   autonomy) activates automatically; Vercel attaches `CRON_SECRET` as a
   Bearer token. Intraday runs are always available via
   Autopilot page → "Run agent now".

### Option B — CLI
```bash
npm i -g vercel
vercel login
vercel link
vercel env add DATABASE_URL production      # repeat per var above
vercel --prod
```

## 4. Razorpay webhook URL

Razorpay Dashboard → Settings → Webhooks → point to
`https://<your-app>.vercel.app/api/webhooks/razorpay`, subscribe to
`payment.failed`, `payment.authorized`, `payment.captured`,
`refund.processed`, paste the secret into both dashboard and Vercel
`RAZORPAY_WEBHOOK_SECRET`, then send a test event.

## 5. Post-deploy checklist

- [ ] `GET /api/dashboard/summary` returns 200
- [ ] `GET /api/agent/brief` with `x-admin-secret` returns a brief
- [ ] Vercel → Cron Jobs shows the 15-min agent run succeeding
- [ ] Razorpay test webhook → new case appears in the queue
- [ ] Autopilot page: policy stays **OFF** until you deliberately enable it
- [ ] `ADMIN_SECRET`/`CRON_SECRET` are set (prod mutations 503 without them — by design)
