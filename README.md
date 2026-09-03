# PayRescue — International Payment Recovery Copilot

PayRescue helps Indian SaaS and D2C merchants understand why an international payment failed, choose the safest recovery step, and prove what happened later with an immutable audit trail.

---

## ⚙️ Environment Configuration

Ensure your `.env.local` contains your Supabase PostgreSQL connection string and your Razorpay webhook secret:

```bash
# Supabase PostgreSQL Connection String
DATABASE_URL="postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres"

# Razorpay Webhook Configuration
# ⚠️ IMPORTANT: Set this secret to match the secret configured in Razorpay Dashboard
RAZORPAY_WEBHOOK_SECRET="your_razorpay_webhook_secret"

# Razorpay API Credentials (Test Mode)
RAZORPAY_KEY_ID="rzp_test_your_key_id"
RAZORPAY_KEY_SECRET="your_key_secret"
```

> **Note**: In the Razorpay Dashboard, navigate to **Settings > Webhooks**, create a webhook pointing to your `/api/webhooks/razorpay` endpoint, select events (e.g., `payment.failed`, `payment.authorized`, `payment.captured`), and copy the Secret into `RAZORPAY_WEBHOOK_SECRET`.

---

## 📡 Webhook Event Spine

The webhook receiver is implemented at [`app/api/webhooks/razorpay/route.ts`](file:///c:/Users/gyank/OneDrive/Desktop/Razorpay%20project/app/api/webhooks/razorpay/route.ts) with the following guarantees:

1. **HMAC-SHA256 Signature Verification**:
   - The raw request body (`req.text()`) is verified against the `x-razorpay-signature` header using [`lib/razorpay.ts`](file:///c:/Users/gyank/OneDrive/Desktop/Razorpay%20project/lib/razorpay.ts) with timing-safe comparison to prevent timing attacks.
   - If the signature is invalid or the secret is missing, it returns `401 Unauthorized`.
2. **Idempotency & Deduplication**:
   - Extracts the `x-razorpay-event-id` header (or payload `event_id`).
   - Inserts into the `webhook_events` table in PostgreSQL with `provider_event_id`, `event_type`, `raw_body`, and `signature_valid: true`.
   - If a duplicate event arrives (unique constraint violation on `provider_event_id`), the route catches the error, logs `"Duplicate event skipped"`, and returns `200 OK` to prevent webhook retry storm from Razorpay.

---

## 🚀 Running the Project

```bash
# Start Next.js development server
npm run dev

# Generate database migrations
npm run db:generate

# Push schema to Supabase
npm run db:push

# Open Drizzle Studio
npm run db:studio
```
