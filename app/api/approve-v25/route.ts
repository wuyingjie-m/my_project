import { NextRequest, NextResponse } from "next/server";
import {
  applyCouncilDecision,
  localOperatorDeniedPayload,
  validateLocalOperatorRequest,
} from "@/lib/self-improvement-data.mjs";

export async function POST(request: NextRequest) {
  const validation = validateLocalOperatorRequest(request);
  if (!validation.ok) {
    return NextResponse.json(localOperatorDeniedPayload(validation.reason), { status: validation.status ?? 403 });
  }

  try {
    const body = await request.json();
    if (typeof body?.itemId !== "string" || body.itemId.trim() === "") {
      return NextResponse.json(
        {
          success: false,
          message: "itemId is required",
        },
        { status: 400 }
      );
    }

    const result = applyCouncilDecision({
      itemId: body.itemId,
      decision: "approved",
      note: body.note,
      actor: body.actor ?? "rd-council-api",
    });

    return NextResponse.json({
      success: true,
      message: "R&D Council item approved",
      item: result.item,
      audit: result.auditEntry,
      workOrder: result.workOrder,
    });
  } catch (error) {
    const message = (error as Error).message || "Approval failed";
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
