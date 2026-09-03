import { NextRequest, NextResponse } from "next/server";
import { generateSupportPacket } from "@/lib/ai/support-packet";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const caseId = params?.id;
    if (!caseId) {
      return NextResponse.json({ error: "Case ID required" }, { status: 400 });
    }

    const packet = await generateSupportPacket(caseId);
    if (!packet) {
      return NextResponse.json({ error: "Case not found" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      packet,
    });
  } catch (error) {
    console.error("Error generating support packet:", error);
    return NextResponse.json(
      { error: "Failed to generate support packet" },
      { status: 500 }
    );
  }
}
