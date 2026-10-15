import { NextResponse } from "next/server";
import { execFile, exec, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const LAUNCHCTL = "/bin/launchctl";
const PLIST = path.join(os.homedir(), "Library/LaunchAgents/ai.openclaw.gateway.plist");

const EXTRA_PATH = `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;

/** Kill any running gateway process by name */
async function killGatewayProcess(): Promise<void> {
  try {
    const { stdout } = await execAsync("pgrep -f 'openclaw.gateway\\|openclaw-gateway'");
    const pids = stdout.trim().split("\n").filter(Boolean);
    if (pids.length > 0) {
      await execAsync(`kill ${pids.join(" ")}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch { /* no process running — ok */ }
}

/** Find openclaw binary in PATH */
async function findOpenclawBin(): Promise<string> {
  try {
    const { stdout } = await execAsync("which openclaw", { env: { ...process.env, PATH: EXTRA_PATH } });
    return stdout.trim();
  } catch {
    return "openclaw";
  }
}

export async function POST() {
  try {
    const hasPlist = fs.existsSync(PLIST);

    if (hasPlist) {
      // Plist exists — use launchctl to reload (works whether currently loaded or not)
      try { await execFileAsync(LAUNCHCTL, ["unload", PLIST]); } catch { /* ignore if already unloaded */ }
      await new Promise((r) => setTimeout(r, 500));
      await execFileAsync(LAUNCHCTL, ["load", PLIST]);
    } else {
      // No plist — kill and restart directly
      await killGatewayProcess();
      const bin = await findOpenclawBin();
      const child = spawn(bin, ["gateway"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, PATH: EXTRA_PATH },
      });
      child.unref();
    }

    return NextResponse.json({ ok: true, method: hasPlist ? "launchd" : "direct" });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
