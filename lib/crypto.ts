import crypto from "crypto";

const PREFIX = "enc:v1:";

/**
 * Envelope encryption for per-merchant gateway credentials.
 * MASTER_KEY must be 32 random bytes as hex (64 chars). Generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
export function getMasterKey(): Buffer {
  const hex = process.env.MASTER_KEY;
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex.trim())) {
    throw new Error(
      "MASTER_KEY is missing or invalid (expected 32 bytes as 64 hex chars)"
    );
  }
  return Buffer.from(hex.trim(), "hex");
}

export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(blob: string): string {
  const key = getMasterKey();
  if (!blob.startsWith(PREFIX)) throw new Error("Unknown secret envelope");
  // Envelope: enc:v1:<ivHex>:<tagHex>:<encHex> — pop from the right so the
  // "enc:v1" prefix can never shift the fields.
  const parts = blob.split(":");
  const encHex = parts.pop();
  const tagHex = parts.pop();
  const ivHex = parts.pop();
  if (!ivHex || !tagHex || !encHex) throw new Error("Malformed secret envelope");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return (
    decipher.update(Buffer.from(encHex, "hex")).toString("utf8") +
    decipher.final("utf8")
  );
}

export function isEncryptedBlob(v: string | null | undefined): boolean {
  return typeof v === "string" && v.startsWith(PREFIX);
}

export function maskSecret(v: string | null | undefined): string | null {
  if (!v) return null;
  if (v.length <= 8) return "****";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}
