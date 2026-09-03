/**
 * Gateway driver abstraction.
 *
 * - `razorpay`: the real Razorpay SDK (test or live keys). Failures throw
 *   honestly — never a fake success.
 * - `simulated`: deterministic sandbox driver used ONLY when DEMO_MODE is on
 *   (judge demos, hackathon walkthroughs). It mints demo checkout URLs
 *   served by this same app (`/demo/checkout/[actionId]`) where a "Pay"
 *   click completes the loop. Every simulated artifact is labeled demo in
 *   the DB (`result_json.simulated`, `providerLinkId = demo_*`) and the UI.
 *
 * DEMO_MODE forces the simulated driver for ALL gateway calls, even when
 * real keys exist — a demo deployment can never move real money.
 */
export interface GatewayLink {
  url: string;
  id: string;
  simulated: boolean;
  expiresAt: Date;
}

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

export function simulatedLinkFor(
  actionId: string,
  baseUrl: string,
  ttlMinutes = 60
): GatewayLink {
  const cleanBase = baseUrl.replace(/\/$/, "");
  return {
    url: `${cleanBase}/demo/checkout/${actionId}`,
    id: `demo_${actionId.replace(/-/g, "").slice(0, 16)}`,
    simulated: true,
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
  };
}

export function isSimulatedLinkId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith("demo_");
}
