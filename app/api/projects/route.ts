import { NextRequest, NextResponse } from "next/server";
import {
  localOperatorDeniedPayload,
  readActiveProjectsInventory,
  validateLocalOperatorRequest,
} from "@/lib/self-improvement-data.mjs";

export async function GET(request: NextRequest) {
  const validation = validateLocalOperatorRequest(request);
  if (!validation.ok) {
    return NextResponse.json(localOperatorDeniedPayload(validation.reason), { status: validation.status ?? 403 });
  }

  try {
    const inventory = readActiveProjectsInventory();

    return NextResponse.json({
      success: true,
      projects: inventory.projects,
      total: inventory.total,
      status: inventory.status,
      source: inventory.source,
      reason: inventory.reason,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        message: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
