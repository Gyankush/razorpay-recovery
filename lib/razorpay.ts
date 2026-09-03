import crypto from "crypto";
import Razorpay from "razorpay";

/**
 * Verifies the Razorpay webhook signature against the raw request body.
 * Uses timingSafeEqual to prevent timing attacks.
 *
 * @param rawBody - Raw string content of the request body
 * @param signature - Signature provided in 'x-razorpay-signature' header
 * @param secret - Webhook secret configured in Razorpay dashboard
 * @returns boolean indicating if the signature is authentic
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  if (!rawBody || !signature || !secret) {
    return false;
  }

  try {
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const expectedBuffer = Buffer.from(expectedSignature, "utf8");
    const signatureBuffer = Buffer.from(signature, "utf8");

    if (expectedBuffer.length !== signatureBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  } catch (error) {
    console.error("Error verifying webhook signature:", error);
    return false;
  }
}

/**
 * Creates and returns an authenticated instance of the Razorpay Node SDK.
 */
export function getRazorpayClient(): Razorpay {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    throw new Error(
      "Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET. Please ensure they are set in your .env.local file."
    );
  }

  return new Razorpay({
    key_id,
    key_secret,
  });
}

