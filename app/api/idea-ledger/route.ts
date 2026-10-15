import {
  IDEA_LEDGER_PATH,
  localOperatorDeniedPayload,
  readJsonFile,
  validateLocalOperatorRequest,
  writeJsonFile,
} from "@/lib/self-improvement-data.mjs";

const LEDGER_TYPES = new Set(["proposed", "adopted", "rejected", "dormant"]);

function localOnly(request: Request) {
  const validation = validateLocalOperatorRequest(request);
  if (validation.ok) return null;
  return Response.json(localOperatorDeniedPayload(validation.reason), { status: validation.status ?? 403 });
}

function defaultLedger() {
  return {
    proposed: [],
    adopted: [],
    rejected: [],
    dormant: [],
  };
}

export async function GET(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;

  try {
    const data = readJsonFile(IDEA_LEDGER_PATH, defaultLedger());

    return Response.json({
      success: true,
      ...data,
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

export async function POST(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;

  try {
    const body = await request.json();
    const { type, idea } = body;
    if (!LEDGER_TYPES.has(type)) {
      return Response.json(
        {
          success: false,
          message: `Invalid type: ${type}`,
        },
        { status: 400 }
      );
    }
    if (!idea || typeof idea !== "object") {
      return Response.json(
        {
          success: false,
          message: "idea object is required",
        },
        { status: 400 }
      );
    }

    const data = readJsonFile(IDEA_LEDGER_PATH, defaultLedger());
    const ideaWithTimestamp = { ...idea, added_at: new Date().toISOString() };

    data[type].push(ideaWithTimestamp);
    writeJsonFile(IDEA_LEDGER_PATH, data);

    return Response.json({
      success: true,
      message: `Idea added to ${type} list`,
      idea: ideaWithTimestamp,
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

export async function DELETE(request: Request) {
  const denied = localOnly(request);
  if (denied) return denied;

  try {
    const body = await request.json();
    const { type, id } = body;
    if (!LEDGER_TYPES.has(type)) {
      return Response.json(
        {
          success: false,
          message: `Invalid type: ${type}`,
        },
        { status: 400 }
      );
    }

    const data = readJsonFile(IDEA_LEDGER_PATH, defaultLedger());
    data[type] = data[type].filter((item: any) => item.id !== id);
    writeJsonFile(IDEA_LEDGER_PATH, data);

    return Response.json({
      success: true,
      message: `Idea removed from ${type} list`,
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
