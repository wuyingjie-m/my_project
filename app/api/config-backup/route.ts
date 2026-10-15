import { NextResponse, NextRequest } from "next/server";
import {
  listBackupFiles,
  restoreFromBackup,
  getBackupDir,
} from "@/lib/config-backup";

/**
 * GET /api/config-backup
 * 列出所有可用的 openclaw.json 備份
 */
export async function GET() {
  try {
    const backups = listBackupFiles();
    return NextResponse.json({
      backupDir: getBackupDir(),
      backups,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/config-backup
 * 從指定備份還原 openclaw.json
 *
 * Request body: { filename: "openclaw.2026-03-15T08-30-00.json" }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { filename } = body;

    if (!filename || typeof filename !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid 'filename' in request body" },
        { status: 400 }
      );
    }

    const result = restoreFromBackup(filename);

    if (!result.success) {
      return NextResponse.json(
        { error: result.message },
        { status: 400 }
      );
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
}
