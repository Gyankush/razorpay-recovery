import { NextResponse } from "next/server";
import { isDemoMode } from "@/lib/gateway";

export const dynamic = "force-dynamic";

/** Public demo-mode flag so the UI can show the sandbox banner/tour. */
export async function GET() {
  return NextResponse.json({
    demo_mode: isDemoMode(),
    gateway: isDemoMode() ? "simulated" : "razorpay",
  });
}
