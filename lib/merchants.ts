import { db } from "@/db";
import { merchants, type Merchant } from "@/db/schema";
import { decryptSecret, isEncryptedBlob } from "@/lib/crypto";
import { safeJsonParse } from "@/lib/http";
import { eq } from "drizzle-orm";

export interface MerchantSecrets {
  keyId: string | null;
  keySecret: string | null;
  webhookSecret: string | null;
}

export async function getMerchant(id: string): Promise<Merchant | null> {
  const [m] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, id))
    .limit(1);
  return m ?? null;
}

export async function findMerchantByAccountId(
  accountId: string
): Promise<Merchant | null> {
  if (!accountId) return null;
  const [m] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.providerAccountId, accountId))
    .limit(1);
  return m ?? null;
}

/**
 * Resolves gateway credentials for a merchant: per-merchant encrypted
 * secrets win, global env is the fallback (single-merchant / dev setups).
 */
export function resolveMerchantSecrets(m: Merchant | null): MerchantSecrets {
  const fallback: MerchantSecrets = {
    keyId: process.env.RAZORPAY_KEY_ID ?? null,
    keySecret: process.env.RAZORPAY_KEY_SECRET ?? null,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? null,
  };
  if (!m?.encryptedKeyRef || !isEncryptedBlob(m.encryptedKeyRef)) {
    return fallback;
  }
  try {
    const parsed = safeJsonParse<{
      key_id?: string;
      key_secret?: string;
      webhook_secret?: string;
    }>(decryptSecret(m.encryptedKeyRef));
    return {
      keyId: parsed?.key_id || fallback.keyId,
      keySecret: parsed?.key_secret || fallback.keySecret,
      webhookSecret: parsed?.webhook_secret || fallback.webhookSecret,
    };
  } catch (err) {
    console.error(
      `[Merchants] cannot decrypt secrets for merchant ${m.id} (MASTER_KEY mismatch?) — falling back to global env`
    );
    return fallback;
  }
}
