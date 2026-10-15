import { NextRequest, NextResponse } from "next/server";
import {
  localOperatorDeniedPayload,
  readCouncilItems,
  validateLocalOperatorRequest,
} from "@/lib/self-improvement-data.mjs";

export async function GET(request: NextRequest) {
  const validation = validateLocalOperatorRequest(request);
  if (!validation.ok) {
    return NextResponse.json(localOperatorDeniedPayload(validation.reason), { status: validation.status ?? 403 });
  }

  try {
    const items = readCouncilItems();
    return NextResponse.json({
      success: true,
      items,
      total: items.length,
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
