import { NextRequest, NextResponse } from "next/server";
import {
  applyCouncilDecision,
  localOperatorDeniedPayload,
  validateLocalOperatorRequest,
} from "@/lib/self-improvement-data.mjs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
) {
  const validation = validateLocalOperatorRequest(request);
  if (!validation.ok) {
    return NextResponse.json(localOperatorDeniedPayload(validation.reason), { status: validation.status ?? 403 });
  }

  try {
    const { itemId } = await params;
    const body = await request.json().catch(() => ({}));
    const now = new Date().toISOString();
    const snoozeUntil =
      typeof body?.snoozeUntil === "string" && body.snoozeUntil.trim() !== ""
        ? body.snoozeUntil
        : new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString();

    const result = applyCouncilDecision({
      itemId,
      decision: "snoozed",
      note: body?.note,
      actor: body?.actor ?? "rd-council-api",
      snoozeUntil,
      now,
    });

    return NextResponse.json({
      success: true,
      message: "R&D Council item snoozed",
      item: result.item,
      audit: result.auditEntry,
    });
  } catch (error) {
    const message = (error as Error).message || "Snooze failed";
    const status = /not found/i.test(message) ? 404 : /required|unsupported/i.test(message) ? 400 : 500;
    return NextResponse.json(
      {
        success: false,
        message,
      },
      { status }
    );
  }
}
