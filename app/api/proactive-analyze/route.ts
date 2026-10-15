import {
  appendCouncilItems,
  buildCouncilItemsFromUsage,
  findSessionFile,
  localOperatorDeniedPayload,
  readJsonFile,
  upsertLedgerProposed,
  validateLocalOperatorRequest,
} from "@/lib/self-improvement-data.mjs";

export async function POST(request: Request) {
  const validation = validateLocalOperatorRequest(request);
  if (!validation.ok) {
    return Response.json(localOperatorDeniedPayload(validation.reason), { status: validation.status ?? 403 });
  }

  try {
    const sessionPath = findSessionFile();
    const sessionsData = sessionPath ? readJsonFile(sessionPath, { messages: [] }) : { messages: [] };
    const items = buildCouncilItemsFromUsage(sessionsData);
    const allItems = appendCouncilItems(items);
    upsertLedgerProposed(items);

    return Response.json({
      success: true,
      items,
      total: items.length,
      stored_total: allItems.length,
      source: sessionPath,
      message: "Proactive analysis complete",
    });
  } catch (error) {
    return Response.json(
      {
        success: false,
        message: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
